/**
 * Queue maintenance that has to happen whether or not anything is being drained. `ingestPump`
 * runs it every two minutes, which is the estate's only maintenance schedule.
 */

import { JobKind, JobStatus, PhotoSource, TileStatus, prisma } from '@switchback/db';
import type { PrismaClient, TileSource } from '@switchback/db';
import { reconcileDeadJobs } from './dead-jobs';
import type { AbandonedJob, TriageOptions } from './dead-jobs';
import { HOST_FUNCTION_TIMEOUT_MS, LEASE_TIMEOUT_MS, reclaimExpiredJobs } from './jobs';
import { SUBTREE_STUCK_MARKER, countOrphanedSplits, reconcileOrphanedSplits } from './subdivide';
import type { OrphanedSplitRepair } from './subdivide';

export interface SweepResult {
  /** Expired leases returned to the queue. */
  requeued: number;
  /** Expired leases buried, out of attempts. */
  retired: number;
  /** Split markers cleared from parents that have no children — see `reconcileOrphanedSplits`. */
  unsplit: OrphanedSplitRepair[];
  /** Tiles left `running` by a handler that never came back — see `repairWedgedTiles`. */
  unwedged: string[];
  /** Buried jobs granted one more attempt — see `reconcileDeadJobs`. */
  revived: string[];
  /** Buried jobs no automatic path will run again — see `reconcileDeadJobs`. */
  abandoned: AbandonedJob[];
}

/**
 * Take back expired leases, clear split markers left by a subdivision that produced nothing,
 * correct tiles whose handler never came back, and decide what happens to the jobs the retry
 * ladder buried.
 *
 * `triage` is how a caller withholds the last of those without withholding the rest — see
 * `ingestPump`, which passes `revive: false` under the brake. Reviving is the one part of this
 * that puts work back on the queue, so it is the one part an operator stopping new ingest means
 * to stop; reclaim, split repair and wedged-tile repair all have to keep running under a brake,
 * because a brake is pulled precisely when they are least affordable to lose. A braked tick still
 * retires burials — `reconcileDeadJobs` reads its two windows separately so that a revival it may
 * not perform cannot crowd out a retirement it may.
 *
 * Each part is caught separately: these are bookkeeping, and none is worth failing a cron tick
 * for. What they return is counted by the caller, which is the only place the result is worth a
 * log line.
 */
export async function sweepQueue(
  db: PrismaClient = prisma,
  now: Date = new Date(),
  triage: TriageOptions = {},
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

  /*
   * After the lease sweep, never before: a reclaim turns a job back to `queued`, which is exactly
   * the condition that makes its tile not wedged. Running this first would fail tiles the sweep
   * was about to rescue.
   */
  let unwedged: string[] = [];
  try {
    unwedged = await repairWedgedTiles(db, now);
  } catch (error) {
    console.warn('[ingest] wedged tile repair failed', error);
  }

  /*
   * Last, and after the reclaim for the same reason `repairWedgedTiles` runs after it: a reclaim
   * can bury a job this tick, and deciding its fate in the same pass would spend a revival on a
   * burial that is seconds old. `REVIVAL_DELAYS_MS` is what actually enforces that, so the
   * ordering is belt to its braces.
   */
  let revived: string[] = [];
  let abandoned: AbandonedJob[] = [];
  try {
    ({ revived, abandoned } = await reconcileDeadJobs(db, now, triage));
  } catch (error) {
    console.warn('[ingest] dead-job reconciliation failed', error);
  }

  return { requeued, retired, unsplit, unwedged, revived, abandoned };
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
  /**
   * Jobs buried within `DISTRESS_WINDOW_MS` that `reconcileDeadJobs` has not since revived —
   * a revival clears `completedAt`, which is what takes the row back out of this count.
   */
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
  /** 1 when a whole window of finished enrichment seeded no photograph — see `photoSeedBlackout`. */
  photoSeedBlackout: number;
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
    `wedgedTiles=${health.wedgedTiles} stalledDrain=${health.stalledDrain} ` +
    `photoSeedBlackout=${health.photoSeedBlackout}`
  );
}

/**
 * The literal an operator greps for, and the token `switchback-ingest-empty-tile-writes` alerts on.
 *
 * **Deliberately not a `QueueHealth` field, and this is the reason.** `isDistressed` is
 * `some((count) => count > 0)`; empty tiles exist wherever a viewport reaches ocean, so a count of
 * them in that interface would report distress on every tick for ever and drown every other gauge
 * in it. `formatQueueHealth` is also a field list KQL rules parse, so widening it breaks the rules
 * already reading it. This reading is its own line for both reasons.
 */
export const EMPTY_WRITE_MARKER = 'switchback-ingest-empty-tile-writes';

/**
 * How much history the share is read over.
 *
 * A day, not the distress window's hour, because this is a proportion and an hour is not a sample.
 * Six hours is roughly forty tiles at the nine-minute handler bound, so an hourly denominator is
 * single digits and its share swings the whole way from 0 to 1 on one ocean tile.
 */
export const EMPTY_WRITE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** One source's tile writes inside the window, and how many of them landed empty. */
export interface EmptyWriteRate {
  /** Null on rows a fetch wrote before provenance was recorded. */
  source: TileSource | null;
  /** Tiles this source filled or emptied. A failed attempt writes no `fetchedAt` and is in neither. */
  written: number;
  empty: number;
}

/**
 * What share of each source's tile writes said "no trails here".
 *
 * The one in-band signal for a source that answers an out-of-area query `200 OK` with zero
 * elements. That response is indistinguishable from ocean on the tile it lands on, `processTile`
 * caches it `empty` for a month, and nothing else in the estate records it — the request reads
 * success and no job row is written. See the note above `DEFAULT_ENDPOINTS`.
 *
 * **Split by source and reported as a proportion, because neither an absolute count of empties nor
 * one source's share means anything alone.** Ocean is real and its tiles are legitimately empty.
 * What identifies the hazard is one source's share against another's over comparable ground, so
 * until a second source exists this reading is accruing the baseline that comparison will need.
 *
 * `status` and `fetchedAt` are read together because one statement writes both. A later failed
 * attempt moves `status` without moving `fetchedAt`, which would drop that tile from the empty
 * count while leaving it in the total; an `empty` tile is not re-fetched for thirty days, so
 * inside one window that is a rounding error rather than a bias.
 */
export async function readEmptyWriteRates(
  db: PrismaClient = prisma,
  now: Date = new Date(),
  windowMs: number = EMPTY_WRITE_WINDOW_MS,
): Promise<EmptyWriteRate[]> {
  const since = new Date(now.getTime() - windowMs);
  return db.$queryRaw<EmptyWriteRate[]>`
    SELECT tile."sourceKind" AS source,
           count(*)::int AS written,
           count(*) FILTER (WHERE tile.status = 'empty')::int AS empty
      FROM ingest_tiles tile
     WHERE tile."fetchedAt" >= ${since}
     GROUP BY tile."sourceKind"
     ORDER BY tile."sourceKind"
  `;
}

/**
 * One source's reading as a field list, one line per source.
 *
 * Both counts rather than the quotient they imply: a rule has to weigh the share against the
 * sample behind it, and `share=1.0` off two tiles is noise no threshold can tell from a mirror
 * that has stopped serving the planet.
 */
export function formatEmptyWriteRate(rate: EmptyWriteRate): string {
  return `source=${rate.source ?? 'unknown'} written=${rate.written} empty=${rate.empty}`;
}

/**
 * Tiles stuck mid-fetch: `running` with nothing fetched and no job that can finish them.
 *
 * `processTile` writes `running` before it queries and every exit rewrites the row, so a tile left
 * `running` is one whose invocation did not come back. `staleLeases` does not see them: it counts
 * `ingest_jobs`, and the job beneath a wedged tile is frequently *not* stale — it was completed, or
 * reclaimed and buried — which is why the tile is the thing that has to be counted. Measured on
 * 2026-08-08, the first day this gauge ran in production: six of 37 readings non-zero, peak six.
 *
 * The join is what keeps the gauge from pinning on a tile that is merely mid-flight. A tile is only
 * wedged if no job of its own is `queued` or `running`; while one is, the tile is on its way to
 * `ready`, which is the state every tile passes through.
 *
 * `WEDGE_GRACE_MS` is what keeps it from pinning on a tile nothing will ever repair. `runPump`
 * selects only `queued` jobs and `reclaimExpiredJobs` only moves `running` to `queued` or `dead`,
 * so a tile whose job was buried on its last attempt has no route back and would otherwise be
 * counted forever. `repairWedgedTiles` is the route back; this window is how long a tile waits for
 * it before it is worth reporting.
 */
export async function countWedgedTiles(
  db: PrismaClient,
  now: Date = new Date(),
  graceMs: number = WEDGE_GRACE_MS,
): Promise<number> {
  const wedgedBefore = new Date(now.getTime() - graceMs);
  const [row] = await db.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count
      FROM ingest_tiles tile
     WHERE tile.status = 'running'
       AND tile."fetchedAt" IS NULL
       AND tile."updatedAt" < ${wedgedBefore}
       AND NOT EXISTS (
             SELECT 1 FROM ingest_jobs job
              WHERE job."dedupeKey" = 'ingest_tile:' || tile.quadkey
                AND job.status IN ('queued', 'running'))
  `;
  return row?.count ?? 0;
}

/**
 * How long a tile may sit `running` with no job before it counts as wedged.
 *
 * **Sized from one invocation, not from a recovery bound.** `processTile` stamps `updatedAt` when
 * an attempt begins and the row stays `running` for the rest of it, so the window has to cover a
 * whole handler — `HOST_FUNCTION_TIMEOUT_MS` — before an absent job means anything, plus a sweep
 * interval of slack. What keeps the gauge off a tile the ordinary path will repair is the
 * `NOT EXISTS` join, which holds for as long as that path takes; a window is the wrong instrument
 * for it, and the recovery bound it was previously derived from is a backlog drain with no
 * constant behind it.
 */
export const WEDGE_GRACE_MS = HOST_FUNCTION_TIMEOUT_MS + LEASE_SWEEP_GRACE_MS;

/**
 * The literal `switchback-ingest-ground-lost` greps for, written into the tile's `lastError`.
 *
 * A wedged tile is repaired by correcting the row rather than by retrying it, so nothing else
 * would record that it happened.
 */
export const TILE_WEDGED_MARKER = 'switchback-ingest-tile-wedged';

/** One window of finished enrichment, and how much of it produced a photograph. */
export interface EnrichWindow {
  /** `enrich_trail` jobs that reached `done` inside the window. */
  completed: number;
  /** How many of those jobs' trails now hold at least one photograph. */
  seeded: number;
}

/**
 * How many finished enrichments a window needs before all of them seeding nothing means anything.
 *
 * A trail with no photograph is the ordinary case, not a fault: of 40 trails drawn at random from
 * the production corpus on 2026-08-09, 25 had nothing on Commons within their search radius. So a
 * run of empties says nothing and only unanimity over a decent sample does — at that measured
 * 62.5% the odds of twenty-five consecutive empties are about 8 in a million.
 */
export const MIN_ENRICH_SAMPLE = 25;

/**
 * Whether enrichment is finishing jobs and seeding nothing whatsoever.
 *
 * This is the one fault in the pipeline that leaves no trace anywhere else. `enrichTrailPhotos`
 * returns before its first write when its sources answer with nothing, so the job records `done`
 * with a null `lastError` and reads exactly like one that seeded a gallery — 997 had run that way
 * by 2026-08-09 against an empty `photos` table, and no gauge, log line or error column showed it.
 */
export function photoSeedBlackout(
  window: EnrichWindow,
  minSample: number = MIN_ENRICH_SAMPLE,
): number {
  return window.completed >= minSample && window.seeded === 0 ? 1 : 0;
}

/**
 * Finished enrichments in the window, against the photographs they were supposed to produce.
 *
 * Counts rows in `photos` rather than reading `Trail.photoCount`: the counter is written by the
 * same handler whose silence this measures, so a gauge trusting it would take that handler's
 * bookkeeping as evidence about that handler's writes. Restricted to the sources enrichment
 * actually seeds, so a reader's own upload cannot report a dead seeder as healthy.
 */
export async function readEnrichWindow(db: PrismaClient, since: Date): Promise<EnrichWindow> {
  const [row] = await db.$queryRaw<Array<{ completed: number; seeded: number }>>`
    SELECT count(*)::int AS completed,
           count(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM photos photo
                WHERE photo."trailId" = trail.id
                  AND photo.source IN (${PhotoSource.wikimedia}::"PhotoSource",
                                       ${PhotoSource.mapillary}::"PhotoSource")
             )
           )::int AS seeded
      FROM ingest_jobs job
      JOIN trails trail ON trail.id = split_part(job."dedupeKey", ':', 2)
     WHERE job.kind = ${JobKind.enrich_trail}::"JobKind"
       AND job.status = ${JobStatus.done}::"JobStatus"
       AND job."completedAt" >= ${since}
  `;
  return { completed: row?.completed ?? 0, seeded: row?.seeded ?? 0 };
}

/**
 * Take tiles out of `running` when nothing is running them.
 *
 * `running` is a claim that a handler holds this tile. A tile whose handler the host killed on its
 * last attempt has no such holder and no route back: `runPump` publishes only `queued` jobs and
 * `reclaimExpiredJobs` only moves `running` to `queued` or `dead`, so neither reaches it. Left
 * alone the row states something false forever and `wedgedTiles` never falls.
 *
 * `failed` is the repair rather than a re-enqueue: a tile that has exhausted its attempts is
 * exactly what re-enqueueing loops on. `isTileFresh` treats `failed` as re-fetchable, so the next
 * request for that area picks it up on the ordinary path, with the reason still on the row.
 */
export async function repairWedgedTiles(
  db: PrismaClient = prisma,
  now: Date = new Date(),
  graceMs: number = WEDGE_GRACE_MS,
): Promise<string[]> {
  const wedgedBefore = new Date(now.getTime() - graceMs);
  const repaired = await db.$queryRaw<Array<{ quadkey: string }>>`
    UPDATE ingest_tiles tile
       SET status = ${TileStatus.failed}::"TileStatus",
           "lastError" = ${`${TILE_WEDGED_MARKER}: left running with no job that could finish it`},
           "updatedAt" = ${now}
     WHERE tile.status = 'running'
       AND tile."fetchedAt" IS NULL
       AND tile."updatedAt" < ${wedgedBefore}
       AND NOT EXISTS (
             SELECT 1 FROM ingest_jobs job
              WHERE job."dedupeKey" = 'ingest_tile:' || tile.quadkey
                AND job.status IN ('queued', 'running'))
    RETURNING tile.quadkey
  `;
  return repaired.map((row) => row.quadkey);
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
    enrichWindow,
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
    countWedgedTiles(db, now),
    db.ingestJob.findFirst({
      where: { status: JobStatus.queued, runAfter: { lte: now } },
      orderBy: { runAfter: 'asc' },
      select: { runAfter: true },
    }),
    db.ingestJob.aggregate({
      where: { status: { in: [JobStatus.done, JobStatus.dead] } },
      _max: { completedAt: true },
    }),
    readEnrichWindow(db, recent),
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
    photoSeedBlackout: photoSeedBlackout(enrichWindow),
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
