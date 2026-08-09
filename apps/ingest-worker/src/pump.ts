/**
 * Refills the queue from `ingest_jobs` rather than migrating into it. Service Bus is FIFO and
 * has no priority; keeping it a few messages deep is what leaves the ordering in Postgres.
 */

import { JobStatus } from '@switchback/db';
import { DERIVED_JOB_KINDS, reclaimExpiredJobs } from '@switchback/ingest';
import type { Db } from '@switchback/ingest';
import type { WorkerLog } from './log';

/**
 * How many messages the pump will leave in flight.
 *
 * Not a work-time budget — that reading does not survive measurement. Over the 50 `ingestDrain`
 * invocations of 2026-08-08 the distribution is bimodal: a median of 2.1 s for the ones that find
 * nothing claimable, a mean of 126.2 s and a p90 of 540.1 s for the ones that drain a tile. At
 * `maxConcurrentCalls: 1` a queue eight deep is therefore ~15 minutes of work at the mean and over
 * an hour at p90, which is past `defaultMessageTimeToLive`.
 *
 * Eight is a *wake-up* depth, and it is safe at that dwell because the queue holds no state: a
 * message that expires is deleted silently, its `ingest_jobs` row is still `queued`, and the next
 * tick republishes it. What the depth actually buys is that the queue never runs dry between ticks;
 * what `PUMP_LOW_WATER` buys is that a backlog of duplicates cannot build up behind a slow tile.
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

export interface PumpBounds {
  depth: number;
  lowWater: number;
}

/**
 * Bounds from `INGEST_PUMP_MAX_DEPTH` / `INGEST_PUMP_LOW_WATER`, which `ingest.bicep` sets. Read
 * here rather than defaulted in place so changing either in the portal actually changes the pump;
 * a non-numeric or absent value falls back to the constant above.
 */
export function pumpBounds(source: NodeJS.ProcessEnv = process.env): PumpBounds {
  const read = (name: string, fallback: number): number => {
    const value = Number(source[name]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    depth: read('INGEST_PUMP_MAX_DEPTH', PUMP_QUEUE_DEPTH),
    lowWater: read('INGEST_PUMP_LOW_WATER', PUMP_LOW_WATER),
  };
}

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
 * disagree. Nothing here is claimed or written: a row stays `queued` until a worker takes it, so
 * a lost message costs a row its position and never the row. How long that position takes to
 * reach the head is the backlog's business, not this tick's.
 */
export async function runPump(
  db: Db,
  queue: SignalQueue,
  log: WorkerLog,
  now = new Date(),
  bounds: PumpBounds = pumpBounds(),
): Promise<{ published: number }> {
  /*
   * Before the selects, not after, and the ordering is load-bearing: the sweep raises a reclaimed
   * row to `RECLAIM_PRIORITY`, so the tick that takes a lease back is the tick that republishes
   * the row rather than the one after it. It also stops the pump re-signalling a row whose killed
   * holder still nominally owns the lease. Cheap — one UPDATE over an indexed predicate.
   */
  const reclaimed = await reclaimExpiredJobs(db, now);
  if (reclaimed.requeued > 0 || reclaimed.retired > 0) {
    log.warn(
      `ingest pump: reclaimed ${reclaimed.requeued} expired lease(s), retired ${reclaimed.retired}`,
    );
  }

  const active = await queue.activeCount();
  const plan = planPump(active, bounds.depth, bounds.lowWater);
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
