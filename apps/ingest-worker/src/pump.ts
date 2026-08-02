/**
 * Refills the queue from `ingest_jobs` rather than migrating into it. Service Bus is FIFO and
 * has no priority; keeping it a few messages deep is what leaves the ordering in Postgres.
 */

import { JobStatus } from '@switchback/db';
import { DERIVED_JOB_KINDS } from '@switchback/ingest';
import type { Db } from '@switchback/ingest';
import type { WorkerLog } from './log';

/**
 * How many messages the pump will leave in flight. One worker takes them at ~10-30 s each, so
 * eight is under three minutes of work — long enough that the queue never runs dry between
 * ticks, short enough that a tile someone is looking at is not stuck behind a day of backlog.
 */
export const PUMP_QUEUE_DEPTH = 8;

/** Above this many active messages the pump does nothing: the worker is not short of work. */
export const PUMP_LOW_WATER = 4;

/**
 * Messages reserved for derived work each refill. `claimJobs` orders by `priority DESC` and
 * `enrich_trail`/`ingest_route` are enqueued at -10, so without a reservation they are never
 * reached. Mirrors `DEFAULT_DERIVED_SHARE`, which the per-message drain gives up.
 */
export const PUMP_DERIVED_SHARE = 2;

export interface PumpPlan {
  primary: number;
  derived: number;
}

/** What to publish this tick, given how much is already in flight. */
export function planPump(
  activeMessageCount: number,
  depth = PUMP_QUEUE_DEPTH,
  lowWater = PUMP_LOW_WATER,
  derivedShare = PUMP_DERIVED_SHARE,
): PumpPlan {
  if (activeMessageCount >= lowWater) return { primary: 0, derived: 0 };

  const capacity = Math.max(depth - activeMessageCount, 0);
  const derived = Math.min(derivedShare, capacity);
  return { primary: capacity - derived, derived };
}

/** The broker, behind an interface, so the planning and reporting below need no namespace. */
export interface SignalQueue {
  activeCount(): Promise<number>;
  publish(dedupeKeys: readonly string[]): Promise<void>;
}

/**
 * Read the top of the queue and publish a wake-up signal for each row.
 *
 * The two selects are the two arms of `drainJobs`, in the same order and with the same
 * predicate, so what the pump considers most important and what a worker then claims cannot
 * disagree. Nothing here is claimed or written: a row stays `queued` until a worker takes it,
 * which is why a lost message costs a wait rather than a job.
 */
export async function runPump(
  db: Db,
  queue: SignalQueue,
  log: WorkerLog,
  now = new Date(),
): Promise<{ published: number }> {
  const active = await queue.activeCount();
  const plan = planPump(active);
  if (plan.primary === 0 && plan.derived === 0) return { published: 0 };

  const runnable = { status: JobStatus.queued, runAfter: { lte: now } };
  const order = [{ priority: 'desc' as const }, { runAfter: 'asc' as const }];
  const derivedKinds = [...DERIVED_JOB_KINDS];

  const [primary, derived] = await Promise.all([
    db.ingestJob.findMany({
      where: { ...runnable, kind: { notIn: derivedKinds } },
      orderBy: order,
      select: { dedupeKey: true },
      take: plan.primary,
    }),
    db.ingestJob.findMany({
      where: { ...runnable, kind: { in: derivedKinds } },
      orderBy: order,
      select: { dedupeKey: true },
      take: plan.derived,
    }),
  ]);

  const keys = [...primary, ...derived].map((row) => row.dedupeKey);
  if (keys.length === 0) return { published: 0 };

  await queue.publish(keys);
  log.info(`ingest pump: published ${keys.length} signal(s) over ${active} active message(s)`);
  return { published: keys.length };
}
