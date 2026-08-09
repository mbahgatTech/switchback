/**
 * The pump keeps the queue a few messages deep so that `priority DESC` stays in Postgres.
 * These cover the arithmetic and the two selects; the broker itself is faked.
 */

import { describe, expect, it } from 'vitest';
import { JobKind, JobStatus } from '@switchback/db';
import type { Db } from '@switchback/ingest';
import type { WorkerLog } from '../src/log';
import {
  PUMP_DERIVED_SHARE,
  PUMP_LOW_WATER,
  PUMP_QUEUE_DEPTH,
  planPump,
  runPump,
} from '../src/pump';
import type { SignalQueue } from '../src/pump';

interface KindFilter {
  in?: JobKind[];
  notIn?: JobKind[];
}

interface FindManyArgs {
  where: { status: JobStatus; runAfter: { lte: Date }; kind: KindFilter };
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
 * Why a lost wake-up needs no alarm of its own. `publishIngestSignals` swallows a broker failure
 * and logs `PUBLISH_FAILED_MARKER` on Vercel, where no Azure rule can read it; that is only
 * defensible while the pump re-derives the work from `ingest_jobs` regardless.
 */
describe('recovery from a wake-up that never reached the broker', () => {
  it('selects on the row alone, so a failed publish cannot make a job unreachable', async () => {
    const { db, calls } = fakeDb({ primary: ['ingest_tile:never-signalled'] });
    const queue = fakeQueue(0);

    await runPump(db, queue, silent);

    /*
     * The predicate is `status` and `runAfter` and nothing else. A column recording whether a
     * signal was ever sent — or a successful publish being what moves the row on — would make a
     * dropped message permanent, which is the failure this queue has no second path to catch.
     */
    const primary = calls[0];
    expect(Object.keys(primary?.where ?? {}).sort()).toEqual(['kind', 'runAfter', 'status']);
    expect(primary?.where.status).toBe(JobStatus.queued);
    expect(queue.published).toEqual(['ingest_tile:never-signalled']);
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
});
