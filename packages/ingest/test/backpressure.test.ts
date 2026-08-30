/**
 * Admission control, exercised through `queueTiles`/`queueNetworkTiles` rather than
 * `requestArea` — those are the choke point every writing path crosses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  DERIVED_JOB_KINDS,
  DERIVED_QUEUE_WARN_DEPTH,
  MAX_QUEUE_WAIT_HOURS,
  MAX_STORAGE_FRACTION,
  MAX_TILE_QUEUE_DEPTH,
  REQUEST_JOB_KINDS,
  admitIngest,
  resetStorageCache,
} from '../src/backpressure';
import { MAX_AREA_TILES, ensureCoverage, queueTiles } from '../src/coverage';
import { REVIVAL_OUTSTANDING_MAX } from '../src/dead-jobs';
import { REQUEST_DRAIN_TILES_PER_HOUR, hoursToDrain, queueDepthForHours } from '../src/drain-rate';
import { BUCKET_CAPACITY, PRINCIPAL_QUEUE_SHARE } from '../src/rate-limit';
import { ensureNetworkCoverage, queueNetworkTiles } from '../src/network';

/** A bbox small enough to need exactly one tile at either zoom. */
const ONE_TILE: [number, number, number, number] = [-4.08, 53.06, -4.07, 53.07];

/** The single z9 quadkey `ONE_TILE` covers. */
const ONE_TILE_KEY = '031311230';

/** The z12 quadkeys `ONE_TILE` covers — routing tiles are finer, so there are two. */
const ROUTING_KEYS = ['031311230201', '031311230203'];

/** A ceiling to measure fractions against, since there is no default any more. */
const LIMIT = 512 * 1024 * 1024;

interface GroupByCall {
  kind?: { in: JobKind[] };
  status?: { in: JobStatus[] };
}

interface Recorded {
  tileUpserts: number;
  routingUpserts: number;
  jobUpserts: number;
  groupBys: GroupByCall[];
}

interface FakeOptions {
  /** How many *request* jobs are outstanding — what `MAX_TILE_QUEUE_DEPTH` counts. */
  depth?: number;
  /** How many *derived* jobs are outstanding — the drain's own fan-out. */
  derived?: number;
  /** Bytes `pg_database_size` reports. Omit for a client that has no `$queryRaw` at all. */
  databaseBytes?: number;
  /** Quadkeys whose `ingest_tile` job is already queued or running. */
  inFlight?: readonly string[];
  /** Quadkeys whose `ingest_network` job is already queued or running. */
  networkInFlight?: readonly string[];
}

function fakeDb(options: FakeOptions = {}): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { tileUpserts: 0, routingUpserts: 0, jobUpserts: 0, groupBys: [] };

  const base = {
    ingestTile: {
      findMany: () => Promise.resolve([]),
      upsert: () => {
        recorded.tileUpserts += 1;
        return Promise.resolve({});
      },
    },
    routingTile: {
      findMany: () => Promise.resolve([]),
      upsert: () => {
        recorded.routingUpserts += 1;
        return Promise.resolve({});
      },
    },
    ingestJob: {
      // Both kinds come back from one stub because each caller filters on its own key prefix,
      // so the extra rows are invisible to whichever one is asking.
      findMany: () =>
        Promise.resolve([
          ...(options.inFlight ?? []).map((quadkey) => ({
            dedupeKey: `${JobKind.ingest_tile}:${quadkey}`,
          })),
          ...(options.networkInFlight ?? []).map((quadkey) => ({
            dedupeKey: `${JobKind.ingest_network}:${quadkey}`,
          })),
        ]),
      groupBy: ({ where }: { where: GroupByCall }) => {
        recorded.groupBys.push(where);
        return Promise.resolve([
          { kind: JobKind.ingest_tile, _count: { _all: options.depth ?? 0 } },
          { kind: JobKind.enrich_trail, _count: { _all: options.derived ?? 0 } },
        ]);
      },
      updateMany: () => Promise.resolve({ count: 0 }),
      upsert: () => {
        recorded.jobUpserts += 1;
        return Promise.resolve({ id: 'job' });
      },
    },
  };

  const bytes = options.databaseBytes;
  const db =
    bytes === undefined
      ? base
      : { ...base, $queryRaw: () => Promise.resolve([{ bytes: BigInt(bytes) }]) };

  return { db: db as unknown as PrismaClient, recorded };
}

beforeEach(() => {
  resetStorageCache();
  delete process.env.DATABASE_SIZE_LIMIT_BYTES;
});

afterEach(() => {
  resetStorageCache();
  delete process.env.DATABASE_SIZE_LIMIT_BYTES;
  vi.restoreAllMocks();
});

describe('queue depth', () => {
  it('refuses at the ceiling, writing nothing at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH });

    const { queued, refused } = await queueTiles(db, ['0213012']);

    expect(queued).toEqual([]);
    expect(refused).toBe('queue-depth');
    // A tile row with no job behind it is what `ensureCoverage` reads as "queued and coming".
    expect(recorded.tileUpserts).toBe(0);
    expect(recorded.jobUpserts).toBe(0);
  });

  it('queues one job short of the ceiling', async () => {
    const { db, recorded } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH - 1 });

    const { queued, refused } = await queueTiles(db, ['0213012']);

    expect(queued).toEqual(['0213012']);
    expect(refused).toBeNull();
    expect(recorded.tileUpserts).toBe(1);
    expect(recorded.jobUpserts).toBe(1);
  });

  it('counts the routing queue toward the same ceiling', async () => {
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['0213012']);

    const kinds = recorded.groupBys[0]?.kind?.in ?? [];
    expect(kinds).toContain(JobKind.ingest_tile);
    expect(kinds).toContain(JobKind.refresh_tile);
    expect(kinds).toContain(JobKind.ingest_network);
    // Only work still in flight counts. A finished job occupies no queue.
    expect(recorded.groupBys[0]?.status?.in).toEqual([JobStatus.queued, JobStatus.running]);
  });

  it('counts what the drain enqueues, not only what a request enqueues', async () => {
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['0213012']);

    const kinds = recorded.groupBys[0]?.kind?.in ?? [];
    expect(kinds).toContain(JobKind.enrich_trail);
    expect(kinds).toContain(JobKind.ingest_route);
  });

  it('never refuses on the derived backlog, however deep it gets', async () => {
    // A hundred times the mark and it still admits. If somebody re-adds a derived ceiling this
    // fails, which is the point: the next one has to come with a drain that can empty it.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({ depth: 0, derived: DERIVED_QUEUE_WARN_DEPTH * 100 });

    expect(await admitIngest(db)).toBeNull();
    expect((await queueTiles(db, ['0213012'])).queued).toEqual(['0213012']);
    expect(recorded.jobUpserts).toBe(1);
  });

  it('says the derived backlog out loud without calling it a refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: 0, derived: DERIVED_QUEUE_WARN_DEPTH + 11 });

    await admitIngest(db);

    // Found by content, not position: the storage guard logs its own line from the same call.
    const line = String(
      warn.mock.calls.find((call) => String(call[0]).includes('derived jobs'))?.[0],
    );
    expect(line).toContain(String(DERIVED_QUEUE_WARN_DEPTH + 11));
    expect(line).not.toContain('refused');
  });

  it('does not judge a derived backlog against the request ceiling', async () => {
    const { db } = fakeDb({ depth: 0, derived: MAX_TILE_QUEUE_DEPTH * 9 });

    expect(await admitIngest(db)).toBeNull();
  });

  it('keeps the two ceilings on separate kind sets', () => {
    // Overlap would count one backlog twice.
    const overlap = REQUEST_JOB_KINDS.filter((kind) =>
      (DERIVED_JOB_KINDS as readonly JobKind[]).includes(kind),
    );
    expect(overlap).toEqual([]);
  });

  it('refuses the routing queue at the ceiling too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH });

    const { queued } = await queueNetworkTiles(db, ['021301']);

    expect(queued).toEqual([]);
    expect(recorded.routingUpserts).toBe(0);
    expect(recorded.jobUpserts).toBe(0);
  });

  it('asks nothing of the database when there is nothing to queue', async () => {
    const { db, recorded } = fakeDb();

    expect((await queueTiles(db, [])).queued).toEqual([]);
    expect((await queueNetworkTiles(db, [])).queued).toEqual([]);
    // A warm viewport must stay free: no depth count, no size read, no writes.
    expect(recorded.groupBys).toHaveLength(0);
  });

  /**
   * The limit the module concedes rather than closes, pinned so it stays conceded: tRPC
   * resolves a batch concurrently and admission is unlocked, so every call reads the same
   * pre-write depth. Making admission atomic fails this test, which is the point.
   */
  it('admits concurrent callers against the same pre-write depth', async () => {
    const { db, recorded } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH - 1 });

    const results = await Promise.all([
      queueTiles(db, ['0213010']),
      queueTiles(db, ['0213011']),
      queueTiles(db, ['0213012']),
    ]);

    expect(results.every((result) => result.refused === null)).toBe(true);
    expect(recorded.jobUpserts).toBe(3);
  });
});

describe('storage headroom', () => {
  it('has no opinion at all when no ceiling is configured', async () => {
    // A ceiling nobody set is not evidence of a full disk.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({ databaseBytes: LIMIT });

    expect(await admitIngest(db)).toBeNull();
    expect((await queueTiles(db, ['0213012'])).queued).toEqual(['0213012']);
    expect(recorded.jobUpserts).toBe(1);
  });

  it('says once that the guard is switched off', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ databaseBytes: LIMIT });

    await admitIngest(db);
    await admitIngest(db);

    const offLines = warn.mock.calls.filter((call) =>
      String(call[0]).includes('DATABASE_SIZE_LIMIT_BYTES'),
    );
    expect(offLines).toHaveLength(1);
  });

  /**
   * `.env.example` prints the ceiling in prose beside the raw integers, so a unit suffix is
   * the likeliest thing anyone types and `Number()` rejects every one of them.
   */
  it.each(['64GiB', '32 GB', '34,359,738,368', '10_737_418_240', '0', '-1'])(
    'calls %s invalid rather than unset',
    async (raw) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env.DATABASE_SIZE_LIMIT_BYTES = raw;
      const { db } = fakeDb({ databaseBytes: LIMIT });

      // Still admits: an unparseable value is not evidence of a full disk. Only the sentence
      // differs from the unset case.
      expect(await admitIngest(db)).toBeNull();

      const line = String(
        warn.mock.calls.find((call) => String(call[0]).includes('DATABASE_SIZE_LIMIT_BYTES'))?.[0],
      );
      expect(line).toContain(raw);
      expect(line).not.toContain('unset');
    },
  );

  it('says so when the size probe itself fails', async () => {
    // Failing open is right; failing open in silence is the state an operator cannot diagnose.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.DATABASE_SIZE_LIMIT_BYTES = String(LIMIT);
    const { db } = fakeDb();

    expect(await admitIngest(db)).toBeNull();
    expect(await admitIngest(db)).toBeNull();

    const probeLines = warn.mock.calls.filter((call) =>
      String(call[0]).includes('pg_database_size'),
    );
    // Said, and said once — this runs behind every viewport.
    expect(probeLines).toHaveLength(1);
  });

  it('refuses new ingest above the headroom ceiling once configured', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.DATABASE_SIZE_LIMIT_BYTES = String(LIMIT);
    const { db, recorded } = fakeDb({ databaseBytes: Math.ceil(LIMIT * 0.9) });

    expect((await queueTiles(db, ['0213012'])).refused).toBe('storage');
    expect(recorded.jobUpserts).toBe(0);
  });

  it('lets ingest through below it', async () => {
    process.env.DATABASE_SIZE_LIMIT_BYTES = String(LIMIT);
    const { db, recorded } = fakeDb({ databaseBytes: Math.floor(LIMIT * 0.5) });

    expect((await queueTiles(db, ['0213012'])).queued).toEqual(['0213012']);
    expect(recorded.jobUpserts).toBe(1);
  });

  it('trips exactly at the fraction, not a byte before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.DATABASE_SIZE_LIMIT_BYTES = String(LIMIT);
    const { db } = fakeDb({ databaseBytes: Math.ceil(LIMIT * MAX_STORAGE_FRACTION) });

    expect(await admitIngest(db)).toBe('storage');
  });

  it('reads the size once and then trusts it for a minute', async () => {
    process.env.DATABASE_SIZE_LIMIT_BYTES = String(LIMIT);
    const { db } = fakeDb({ databaseBytes: Math.floor(LIMIT * 0.5) });
    const spy = vi.spyOn(db, '$queryRaw');

    await admitIngest(db, 1_000);
    await admitIngest(db, 30_000);

    // Why the cache exists: this runs in front of `trails.browse`, so an uncached read would
    // put a round trip behind every pan of every map.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lets ingest through when it cannot read the size at all', async () => {
    // A broken instrument is not a full disk; the depth guard is the one that has to hold.
    process.env.DATABASE_SIZE_LIMIT_BYTES = String(LIMIT);
    const { db, recorded } = fakeDb();

    expect((await queueTiles(db, ['0213012'])).queued).toEqual(['0213012']);
    expect(recorded.jobUpserts).toBe(1);
  });
});

describe('what the reader is told', () => {
  it('stops claiming tiles are pending once ingest is refused', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH });

    const coverage = await ensureCoverage(ONE_TILE, { principal: null, db });

    expect(coverage.busy).toBe(true);
    expect(coverage.queued).toEqual([]);
    // `pending` is what makes the client poll, so leaving refused tiles in it would give a
    // database under enough pressure to refuse ingest a poll storm from every open map.
    expect(coverage.pending).toEqual([]);
  });

  it('keeps polling for tiles that are already on their way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH, inFlight: [ONE_TILE_KEY] });

    const coverage = await ensureCoverage(ONE_TILE, { principal: null, db });

    // The one tile this bbox covers is already queued, so there is no new ground to refuse.
    expect(coverage.busy).toBe(false);
    expect(coverage.pending).toEqual([ONE_TILE_KEY]);
  });

  it('still admits new ground beside tiles that are already coming', async () => {
    // The in-flight tile is enqueued anyway: it costs no row and it is what raises a
    // background refresh's priority when somebody starts looking at it.
    const { db, recorded } = fakeDb({ inFlight: [ONE_TILE_KEY] });

    const coverage = await ensureCoverage(ONE_TILE, { principal: null, db });

    expect(coverage.busy).toBe(false);
    expect(coverage.queued).toEqual([ONE_TILE_KEY]);
    expect(recorded.jobUpserts).toBe(1);
  });

  it('carries which refusal it was, not just that there was one', async () => {
    // "Try again in a few minutes" is true of a queue and false of a full database.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.DATABASE_SIZE_LIMIT_BYTES = String(LIMIT);
    const { db } = fakeDb({ databaseBytes: Math.ceil(LIMIT * 0.95) });

    const coverage = await ensureCoverage(ONE_TILE, { principal: null, db });

    expect(coverage.busy).toBe(true);
    expect(coverage.busyReason).toBe('storage');
  });

  it('keeps the routing queue honest about what is outstanding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH });

    const coverage = await ensureNetworkCoverage(ONE_TILE, { principal: null, db });

    expect(coverage.busy).toBe(true);
    // Unlike the trail side, `pending` stays: the planner uses it as the only tiebreaker
    // between "still downloading" and "no path exists".
    expect(coverage.pending).not.toEqual([]);
  });

  it('does not refuse routing tiles that are already on their way', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({
      depth: MAX_TILE_QUEUE_DEPTH,
      networkInFlight: ROUTING_KEYS,
    });

    const coverage = await ensureNetworkCoverage(ONE_TILE, { principal: null, db });

    expect(coverage.busy).toBe(false);
    expect(coverage.busyReason).toBeNull();
    expect(coverage.queued).toEqual(ROUTING_KEYS);
    // Enqueued over all of them, not just the new ground: the upsert writes no row for an
    // existing job but does raise its priority.
    expect(recorded.jobUpserts).toBe(ROUTING_KEYS.length);
  });

  it('still refuses the routing tiles nothing is coming for', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({
      depth: MAX_TILE_QUEUE_DEPTH,
      networkInFlight: [ROUTING_KEYS[0]!],
    });

    const coverage = await ensureNetworkCoverage(ONE_TILE, { principal: null, db });

    expect(coverage.busy).toBe(true);
    expect(coverage.busyReason).toBe('queue-depth');
    expect(coverage.queued).toEqual([]);
    expect(recorded.jobUpserts).toBe(0);
  });

  it('is not busy when there was simply nothing to do', async () => {
    const { db } = fakeDb();
    // A survey-only call queues nothing by request, which must not read as a refusal.
    const coverage = await ensureNetworkCoverage(ONE_TILE, { principal: null, db, queue: false });

    expect(coverage.busy).toBe(false);
  });

  it('leaves an operator a line to grep for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH + 5 });

    await queueTiles(db, ['0213012']);

    // The number it tripped on, not just the fact that it tripped.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(MAX_TILE_QUEUE_DEPTH + 5)));
  });

  it('tells that operator what the depth costs, not only what it is', async () => {
    /*
     * This line is the only place the ceiling is visible in production — nothing is persisted on a
     * refusal and no alert covers it, so `scripts/ingest-metrics/README.md` sends operators here
     * with a grep. A bare count is the reading that was misjudged for 21 hours in the first place.
     */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const depth = MAX_TILE_QUEUE_DEPTH + 5;
    const { db } = fakeDb({ depth });

    await queueTiles(db, ['0213012']);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${hoursToDrain(depth).toFixed(1)} h of drain`),
    );
  });
});

/** The other wall on `MAX_QUEUE_WAIT_HOURS`: past this a fetch is for the next visitor. */
const HOURS_IN_A_DAY = 24;

/** `MAX_AREA_TILES` distinct z9 quadkeys — one press of "fetch this area". */
function areaFetchKeys(): string[] {
  return Array.from(
    { length: MAX_AREA_TILES },
    (_, index) => `02${index.toString(4).padStart(7, '0')}`,
  );
}

describe('what the ceiling is worth in hours', () => {
  it('refuses at the depth the wait horizon buys, and not one job sooner', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Recomputed from the two inputs rather than read off the constant: this is the assertion that
    // goes red if the rate is re-measured and the ceiling is left where it was, which is the drift
    // that let a 21-hour backlog be documented as an hour.
    const atHorizon = Math.floor(REQUEST_DRAIN_TILES_PER_HOUR * MAX_QUEUE_WAIT_HOURS);

    expect(await admitIngest(fakeDb({ depth: atHorizon }).db)).toBe('queue-depth');
    expect(await admitIngest(fakeDb({ depth: atHorizon - 1 }).db)).toBeNull();
  });

  it('admits no tile into a longer wait than the horizon promises', async () => {
    const { db } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH - 1 });

    const { queued } = await queueTiles(db, ['0213012']);

    // The last tile the ceiling lets through is the one that waits longest, so its wait is the
    // whole promise. Asserted on the depth admission actually produced, not on the constant.
    expect(queued).toHaveLength(1);
    expect(hoursToDrain(MAX_TILE_QUEUE_DEPTH - 1 + queued.length)).toBeLessThanOrEqual(
      MAX_QUEUE_WAIT_HOURS,
    );
  });

  it('stays deep enough that a caller share still covers one deliberate area fetch', () => {
    // Below this the allowance in `rate-limit.ts` is `MIN_BUCKET_CAPACITY` clamping *above* its own
    // share of this ceiling, and one press of "fetch this area" would pin the product-wide ceiling
    // for everybody. A shorter horizon needs a smaller `MAX_AREA_TILES` first.
    expect(MAX_TILE_QUEUE_DEPTH * PRINCIPAL_QUEUE_SHARE).toBeGreaterThanOrEqual(MAX_AREA_TILES);
  });

  it('never refuses a viewport on revived work alone, whatever the ceiling is retuned to', async () => {
    // Revival at its whole bound, with a full area fetch arriving on top of it.
    const { db } = fakeDb({ depth: REVIVAL_OUTSTANDING_MAX });

    const { queued, refused } = await queueTiles(db, areaFetchKeys());

    expect(refused).toBeNull();
    expect(queued).toHaveLength(MAX_AREA_TILES);
  });

  it('keeps recovery smaller than a single ordinary caller may hold', () => {
    /*
     * The assertion above passes for any share below 1.0 — revival at half the ceiling still
     * admits one more tile — so it cannot see a share raised tenfold. This can: revival is
     * recovery, not a tenant, and a burial that may take more of the queue than one ordinary
     * caller is allowed to hold is an outage wearing another name. See `REVIVAL_QUEUE_SHARE`.
     */
    expect(REVIVAL_OUTSTANDING_MAX).toBeLessThanOrEqual(BUCKET_CAPACITY);
  });

  it('promises no wait longer than a day, whatever the horizon is set to', () => {
    // The floor is `MAX_AREA_TILES`; this is the other wall. Past a day the fetch is certainly for
    // the next visitor rather than the one who asked, and nothing here can tell them it arrived —
    // so admitting it is the lie the ceiling exists to avoid, just slower.
    expect(MAX_QUEUE_WAIT_HOURS).toBeLessThanOrEqual(HOURS_IN_A_DAY);
    expect(hoursToDrain(MAX_TILE_QUEUE_DEPTH)).toBeLessThanOrEqual(HOURS_IN_A_DAY);
  });

  it('takes the longest horizon the floor and the day both allow', () => {
    /*
     * More than one whole hour clears both walls, so which one this is cannot be derived — but the
     * *rule* can be, and this is it. Pinning the rule rather than the number keeps it true through
     * a re-measurement: change the drain rate and the admissible set moves, and the constant has to
     * move to the top of it. Recomputed here from the same two bounds the code argues from.
     */
    const admissible = Array.from({ length: HOURS_IN_A_DAY }, (_, index) => index + 1).filter(
      (hours) => queueDepthForHours(hours) >= MAX_AREA_TILES / PRINCIPAL_QUEUE_SHARE,
    );

    expect(admissible.length).toBeGreaterThan(1);
    expect(Math.max(...admissible)).toBe(MAX_QUEUE_WAIT_HOURS);
  });
});
