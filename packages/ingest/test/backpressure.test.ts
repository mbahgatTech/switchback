/**
 * The one guard that is about strangers rather than about us.
 *
 * These tests exist because the version they replace passed while the door was open. It
 * checked `requestArea` — the path behind a button somebody presses — and asserted that a
 * deep queue refused it. Both assertions were true, and the two paths that queue without
 * anybody pressing anything went round the guard entirely.
 *
 * So the subject here is not `requestArea`. It is `queueTiles` and `queueNetworkTiles`, the
 * choke point every writing path crosses. What is pinned: at each ceiling they refuse,
 * below it they queue, the routing queue counts toward the same ceiling as the trail queue,
 * the drain's own fan-out is counted too rather than growing unwatched beside it, an
 * unconfigured storage ceiling has no opinion, and a refusal reaches the reader as the
 * reason it actually was.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  DERIVED_JOB_KINDS,
  MAX_DERIVED_QUEUE_DEPTH,
  MAX_STORAGE_FRACTION,
  MAX_TILE_QUEUE_DEPTH,
  REQUEST_JOB_KINDS,
  admitIngest,
  resetStorageCache,
} from '../src/backpressure';
import { ensureCoverage, queueTiles } from '../src/coverage';
import { ensureNetworkCoverage, queueNetworkTiles } from '../src/network';

/** A bbox small enough to need exactly one tile at either zoom. */
const ONE_TILE: [number, number, number, number] = [-4.08, 53.06, -4.07, 53.07];

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
      findMany: () => Promise.resolve([]),
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
    // Both writes are refused, not just the job. A tile row with no job behind it is the
    // state `ensureCoverage` treats as "queued and coming", which would be a lie.
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

    // The bug this pins: the old guard counted `ingest_tile` only, so `ingest_network` could
    // grow without bound beside it.
    const kinds = recorded.groupBys[0]?.kind?.in ?? [];
    expect(kinds).toContain(JobKind.ingest_tile);
    expect(kinds).toContain(JobKind.refresh_tile);
    expect(kinds).toContain(JobKind.ingest_network);
    // Only work still in flight counts. A finished job occupies no queue.
    expect(recorded.groupBys[0]?.status?.in).toEqual([JobStatus.queued, JobStatus.running]);
  });

  it('counts what the drain enqueues, not only what a request enqueues', async () => {
    // The same shape of bug one layer down: `enrich_trail` and `ingest_route` are fan-out
    // from an admitted tile, and leaving them out meant the guard watched 74 jobs while
    // 5,317 uncounted writes queued behind them on production.
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['0213012']);

    const kinds = recorded.groupBys[0]?.kind?.in ?? [];
    expect(kinds).toContain(JobKind.enrich_trail);
    expect(kinds).toContain(JobKind.ingest_route);
  });

  it('refuses on the derived ceiling with the request queue empty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: 0, derived: MAX_DERIVED_QUEUE_DEPTH });

    expect(await admitIngest(db)).toBe('queue-depth');
  });

  it('does not judge a derived backlog against the request ceiling', async () => {
    // Sharing one ceiling would have refused every ingest in production on deploy: the
    // derived backlog there is 5,317 against a request ceiling of 600.
    const { db } = fakeDb({ depth: 0, derived: MAX_TILE_QUEUE_DEPTH * 9 });

    expect(await admitIngest(db)).toBeNull();
  });

  it('keeps the two ceilings on separate kind sets', () => {
    // Overlap would count one backlog twice and make the arithmetic in both docstrings wrong.
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
   * The limit the module concedes rather than closes, pinned so it stays conceded.
   *
   * tRPC resolves a batch concurrently, so every call in one request reaches `admitIngest`
   * before any of them has written a row. There is no transaction and no advisory lock, so
   * they all read the same pre-write depth and all pass. If somebody later makes admission
   * atomic this test fails, which is the point — the docstring's claim and the behaviour
   * have to move together.
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
    // The blocker this replaced: a hard-coded 512 MB guess, with production already at
    // 483,172,352 bytes — 90.0% — which refused every enqueue in the product, permanently,
    // because nothing reclaims a row. A ceiling nobody set is not evidence of a full disk.
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

    // The reason the cache exists: this runs in front of `trails.browse`, so an uncached
    // read would put a round trip behind every pan of every map in the product.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('lets ingest through when it cannot read the size at all', async () => {
    // A broken instrument is not a full disk. The depth guard is the one that has to hold,
    // and a size probe that throws must not be able to stop the map filling.
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

    const coverage = await ensureCoverage(ONE_TILE, { db });

    expect(coverage.busy).toBe(true);
    expect(coverage.queued).toEqual([]);
    /*
     * `pendingTiles` is what makes the client poll every few seconds, so leaving these in it
     * would mean a database under enough pressure to refuse ingest also getting a poll storm
     * from every open map, for tiles that are never going to arrive.
     */
    expect(coverage.pending).toEqual([]);
  });

  it('carries which refusal it was, not just that there was one', async () => {
    // "Try again in a few minutes" is true of a queue and false of a full database, so the
    // note cannot say it until it knows which one happened.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.DATABASE_SIZE_LIMIT_BYTES = String(LIMIT);
    const { db } = fakeDb({ databaseBytes: Math.ceil(LIMIT * 0.95) });

    const coverage = await ensureCoverage(ONE_TILE, { db });

    expect(coverage.busy).toBe(true);
    expect(coverage.busyReason).toBe('storage');
  });

  it('keeps the routing queue honest about what is outstanding', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH });

    const coverage = await ensureNetworkCoverage(ONE_TILE, { db });

    expect(coverage.busy).toBe(true);
    /*
     * Unlike the trail side, `pending` stays. The planner used it as the only tiebreaker
     * between "still downloading" and "no path exists", so zeroing it made a refused fetch
     * come out the far end as a claim about the terrain. `busy` is what the planner reads
     * now, and this pins that `pending` is no longer laundered through.
     */
    expect(coverage.pending).not.toEqual([]);
  });

  it('is not busy when there was simply nothing to do', async () => {
    const { db } = fakeDb();
    // A survey-only call queues nothing by request, which must not read as a refusal.
    const coverage = await ensureNetworkCoverage(ONE_TILE, { db, queue: false });

    expect(coverage.busy).toBe(false);
  });

  it('leaves an operator a line to grep for', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH + 5 });

    await queueTiles(db, ['0213012']);

    // The number it tripped on, not just the fact that it tripped — otherwise the log says
    // the guard fired and nothing about whether it fired correctly.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(String(MAX_TILE_QUEUE_DEPTH + 5)));
  });
});
