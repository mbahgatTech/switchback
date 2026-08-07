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

/**
 * The literal every reading emits, distressed or not, and the token
 * `switchback-ingest-worker-silent` alerts on the *absence* of.
 *
 * A marker that only appears under distress makes silence ambiguous: a healthy queue and a
 * process that is not running produce identical telemetry, so no rule reading it can tell a
 * clean estate from a worker serving a build that has no such rule in it. One line per reading
 * makes absence the alarmable condition, which is the only signal that catches a worker that
 * stopped deploying.
 */
export const QUEUE_HEALTH_MARKER = 'switchback-ingest-queue-health';

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
 * production's resting reading is `dead=25` and would have pinned the gauge on for a month.
 * An hour is longer than the rule's fifteen-minute window, so nothing slips between evaluations,
 * and short enough that a fixed queue reads clean by the next tick.
 */
export const DISTRESS_WINDOW_MS = 60 * 60 * 1000;

/** Whether anything in this reading is worth waking somebody for. */
export function isDistressed(health: QueueHealth): boolean {
  return Object.values(health).some((count) => count > 0);
}

/** The five counts as one field list, so the heartbeat and the distress line cannot drift apart. */
export function formatQueueHealth(health: QueueHealth): string {
  return (
    `dead=${health.dead} staleLeases=${health.staleLeases} rateLimited=${health.rateLimited} ` +
    `orphanedSplits=${health.orphanedSplits} stuckSubtrees=${health.stuckSubtrees}`
  );
}

/**
 * Read the queue's distress, without writing anything.
 *
 * `rateLimited` matches on `lastError` rather than on a counter, because the drainer that
 * produces it keeps no counter this process can read — `OverpassClient` records the mirror's 429
 * in the message it throws, `failJob` stores it, and the row outlives the lambda.
 *
 * Both arms are windowed, and the unfinished one is why. `failJob` requeues a rate-limited job
 * with `completedAt` still null and `lastError` intact, so a predicate that accepted any null
 * `completedAt` counted that row until the job finally ran — which, against 44,884 queued jobs,
 * is weeks. That is the pinned gauge this window exists to prevent, in the field it exists to
 * report. `runAfter` is what `failJob` moves forward, so it dates the refusal to within one
 * backoff step.
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
        OR: [{ completedAt: { gte: recent } }, { runAfter: { gte: recent } }],
      },
    }),
    countOrphanedSplits(db),
    db.ingestTile.count({ where: { lastError: { contains: SUBTREE_STUCK_MARKER } } }),
  ]);

  return { dead, staleLeases, rateLimited, orphanedSplits, stuckSubtrees };
}
