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

function fakeDb(rows: { primary?: string[]; derived?: string[] } = {}): {
  db: Db;
  calls: FindManyArgs[];
} {
  const calls: FindManyArgs[] = [];
  const db = {
    ingestJob: {
      findMany: async (args: FindManyArgs) => {
        calls.push(args);
        const pool = args.where.kind.notIn ? (rows.primary ?? []) : (rows.derived ?? []);
        return pool.slice(0, args.take).map((dedupeKey) => ({ dedupeKey }));
      },
    },
  };
  return { db: db as unknown as Db, calls };
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

  it('leaves a busy queue alone without touching the database', async () => {
    const { db, calls } = fakeDb({ primary: ['ingest_tile:a'] });
    const queue = fakeQueue(PUMP_LOW_WATER);

    expect(await runPump(db, queue, silent)).toEqual({ published: 0 });
    expect(calls).toEqual([]);
    expect(queue.published).toEqual([]);
  });

  it('publishes nothing when there is no runnable work', async () => {
    const queue = fakeQueue(0);

    expect(await runPump(fakeDb().db, queue, silent)).toEqual({ published: 0 });
    expect(queue.published).toEqual([]);
  });
});
