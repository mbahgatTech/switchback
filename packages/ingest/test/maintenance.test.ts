import { describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus, TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { reconcileOrphanedSplits } from '../src/subdivide';
import { createThrottledSweep, isDistressed, queueHealth } from '../src/maintenance';
import type { QueueHealth } from '../src/maintenance';

/** A tile row as the sweep reads it. */
interface TileRow {
  quadkey: string;
  status: TileStatus;
  lastError: string | null;
}

interface Recorded {
  updates: Array<{ quadkey: string; data: Record<string, unknown> }>;
  enqueued: string[];
}

/** The subset of a Prisma `where` the sweep and `childTiles` actually build. */
interface TileWhere {
  lastError?: { startsWith?: string; contains?: string };
  quadkey?: { in?: string[] };
  status?: JobStatus;
  lockedAt?: { lt?: Date };
}

/**
 * A Prisma stand-in over `ingest_tiles` and `ingest_jobs`, covering exactly the calls the sweep
 * makes. `childTiles` reads by `quadkey: { in: [...] }` and the marker sweep by `startsWith`, so
 * the fake serves both off one array.
 */
function fakeDb(tiles: TileRow[]): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { updates: [], enqueued: [] };

  const db = {
    ingestTile: {
      findMany: async ({ where, take }: { where: TileWhere; take?: number }) => {
        const prefix = where.lastError?.startsWith;
        const wanted = where.quadkey?.in;
        const matched = tiles.filter((tile) =>
          prefix !== undefined
            ? (tile.lastError ?? '').startsWith(prefix)
            : (wanted ?? []).includes(tile.quadkey),
        );
        return take === undefined ? matched : matched.slice(0, take);
      },
      update: async ({
        where,
        data,
      }: {
        where: { quadkey: string };
        data: Record<string, unknown>;
      }) => {
        recorded.updates.push({ quadkey: where.quadkey, data });
        const row = tiles.find((tile) => tile.quadkey === where.quadkey)!;
        if ('status' in data) row.status = data.status as TileStatus;
        if ('lastError' in data) row.lastError = data.lastError as string | null;
        return row;
      },
    },
    ingestJob: {
      updateMany: async () => ({ count: 0 }),
      upsert: async ({ create }: { create: { dedupeKey: string } }) => {
        recorded.enqueued.push(create.dedupeKey);
        return create;
      },
    },
  } as unknown as PrismaClient;

  return { db, recorded };
}

const parent = (quadkey: string, status: TileStatus, lastError: string | null): TileRow => ({
  quadkey,
  status,
  lastError,
});

describe('a split marker on a parent with no children', () => {
  const MARKER = 'split into 4 tiles at z10';

  it('is cleared, and the parent is queued again', async () => {
    const { db, recorded } = fakeDb([parent('120230202', TileStatus.running, MARKER)]);

    const repaired = await reconcileOrphanedSplits(db);

    expect(repaired).toEqual([{ quadkey: '120230202', status: TileStatus.pending }]);
    expect(recorded.updates).toEqual([
      { quadkey: '120230202', data: { status: TileStatus.pending, lastError: null } },
    ]);
    expect(recorded.enqueued).toEqual([`${JobKind.ingest_tile}:120230202`]);
  });

  it('leaves a parent that is still serving trails on the status it is serving them under', async () => {
    const { db, recorded } = fakeDb([parent('031313112', TileStatus.ready, MARKER)]);

    await reconcileOrphanedSplits(db);

    // Only these two columns. `trailCount`, `fetchedAt` and `fetchMs` are the tile's data and
    // are never in the write — a reader keeps the trails they had.
    expect(recorded.updates[0]?.data).toEqual({ status: TileStatus.ready, lastError: null });
  });

  it('is a no-op the second time', async () => {
    const { db, recorded } = fakeDb([parent('120230203', TileStatus.pending, MARKER)]);

    await reconcileOrphanedSplits(db);
    const repaired = await reconcileOrphanedSplits(db);

    expect(repaired).toEqual([]);
    expect(recorded.updates).toHaveLength(1);
  });
});

describe('a split marker on a parent that really was subdivided', () => {
  it('is left alone', async () => {
    const children = ['1202302020', '1202302021', '1202302022', '1202302023'];
    const { db, recorded } = fakeDb([
      parent('120230202', TileStatus.pending, 'split into 4 tiles at z10'),
      ...children.map((child) => parent(child, TileStatus.ready, null)),
    ]);

    expect(await reconcileOrphanedSplits(db)).toEqual([]);
    expect(recorded.updates).toEqual([]);
    expect(recorded.enqueued).toEqual([]);
  });
});

describe('the throttled sweep', () => {
  const at = (iso: string) => new Date(iso);
  const noop = () => vi.fn(async () => ({ requeued: 0, retired: 0, unsplit: [] }));

  it('runs the first time it is asked', () => {
    const run = noop();
    const sweep = createThrottledSweep(run, 900_000);

    expect(sweep(at('2026-08-07T10:00:00Z'))).not.toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('declines inside the window, so a busy process does not sweep on every request', () => {
    const run = noop();
    const sweep = createThrottledSweep(run, 900_000);

    void sweep(at('2026-08-07T10:00:00Z'));
    expect(sweep(at('2026-08-07T10:14:59Z'))).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs again once the window has passed', () => {
    const run = noop();
    const sweep = createThrottledSweep(run, 900_000);

    void sweep(at('2026-08-07T10:00:00Z'));
    void sweep(at('2026-08-07T10:15:00Z'));
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('the queue health report', () => {
  function countingDb(counts: number[]): PrismaClient {
    let call = 0;
    const next = async () => counts[call++] ?? 0;
    return {
      ingestJob: { count: next },
      ingestTile: { count: next },
    } as unknown as PrismaClient;
  }

  it('reads the five conditions the drainer leaves behind', async () => {
    const health = await queueHealth(countingDb([17, 10, 3, 6, 1]));

    expect(health).toEqual({
      dead: 17,
      staleLeases: 10,
      rateLimited: 3,
      orphanedSplits: 6,
      stuckSubtrees: 1,
    });
  });

  it('counts a lease as stale only once it is past the lease timeout', async () => {
    const now = new Date('2026-08-07T10:44:00Z');
    const seen: TileWhere[] = [];
    const db = {
      ingestJob: {
        count: async (args: { where: TileWhere }) => {
          seen.push(args.where);
          return 0;
        },
      },
      ingestTile: { count: async () => 0 },
    } as unknown as PrismaClient;

    await queueHealth(db, now, 30 * 60_000);

    const stale = seen.find((where) => where.status === JobStatus.running);
    expect(stale?.lockedAt?.lt).toEqual(new Date('2026-08-07T10:14:00Z'));
  });

  it('is silent when nothing is wrong', () => {
    const clean: QueueHealth = {
      dead: 0,
      staleLeases: 0,
      rateLimited: 0,
      orphanedSplits: 0,
      stuckSubtrees: 0,
    };
    expect(isDistressed(clean)).toBe(false);
    expect(isDistressed({ ...clean, rateLimited: 1 })).toBe(true);
  });
});
