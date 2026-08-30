/**
 * The pump keeps the queue a few messages deep so that `priority DESC` stays in Postgres.
 * These cover the arithmetic and the two selects; the broker itself is faked.
 */

import { describe, expect, it } from 'vitest';
import { JobKind, JobStatus } from '@switchback/db';
import { RECLAIM_PRIORITY, VIEWPORT_PRIORITY } from '@switchback/ingest';
import type { Db } from '@switchback/ingest';
import type { WorkerLog } from '../src/log';
import { PUMP_MESSAGES_FOR_DERIVED, PUMP_MESSAGES_PER_REFILL } from '@switchback/ingest';
import {
  PUMP_DERIVED_SHARE,
  PUMP_LOW_WATER,
  PUMP_QUEUE_DEPTH,
  planPump,
  pumpBounds,
  runPump,
} from '../src/pump';
import type { SignalQueue } from '../src/pump';

interface KindFilter {
  in?: JobKind[];
  notIn?: JobKind[];
}

type OrderBy = ReadonlyArray<Record<string, 'asc' | 'desc'>>;

interface FindManyArgs {
  where: {
    status: JobStatus;
    runAfter: { lte: Date };
    kind: KindFilter;
    priority?: { gte: number };
  };
  orderBy: OrderBy;
  take: number;
}

const silent: WorkerLog = { info: () => {}, warn: () => {}, error: () => {} };

function fakeDb(rows: { primary?: string[]; derived?: string[]; reclaimed?: JobStatus[] } = {}): {
  db: Db;
  calls: FindManyArgs[];
  sweeps: number;
} {
  const calls: FindManyArgs[] = [];
  const state = { sweeps: 0 };
  const db = {
    ingestJob: {
      findMany: async (args: FindManyArgs) => {
        calls.push(args);
        const pool = args.where.kind.notIn ? (rows.primary ?? []) : (rows.derived ?? []);
        return pool.slice(0, args.take).map((dedupeKey) => ({ dedupeKey }));
      },
    },
    // What `reclaimExpiredJobs` runs: one statement returning the new status per row.
    $queryRaw: async () => {
      state.sweeps += 1;
      return (rows.reclaimed ?? []).map((status) => ({ status }));
    },
  };
  return {
    db: db as unknown as Db,
    calls,
    get sweeps() {
      return state.sweeps;
    },
  };
}

function fakeQueue(active: number): SignalQueue & { published: string[]; counted: number } {
  const state = {
    published: [] as string[],
    counted: 0,
    activeCount: async () => {
      state.counted += 1;
      return active;
    },
    publish: async (keys: readonly string[]) => void state.published.push(...keys),
  };
  return state;
}

interface JobRow {
  dedupeKey: string;
  priority: number;
  runAfter: Date;
}

/** The key of the tile whose wake-up never reached the broker. */
const LOST_DOORBELL = 'ingest_tile:never-signalled';

const QUEUED_AT = new Date('2026-08-08T12:00:00.000Z');

function compare(orderBy: OrderBy, left: JobRow, right: JobRow): number {
  for (const term of orderBy) {
    const [field, direction] = Object.entries(term)[0]!;
    const a = left[field as keyof JobRow];
    const b = right[field as keyof JobRow];
    const delta = a < b ? -1 : a > b ? 1 : 0;
    if (delta !== 0) return direction === 'asc' ? delta : -delta;
  }
  return 0;
}

/**
 * A `findMany` that applies the `orderBy` it is given before taking, so a row's position in the
 * backlog decides whether the pump reaches it. `fakeDb` slices from the head of an array and
 * cannot see ordering at all, which is why it can hold no opinion on reachability.
 *
 * `reclaims` names the row the sweep frees. `$queryRaw` here *is* `reclaimExpiredJobs`, so it
 * applies that statement's effect — raising the row to `RECLAIM_PRIORITY` — to the same rows the
 * selects read. Sharing the row set is what puts the sweep's position inside `runPump` under test:
 * move it after the selects and the elevation lands too late to be published.
 */
function backlogged(rows: readonly JobRow[], reclaims?: string): Db {
  let current = [...rows];
  const due = (args: FindManyArgs, row: JobRow): boolean =>
    row.runAfter <= args.where.runAfter.lte &&
    (args.where.priority === undefined || row.priority >= args.where.priority.gte);
  return {
    ingestJob: {
      findMany: async (args: FindManyArgs) =>
        (args.where.kind.in ? [] : current.filter((row) => due(args, row)))
          .slice()
          .sort((a, b) => compare(args.orderBy, a, b))
          .slice(0, args.take)
          .map(({ dedupeKey }) => ({ dedupeKey })),
    },
    $queryRaw: async () => {
      if (reclaims === undefined) return [];
      current = current.map((row) =>
        row.dedupeKey === reclaims ? { ...row, priority: RECLAIM_PRIORITY } : row,
      );
      return [{ status: JobStatus.queued }];
    },
  } as unknown as Db;
}

/**
 * `depth` tiles already due at `VIEWPORT_PRIORITY`, and behind them the one somebody is waiting
 * on. Every viewport tile carries that same priority, so a freshly queued tile is the newest
 * `runAfter` of its band — the tail of the pump's order, not the head.
 */
function withBacklog(depth: number): JobRow[] {
  const backlog = Array.from({ length: depth }, (_, index) => ({
    dedupeKey: `ingest_tile:backlog-${index}`,
    priority: VIEWPORT_PRIORITY,
    runAfter: new Date(QUEUED_AT.getTime() - (depth - index) * 60_000),
  }));
  return [
    ...backlog,
    { dedupeKey: LOST_DOORBELL, priority: VIEWPORT_PRIORITY, runAfter: QUEUED_AT },
  ];
}

describe('planPump', () => {
  it('does nothing while the worker still has messages to chew on', () => {
    expect(planPump(PUMP_LOW_WATER)).toEqual({ primary: 0, derived: 0 });
    expect(planPump(PUMP_LOW_WATER + 10)).toEqual({ primary: 0, derived: 0 });
  });

  it('refills to the target depth, reserving the derived share', () => {
    expect(planPump(0)).toEqual({
      primary: PUMP_QUEUE_DEPTH - PUMP_DERIVED_SHARE,
      derived: PUMP_DERIVED_SHARE,
    });
  });

  it('counts what is already in flight against the depth', () => {
    const plan = planPump(PUMP_LOW_WATER - 1);
    expect(plan.primary + plan.derived).toBe(PUMP_QUEUE_DEPTH - (PUMP_LOW_WATER - 1));
    expect(plan.derived).toBe(PUMP_DERIVED_SHARE);
  });
});

describe('runPump', () => {
  it('publishes the top of the queue, request work first', async () => {
    const { db } = fakeDb({ primary: ['ingest_tile:a', 'ingest_tile:b'], derived: ['enrich:c'] });
    const queue = fakeQueue(0);

    const result = await runPump(db, queue, silent);

    expect(result.published).toBe(3);
    expect(queue.published).toEqual(['ingest_tile:a', 'ingest_tile:b', 'enrich:c']);
  });

  it('splits the two claims the way drainJobs does, over runnable rows only', async () => {
    const { db, calls } = fakeDb({ primary: ['ingest_tile:a'] });
    const now = new Date('2026-08-02T00:00:00.000Z');

    await runPump(db, fakeQueue(0), silent, now);

    // Disjoint by kind, so the derived reservation is a reservation rather than a duplicate of
    // rows the priority order already reached.
    const [primary, derived] = calls;
    expect(primary?.where.kind.notIn).toEqual([JobKind.enrich_trail, JobKind.ingest_route]);
    expect(derived?.where.kind.in).toEqual([JobKind.enrich_trail, JobKind.ingest_route]);
    expect(primary?.where).toMatchObject({ status: JobStatus.queued, runAfter: { lte: now } });
    expect(derived?.take).toBe(PUMP_DERIVED_SHARE);
  });

  it('publishes no new signals while the worker still has messages to chew on', async () => {
    const fake = fakeDb({ primary: ['ingest_tile:a'] });
    const queue = fakeQueue(PUMP_LOW_WATER);

    expect(await runPump(fake.db, queue, silent)).toEqual({ published: 0 });
    expect(fake.calls).toEqual([]);
    expect(queue.published).toEqual([]);
  });

  it('reclaims expired leases even on the ticks when it publishes nothing', async () => {
    // The lease of an invocation the host killed at `functionTimeout` is recovered here, not
    // only by the daily cron — and a busy queue is exactly when a stuck lease is likeliest,
    // so an early return before the sweep would strand the tile for a day.
    const busy = fakeDb({ primary: ['ingest_tile:a'], reclaimed: [JobStatus.queued] });
    await runPump(busy.db, fakeQueue(PUMP_LOW_WATER), silent);
    expect(busy.sweeps).toBe(1);

    const idle = fakeDb();
    await runPump(idle.db, fakeQueue(0), silent);
    expect(idle.sweeps).toBe(1);
  });

  it('publishes nothing when there is no runnable work', async () => {
    const queue = fakeQueue(0);

    expect(await runPump(fakeDb().db, queue, silent)).toEqual({ published: 0 });
    expect(queue.published).toEqual([]);
  });
});

/**
 * How far a lost wake-up gets without one. The pump publishes from the head of `priority DESC,
 * "runAfter" ASC`, so what it recovers is the head of the queue and not a particular row.
 */
describe('a wake-up that never reached the broker', () => {
  it('selects on the row alone, so no publish outcome is what moves a job on', async () => {
    const { db, calls } = fakeDb({ primary: [LOST_DOORBELL] });
    const queue = fakeQueue(0);

    await runPump(db, queue, silent);

    /*
     * The predicate is `status` and `runAfter` and nothing else. A column recording whether a
     * signal was ever sent — or a successful publish being what moves the row on — would make a
     * dropped message permanent rather than late.
     */
    const primary = calls[0];
    expect(Object.keys(primary?.where ?? {}).sort()).toEqual(['kind', 'runAfter', 'status']);
    expect(primary?.where.status).toBe(JobStatus.queued);
    expect(queue.published).toEqual([LOST_DOORBELL]);
  });

  it('republishes the same key on the next tick, because publishing claims nothing', async () => {
    const rows = { primary: ['ingest_tile:a'] };
    const first = fakeQueue(0);
    const second = fakeQueue(0);

    // Two ticks against a row no worker has claimed: the pump must name it both times, or a
    // message lost between them is lost for good.
    await runPump(fakeDb(rows).db, first, silent);
    await runPump(fakeDb(rows).db, second, silent);

    expect(first.published).toEqual(['ingest_tile:a']);
    expect(second.published).toEqual(['ingest_tile:a']);
  });

  it('reaches the tile on the next tick when nothing of its priority is due ahead of it', async () => {
    const queue = fakeQueue(0);

    await runPump(backlogged(withBacklog(0)), queue, silent, QUEUED_AT);

    expect(queue.published).toEqual([LOST_DOORBELL]);
  });

  it('does not reach it behind a backlog of its own priority', async () => {
    const queue = fakeQueue(0);

    await runPump(backlogged(withBacklog(40)), queue, silent, QUEUED_AT);

    /*
     * The tick is spent on the oldest rows of the same band, so recovery is bounded by the
     * backlog draining rather than by the two-minute cadence. The reading `DRAIN_SILENCE_MS` is
     * sized against is 44,884 due `queued` rows, oldest since 2026-07-30, against a window of
     * `PUMP_QUEUE_DEPTH - PUMP_DERIVED_SHARE` rows a tick.
     */
    expect(queue.published).not.toContain(LOST_DOORBELL);
    expect(queue.published).toHaveLength(PUMP_QUEUE_DEPTH - PUMP_DERIVED_SHARE);
    expect(queue.published[0]).toBe('ingest_tile:backlog-0');
  });

  it('reaches it once its priority is raised above the backlog', async () => {
    const rows = withBacklog(40).map((row) =>
      row.dedupeKey === LOST_DOORBELL ? { ...row, priority: VIEWPORT_PRIORITY + 1 } : row,
    );
    const queue = fakeQueue(0);

    // `priority DESC` leads the order, so raising the row is the one lever that moves a named
    // tile to the head — the same column `claimJobs` reads.
    await runPump(backlogged(rows), queue, silent, QUEUED_AT);

    expect(queue.published[0]).toBe(LOST_DOORBELL);
  });
});

/**
 * The bound `classifyDisposition` completes a Service Bus message on. Completing is irreversible,
 * so a killed handler's tile has to be reachable from the row alone — and reachable in a tick,
 * not when a five-figure backlog drains.
 */
describe('a lease the reaper took back', () => {
  it('is published on the tick that reclaimed it, from behind a full backlog', async () => {
    const queue = fakeQueue(0);

    await runPump(backlogged(withBacklog(40), LOST_DOORBELL), queue, silent, QUEUED_AT);

    // The same fixture the case above proves unreachable, differing only in that the sweep ran.
    // `runPump` sweeps before it selects, so the elevated row is at the head of this tick's order.
    expect(queue.published[0]).toBe(LOST_DOORBELL);
  });

  it('does not outrank a backlog that shares its own elevated priority', async () => {
    const rows = withBacklog(40).map((row) => ({ ...row, priority: RECLAIM_PRIORITY }));
    const queue = fakeQueue(0);

    // The elevation is a band, not a queue jump: reclaimed rows sort among themselves by
    // `runAfter`, oldest first, rather than each new one climbing above the last.
    await runPump(backlogged(rows, LOST_DOORBELL), queue, silent, QUEUED_AT);

    expect(queue.published).not.toContain(LOST_DOORBELL);
    expect(queue.published[0]).toBe('ingest_tile:backlog-0');
  });
});

/**
 * `ingestPump` passes `RECLAIM_PRIORITY` here while `INGEST_PUMP_ENABLED=false`. Completing a
 * message is irreversible and is justified by the reclaim reaching the broker, so the brake has to
 * narrow the pump rather than silence it.
 */
describe('a braked pump', () => {
  it('still publishes a lease the sweep reclaimed', async () => {
    const queue = fakeQueue(0);

    await runPump(
      backlogged(withBacklog(40), LOST_DOORBELL),
      queue,
      silent,
      QUEUED_AT,
      pumpBounds(),
      RECLAIM_PRIORITY,
    );

    expect(queue.published).toEqual([LOST_DOORBELL]);
  });

  it('publishes nothing else', async () => {
    const queue = fakeQueue(0);

    // The same backlog with no reclaim: every row sits at `VIEWPORT_PRIORITY`, which the band
    // excludes, so a brake admits no new work.
    await runPump(
      backlogged(withBacklog(40)),
      queue,
      silent,
      QUEUED_AT,
      pumpBounds(),
      RECLAIM_PRIORITY,
    );

    expect(queue.published).toEqual([]);
  });

  it('is the only thing that narrows the selects', async () => {
    const { db, calls } = fakeDb({ primary: ['ingest_tile:a'] });

    await runPump(db, fakeQueue(0), silent);

    // Unbraked the predicate carries no priority term at all, so an ordinary tick still reads the
    // whole runnable head.
    expect(calls[0]?.where.priority).toBeUndefined();
  });
});

describe('the refill shape packages/ingest has to assume', () => {
  it('matches what drain-rate.ts sizes the request-kind rate from', () => {
    /*
     * `REQUEST_DRAIN_TILES_PER_HOUR` divides the measured rate by the share of messages carrying a
     * request kind, and `packages/ingest` cannot import this app to read that share. This test can
     * see both, so it is where the restatement is held — change the pump and the ceiling follows,
     * or this reds.
     */
    expect(PUMP_MESSAGES_PER_REFILL).toBe(PUMP_QUEUE_DEPTH);
    expect(PUMP_MESSAGES_FOR_DERIVED).toBe(PUMP_DERIVED_SHARE);
  });
});
