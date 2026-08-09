/**
 * Queue maintenance that has to happen whether or not anything is being drained. `ingestPump`
 * runs it every two minutes, which is the estate's only maintenance schedule.
 */

import { JobStatus, prisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { LEASE_TIMEOUT_MS, reclaimExpiredJobs } from './jobs';
import { SUBTREE_STUCK_MARKER, countOrphanedSplits, reconcileOrphanedSplits } from './subdivide';
import type { OrphanedSplitRepair } from './subdivide';

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
 * The literal an operator greps for, and the token `infra/azure/ingest.bicep` alerts on.
 *
 * Every condition below is a *row*, not an event, so none of it appears in the telemetry of the
 * invocation that caused it — a tile wedged by a killed handler is discovered by whatever reads
 * the table next. `ingestPump` republishes the reading on every tick, which is what puts it
 * somewhere a rule can query.
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
  /** Leases past `LEASE_TIMEOUT_MS` that survived a sweep — see `LEASE_SWEEP_GRACE_MS`. */
  staleLeases: number;
  /** Unfinished or freshly buried jobs whose last failure names a rate limit. */
  rateLimited: number;
  /** Parents claiming a subdivision that produced no children — see `reconcileOrphanedSplits`. */
  orphanedSplits: number;
  /** Subtrees whose leaves have given up, with a z9 ancestor somebody is polling. */
  stuckSubtrees: number;
  /** Tiles left mid-fetch with no job that will ever finish them — see `wedgedTiles`. */
  wedgedTiles: number;
  /** 1 when work is due and nothing has finished in `DRAIN_SILENCE_MS` — the drain has stopped. */
  stalledDrain: number;
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

/**
 * How long past `LEASE_TIMEOUT_MS` a lease may sit before its survival is distress rather than
 * ordinary timing.
 *
 * `reportQueueHealth` runs at the top of the `ingestPump` handler and the sweep runs just after it,
 * so every reading catches the leases that tick is about to reclaim. Measured over the 24 h to
 * 2026-08-08: `staleLeases` was non-zero in 376 of 685 readings, against 52 for `dead` and 3 for
 * `wedgedTiles` — so this one field decided `isDistressed` more than half the time and the rule
 * reading it was a light left on. A lease younger than one sweep interval has not yet had a sweep
 * to survive; one older than that has, and something is wrong with the reaper.
 */
export const LEASE_SWEEP_GRACE_MS = 5 * 60 * 1000;

/**
 * How long the drain may go without finishing anything, while work is due, before that is a
 * stoppage rather than a quiet patch.
 *
 * **Depth is not the signal, and this is the one gauge where that had to be worked out rather
 * than assumed.** `ingest_jobs` holds 44,884 `queued` rows whose `runAfter` is in the past, the
 * oldest since 2026-07-30 — a backlog that predates every drainer now running and does not
 * shrink on any horizon an alert cares about. A field counting due work would read five figures
 * forever: the pinned gauge `DISTRESS_WINDOW_MS` exists to prevent, rebuilt.
 *
 * What separates a stopped drain from a slow one is throughput, so this measures the gap since
 * the last terminal transition. Six hours is roughly forty tiles at the 9-minute handler bound,
 * so a drain that is merely slow clears it comfortably while one that has stopped is named the
 * same working day.
 *
 * **The old thirty-six hours was sized for a schedule that no longer exists.** It cleared a
 * missed `/api/cron/drain` period — a once-a-day cron, with the rest request-driven — and the
 * 27.90 h maximum gap measured over the fortnight to 2026-08-08 is an artefact of that regime,
 * not a baseline for this one. `ingestPump` now runs every two minutes and the queue trigger
 * drains continuously, so a day and a half of silence is not a quiet weekend any more. This
 * number is due a re-measurement once the continuous regime has a fortnight of history.
 */
export const DRAIN_SILENCE_MS = 6 * 60 * 60 * 1000;

/** Whether anything in this reading is worth waking somebody for. */
export function isDistressed(health: QueueHealth): boolean {
  return Object.values(health).some((count) => count > 0);
}

/** The counts as one field list, so the heartbeat and the distress line cannot drift apart. */
export function formatQueueHealth(health: QueueHealth): string {
  return (
    `dead=${health.dead} staleLeases=${health.staleLeases} rateLimited=${health.rateLimited} ` +
    `orphanedSplits=${health.orphanedSplits} stuckSubtrees=${health.stuckSubtrees} ` +
    `wedgedTiles=${health.wedgedTiles} stalledDrain=${health.stalledDrain}`
  );
}

/**
 * Tiles stuck mid-fetch: `running` with nothing fetched and no job that can finish them.
 *
 * `processTile` writes `running` before it queries and every exit rewrites the row, so a tile left
 * `running` is one whose invocation did not come back. Nineteen of them sat in production on
 * 2026-08-07 with nothing observing the number: `staleLeases` counts `ingest_jobs`, and the job
 * beneath a wedged tile is frequently *not* stale — it was completed, or reclaimed and buried —
 * which is exactly why the tile is the thing that has to be counted.
 *
 * The join is what keeps the gauge from pinning. A tile is only wedged if no job of its own is
 * `queued` or `running`; while one is, the tile is mid-flight and healthy, which is the state
 * every tile passes through on the way to `ready`.
 */
export async function countWedgedTiles(db: PrismaClient): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count
      FROM ingest_tiles tile
     WHERE tile.status = 'running'
       AND tile."fetchedAt" IS NULL
       AND NOT EXISTS (
             SELECT 1 FROM ingest_jobs job
              WHERE job."dedupeKey" = 'ingest_tile:' || tile.quadkey
                AND job.status IN ('queued', 'running'))
  `;
  return row?.count ?? 0;
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
  const staleBefore = new Date(now.getTime() - leaseTimeoutMs - LEASE_SWEEP_GRACE_MS);
  const recent = new Date(now.getTime() - DISTRESS_WINDOW_MS);
  const silentBefore = new Date(now.getTime() - DRAIN_SILENCE_MS);

  const [
    dead,
    staleLeases,
    rateLimited,
    orphanedSplits,
    stuckSubtrees,
    wedgedTiles,
    oldestDue,
    lastFinished,
  ] = await Promise.all([
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
    countWedgedTiles(db),
    db.ingestJob.findFirst({
      where: { status: JobStatus.queued, runAfter: { lte: now } },
      orderBy: { runAfter: 'asc' },
      select: { runAfter: true },
    }),
    db.ingestJob.aggregate({
      where: { status: { in: [JobStatus.done, JobStatus.dead] } },
      _max: { completedAt: true },
    }),
  ]);

  return {
    dead,
    staleLeases,
    rateLimited,
    orphanedSplits,
    stuckSubtrees,
    wedgedTiles,
    stalledDrain: stalledDrain(
      oldestDue?.runAfter ?? null,
      lastFinished._max.completedAt,
      silentBefore,
    ),
  };
}

/**
 * Whether the drain has stopped, as opposed to having nothing to do or working a long backlog.
 *
 * Both conditions are required. Silence alone is an empty queue, which is the healthy resting
 * state and must not page. Due work alone is the 44,884-row backlog, which is permanent. On a
 * queue that has never finished anything the oldest due job dates the silence instead, so a
 * newly seeded deployment reads healthy until its first job is genuinely overdue.
 */
function stalledDrain(
  oldestDue: Date | null,
  lastFinished: Date | null,
  silentBefore: Date,
): number {
  if (!oldestDue) return 0;
  const since = lastFinished ?? oldestDue;
  return since < silentBefore ? 1 : 0;
}
