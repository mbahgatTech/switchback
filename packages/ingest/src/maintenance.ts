/**
 * Queue maintenance that has to happen whether or not anything is being drained.
 *
 * Both sweeps below used to run only inside `drainJobs`, which is a side effect of traffic on
 * cold ground plus a once-a-day cron. That is not a schedule: on 2026-08-07 the cron claimed ten
 * jobs at 04:51 UTC, its invocation died on Vercel's 60 s wall clock still holding them, and the
 * next thing able to take the leases back was the following day's cron — 5.9 h and counting
 * against a 30-minute lease.
 */

import { JobStatus, prisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { LEASE_TIMEOUT_MS, reclaimExpiredJobs } from './jobs';
import { SUBTREE_STUCK_MARKER, countOrphanedSplits, reconcileOrphanedSplits } from './subdivide';
import type { OrphanedSplitRepair } from './subdivide';

/**
 * How often one process will run the sweep off the back of a request. Half a lease, so an expired
 * one is never more than `LEASE_TIMEOUT_MS * 1.5` old while anything at all is being served, and
 * two indexed statements per fifteen minutes per process is a cost that does not show up.
 */
export const SWEEP_INTERVAL_MS = LEASE_TIMEOUT_MS / 2;

export interface SweepResult {
  /** Expired leases returned to the queue. */
  requeued: number;
  /** Expired leases buried, out of attempts. */
  retired: number;
  /** Split markers cleared from parents that have no children — see `reconcileOrphanedSplits`. */
  unsplit: OrphanedSplitRepair[];
}

/**
 * Take back expired leases and clear split markers left by a subdivision that produced nothing.
 *
 * Each half is caught separately: these are bookkeeping, and neither is worth failing a request
 * or a cron tick for. What they return is counted by the caller, which is the only place the
 * result is worth a log line.
 */
export async function sweepQueue(
  db: PrismaClient = prisma,
  now: Date = new Date(),
): Promise<SweepResult> {
  let requeued = 0;
  let retired = 0;
  try {
    ({ requeued, retired } = await reclaimExpiredJobs(db, now));
  } catch (error) {
    console.warn('[ingest] lease sweep failed', error);
  }

  let unsplit: OrphanedSplitRepair[] = [];
  try {
    unsplit = await reconcileOrphanedSplits(db);
  } catch (error) {
    console.warn('[ingest] split reconciliation failed', error);
  }

  return { requeued, retired, unsplit };
}

/**
 * A sweep hung off request traffic, at most once per `SWEEP_INTERVAL_MS` per process.
 *
 * Module state rather than a database column: the throttle exists to keep one process from
 * writing the same two statements on every request, and a second instance sweeping in the same
 * window is harmless — both statements are conditional updates over rows the other has already
 * left alone.
 */
export function createThrottledSweep(
  run: (now: Date) => Promise<SweepResult> = (now) => sweepQueue(prisma, now),
  intervalMs = SWEEP_INTERVAL_MS,
): (now?: Date) => Promise<SweepResult> | null {
  let sweptAt: number | null = null;

  return (now = new Date()) => {
    if (sweptAt !== null && now.getTime() - sweptAt < intervalMs) return null;
    // Stamped before the await, so a slow sweep does not admit a second one behind it.
    sweptAt = now.getTime();
    return run(now);
  };
}

/**
 * The literal an operator greps for, and the token `infra/azure/ingest.bicep` alerts on.
 *
 * The drainer that actually runs is on Vercel, which has no Application Insights, so its console
 * lines reach nobody who is not already looking. Every one of the conditions below is a *row* in
 * Postgres, though, and the Function App's `ingestPump` timer reads Postgres from inside the
 * subscription that owns the alert — so the distress is republished where a rule can see it.
 */
export const QUEUE_DISTRESS_MARKER = 'switchback-ingest-queue-distress';

/** Distress the queue can be in, all of it visible to any reader of the two ingest tables. */
export interface QueueHealth {
  /** Jobs buried within `DISTRESS_WINDOW_MS`. Nothing retries these. */
  dead: number;
  /** Leases past `LEASE_TIMEOUT_MS` that no sweep has taken back yet. */
  staleLeases: number;
  /** Unfinished or freshly buried jobs whose last failure names a rate limit. */
  rateLimited: number;
  /** Parents claiming a subdivision that produced no children — see `reconcileOrphanedSplits`. */
  orphanedSplits: number;
  /** Subtrees whose leaves have given up, with a z9 ancestor somebody is polling. */
  stuckSubtrees: number;
}

/**
 * How recently something must have happened to count as distress rather than as history.
 *
 * Every field below has to be able to return to zero, or the alert that reads them fires once
 * and never clears — and an alert that cannot change state says nothing about the 429 it exists
 * to surface. Two of the five are cumulative by nature: `failJob` buries a job as `dead` rather
 * than deleting it, deliberately, and `pruneFinishedJobs` keeps those rows for thirty days, so
 * production's resting reading was `dead=17` and would have pinned the gauge on for a month.
 * An hour is longer than the rule's fifteen-minute window, so nothing slips between evaluations,
 * and short enough that a fixed queue reads clean by the next tick.
 */
export const DISTRESS_WINDOW_MS = 60 * 60 * 1000;

/** Whether anything in this reading is worth waking somebody for. */
export function isDistressed(health: QueueHealth): boolean {
  return Object.values(health).some((count) => count > 0);
}

/**
 * Read the queue's distress, without writing anything.
 *
 * `rateLimited` matches on `lastError` rather than on a counter, because the drainer that
 * produces it keeps no counter this process can read — `OverpassClient` records the mirror's 429
 * in the message it throws, `failJob` stores it, and the row outlives the lambda. It counts a job
 * that has not finished at all alongside one buried inside the window: a 429 leaves the job
 * `queued` on a backoff, where `completedAt` is still null and the retry is still ahead of it.
 */
export async function queueHealth(
  db: PrismaClient = prisma,
  now: Date = new Date(),
  leaseTimeoutMs = LEASE_TIMEOUT_MS,
): Promise<QueueHealth> {
  const staleBefore = new Date(now.getTime() - leaseTimeoutMs);
  const recent = new Date(now.getTime() - DISTRESS_WINDOW_MS);

  const [dead, staleLeases, rateLimited, orphanedSplits, stuckSubtrees] = await Promise.all([
    db.ingestJob.count({ where: { status: JobStatus.dead, completedAt: { gte: recent } } }),
    db.ingestJob.count({
      where: { status: JobStatus.running, lockedAt: { lt: staleBefore } },
    }),
    db.ingestJob.count({
      where: {
        lastError: { contains: '429' },
        OR: [{ completedAt: null }, { completedAt: { gte: recent } }],
      },
    }),
    countOrphanedSplits(db),
    db.ingestTile.count({ where: { lastError: { contains: SUBTREE_STUCK_MARKER } } }),
  ]);

  return { dead, staleLeases, rateLimited, orphanedSplits, stuckSubtrees };
}
