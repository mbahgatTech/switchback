import { describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus, TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { reconcileOrphanedSplits } from '../src/subdivide';
import { LEASE_TIMEOUT_MS } from '../src/jobs';
import { createThrottledSweep, isDistressed, queueHealth, sweepQueue } from '../src/maintenance';
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
  /** Bind values of every `$queryRaw` — the reclaim's, in `[now, reason, cutoff]` order. */
  rawBinds: unknown[][];
}

/** The subset of a Prisma `where` the sweep and `childTiles` actually build. */
interface TileWhere {
  lastError?: { startsWith?: string; contains?: string };
  quadkey?: { in?: string[] };
  status?: JobStatus;
  lockedAt?: { lt?: Date };
  completedAt?: { gte?: Date };
  OR?: Array<Record<string, unknown>>;
}

/**
 * A Prisma stand-in over `ingest_tiles` and `ingest_jobs`, covering exactly the calls the sweep
 * makes. `childTiles` reads by `quadkey: { in: [...] }` and the marker sweep by `startsWith`, so
 * the fake serves both off one array. `$queryRaw` is the reclaim's single statement; `expired` is
 * what it returns, one element per lease it took back.
 */
function fakeDb(
  tiles: TileRow[],
  expired: ReadonlyArray<{ status: JobStatus }> = [],
): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { updates: [], enqueued: [], rawBinds: [] };

  const db = {
    $queryRaw: async (_strings: TemplateStringsArray, ...binds: unknown[]) => {
      recorded.rawBinds.push(binds);
      return [...expired];
    },
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

/**
 * `sweepQueue` is the *only* production entry point for either repair — the cron route calls it
 * unconditionally, `trails.kickIngest` calls it ahead of its own early return, and nothing else
 * calls `reconcileOrphanedSplits` or `reclaimExpiredJobs` off a path that drains nothing. Testing
 * the two halves in isolation leaves the call that makes them real untested: unhook either one and
 * every other case here stays green while production silently re-wedges.
 */
describe('the sweep both live entry points call', () => {
  const MARKER = 'split into 4 tiles at z10';
  const NOW = new Date('2026-08-07T10:44:00Z');

  it('clears an orphaned split marker and puts the parent back on the queue', async () => {
    const { db, recorded } = fakeDb([parent('120230220', TileStatus.running, MARKER)]);

    const result = await sweepQueue(db, NOW);

    expect(result.unsplit).toEqual([{ quadkey: '120230220', status: TileStatus.pending }]);
    expect(recorded.updates).toEqual([
      { quadkey: '120230220', data: { status: TileStatus.pending, lastError: null } },
    ]);
    expect(recorded.enqueued).toEqual([`${JobKind.ingest_tile}:120230220`]);
  });

  it('takes back leases expired against the sweep’s own clock', async () => {
    const { db, recorded } = fakeDb(
      [],
      [{ status: JobStatus.queued }, { status: JobStatus.queued }, { status: JobStatus.dead }],
    );

    const result = await sweepQueue(db, NOW);

    expect(result).toMatchObject({ requeued: 2, retired: 1 });
    // The cutoff the reclaim bound, not merely that something ran: `now` has to reach it, or a
    // sweep would take back leases measured from some other moment.
    const [, , cutoff] = recorded.rawBinds[0] ?? [];
    expect(cutoff).toEqual(new Date(NOW.getTime() - LEASE_TIMEOUT_MS));
  });

  it('still does each half when the other throws, because neither is worth a failed tick', async () => {
    const { db, recorded } = fakeDb([parent('031313112', TileStatus.pending, MARKER)]);
    const broken = { ...db, $queryRaw: () => Promise.reject(new Error('lease sweep exploded')) };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sweepQueue(broken as unknown as PrismaClient, NOW);

    expect(result).toMatchObject({ requeued: 0, retired: 0 });
    expect(result.unsplit).toHaveLength(1);
    expect(recorded.enqueued).toEqual([`${JobKind.ingest_tile}:031313112`]);
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
  function countingDb(reading: QueueHealth): PrismaClient {
    // The three job counts are read in declaration order: dead, stale leases, rate limited.
    const jobs = [reading.dead, reading.staleLeases, reading.rateLimited];
    let call = 0;
    return {
      ingestJob: { count: async () => jobs[call++] ?? 0 },
      ingestTile: { count: async () => reading.stuckSubtrees },
      $queryRaw: async () => [{ count: reading.orphanedSplits }],
    } as unknown as PrismaClient;
  }

  const reading: QueueHealth = {
    dead: 17,
    staleLeases: 10,
    rateLimited: 3,
    orphanedSplits: 6,
    stuckSubtrees: 1,
  };

  it('reads the five conditions the drainer leaves behind', async () => {
    expect(await queueHealth(countingDb(reading))).toEqual(reading);
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
      $queryRaw: async () => [{ count: 0 }],
    } as unknown as PrismaClient;

    await queueHealth(db, now, 30 * 60_000);

    const stale = seen.find((where) => where.status === JobStatus.running);
    expect(stale?.lockedAt?.lt).toEqual(new Date('2026-08-07T10:14:00Z'));
  });

  /**
   * A gauge that cannot return to zero is not a gauge. `failJob` buries a job as `dead` on
   * purpose and `pruneFinishedJobs` keeps it for thirty days, so an unwindowed count reads
   * production's seventeen for a month and the alert can never clear — which is the same as
   * having no alert, on the one signal (a 429) it exists to raise.
   */
  it('counts only what happened recently, so a resolved queue can read clean', async () => {
    const now = new Date('2026-08-07T10:00:00Z');
    const since = new Date('2026-08-07T09:00:00Z');
    const seen: TileWhere[] = [];
    const db = {
      ingestJob: {
        count: async (args: { where: TileWhere }) => {
          seen.push(args.where);
          return 0;
        },
      },
      ingestTile: { count: async () => 0 },
      $queryRaw: async () => [{ count: 0 }],
    } as unknown as PrismaClient;

    await queueHealth(db, now);

    const dead = seen.find((where) => where.status === JobStatus.dead);
    expect(dead?.completedAt?.gte).toEqual(since);

    const limited = seen.find((where) => where.lastError?.contains === '429');
    expect(limited?.OR).toEqual([{ completedAt: null }, { completedAt: { gte: since } }]);
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
