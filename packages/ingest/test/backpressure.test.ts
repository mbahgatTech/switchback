/**
 * The one guard that is about strangers rather than about us.
 *
 * These tests exist because the version they replace passed while the door was open. It
 * checked `requestArea` — the path behind a button somebody presses — and asserted that a
 * deep queue refused it. Both assertions were true, and the two paths that queue without
 * anybody pressing anything went round the guard entirely.
 *
 * So the subject here is not `requestArea`. It is `queueTiles` and `queueNetworkTiles`, the
 * choke point every writing path crosses, and the three things worth pinning about them:
 * at the ceiling they refuse, below it they queue, and the routing queue counts toward the
 * same ceiling as the trail queue rather than having one of its own.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  DEFAULT_DATABASE_LIMIT_BYTES,
  MAX_STORAGE_FRACTION,
  MAX_TILE_QUEUE_DEPTH,
  admitIngest,
  resetStorageCache,
} from '../src/backpressure';
import { ensureCoverage, queueTiles } from '../src/coverage';
import { ensureNetworkCoverage, queueNetworkTiles } from '../src/network';

/** A bbox small enough to need exactly one tile at either zoom. */
const ONE_TILE: [number, number, number, number] = [-4.08, 53.06, -4.07, 53.07];

interface CountCall {
  kind?: { in: JobKind[] };
  status?: { in: JobStatus[] };
}

interface Recorded {
  tileUpserts: number;
  routingUpserts: number;
  jobUpserts: number;
  counts: CountCall[];
}

interface FakeOptions {
  /** What `ingestJob.count` answers — the depth guard's input. */
  depth?: number;
  /** Bytes `pg_database_size` reports. Omit for a client that has no `$queryRaw` at all. */
  databaseBytes?: number;
}

function fakeDb(options: FakeOptions = {}): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { tileUpserts: 0, routingUpserts: 0, jobUpserts: 0, counts: [] };

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
      count: ({ where }: { where: CountCall }) => {
        recorded.counts.push(where);
        return Promise.resolve(options.depth ?? 0);
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

afterEach(() => {
  resetStorageCache();
  vi.restoreAllMocks();
});

describe('queue depth', () => {
  it('refuses at the ceiling, writing nothing at all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH });

    const queued = await queueTiles(db, ['0213012']);

    expect(queued).toEqual([]);
    // Both writes are refused, not just the job. A tile row with no job behind it is the
    // state `ensureCoverage` treats as "queued and coming", which would be a lie.
    expect(recorded.tileUpserts).toBe(0);
    expect(recorded.jobUpserts).toBe(0);
  });

  it('queues one job short of the ceiling', async () => {
    const { db, recorded } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH - 1 });

    const queued = await queueTiles(db, ['0213012']);

    expect(queued).toEqual(['0213012']);
    expect(recorded.tileUpserts).toBe(1);
    expect(recorded.jobUpserts).toBe(1);
  });

  it('counts the routing queue toward the same ceiling', async () => {
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['0213012']);

    // The bug this pins: the old guard counted `ingest_tile` only, so `ingest_network` could
    // grow without bound beside it. One ceiling, all three kinds that fetch new ground.
    const kinds = recorded.counts[0]?.kind?.in ?? [];
    expect(kinds).toContain(JobKind.ingest_tile);
    expect(kinds).toContain(JobKind.refresh_tile);
    expect(kinds).toContain(JobKind.ingest_network);
    // Only work still in flight counts. A finished job occupies no queue.
    expect(recorded.counts[0]?.status?.in).toEqual([JobStatus.queued, JobStatus.running]);
  });

  it('refuses the routing queue at the ceiling too', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH });

    const queued = await queueNetworkTiles(db, ['021301']);

    expect(queued).toEqual([]);
    expect(recorded.routingUpserts).toBe(0);
    expect(recorded.jobUpserts).toBe(0);
  });

  it('asks nothing of the database when there is nothing to queue', async () => {
    const { db, recorded } = fakeDb();

    expect(await queueTiles(db, [])).toEqual([]);
    expect(await queueNetworkTiles(db, [])).toEqual([]);
    // A warm viewport must stay free: no depth count, no size read, no writes.
    expect(recorded.counts).toHaveLength(0);
  });
});

describe('storage headroom', () => {
  const limit = DEFAULT_DATABASE_LIMIT_BYTES;

  it('refuses new ingest above the headroom ceiling', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb({ databaseBytes: Math.ceil(limit * 0.9) });

    expect(await queueTiles(db, ['0213012'])).toEqual([]);
    expect(recorded.jobUpserts).toBe(0);
  });

  it('lets ingest through below it', async () => {
    const { db, recorded } = fakeDb({ databaseBytes: Math.floor(limit * 0.5) });

    expect(await queueTiles(db, ['0213012'])).toEqual(['0213012']);
    expect(recorded.jobUpserts).toBe(1);
  });

  it('trips exactly at the fraction, not a byte before', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ databaseBytes: Math.ceil(limit * MAX_STORAGE_FRACTION) });

    expect(await admitIngest(db)).toBe('storage');
  });

  it('reads the size once and then trusts it for a minute', async () => {
    const { db } = fakeDb({ databaseBytes: Math.floor(limit * 0.5) });
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
    const { db, recorded } = fakeDb();

    expect(await queueTiles(db, ['0213012'])).toEqual(['0213012']);
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

  it('says the same about the routing queue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db } = fakeDb({ depth: MAX_TILE_QUEUE_DEPTH });

    const coverage = await ensureNetworkCoverage(ONE_TILE, { db });

    expect(coverage.busy).toBe(true);
    expect(coverage.pending).toEqual([]);
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
