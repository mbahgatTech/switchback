/**
 * Subdivision: what a tile does when it will not fit in one invocation. The parent is replaced
 * by its four z+1 children, which ingest independently and roll their result back up.
 */

import { JobKind, JobStatus, TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  INGEST_ZOOM,
  MAX_INGEST_ZOOM,
  childQuadkeys,
  parentQuadkey,
  quadkeyToBBox,
  quadkeyToTile,
} from '@switchback/geo';
import { DRAIN_ADMISSION_KEY } from './drain-slot';
import { isTileFresh, isTileSettled } from './freshness';
import { trailIdentityMode } from './identity';
import { DEFAULT_MAX_ATTEMPTS, LEASE_TIMEOUT_MS, enqueue, tileJobKey } from './jobs';

/** How many children a quadkey has. Four, always — that is what "quad" means. */
export const CHILDREN_PER_TILE = 4;

/**
 * The `lastError` a split leaves on the parent, and the predicate `reconcileOrphanedSplits`
 * sweeps on. One constant so the writer and the reader cannot drift apart.
 */
export const SPLIT_MARKER_PREFIX = 'split into ';

/**
 * Priority a child inherits. Above the 0 a background refresh uses and level with a live
 * viewport, because a split tile is one somebody has already waited a whole invocation for —
 * and the parent cannot complete until the last child does, so demoting one demotes all four.
 */
export const SPLIT_PRIORITY = 5;

/**
 * The literal `switchback-ingest-tile-split` greps for, on every line subdivision emits.
 *
 * A split is not a success and must not be reported as one. Before subdivision a tile that ran
 * out of clock threw, `drainJobs` recorded a failure, and `JOB_FAILED_MARKER` armed the alert;
 * now it returns normally and the invocation logs `done`. Without a token of its own the only
 * telemetry an on-call reader has cannot tell a dense tile deferring to four children from one
 * that actually ingested. `infra/azure/ingest.bicep` greps for this and
 * `apps/ingest-worker/test/drain.test.ts` asserts the two agree.
 */
export const TILE_SPLIT_MARKER = 'switchback-ingest-tile-split';

/**
 * The literal an operator greps for when a descendant of a split tile has run out of retries.
 *
 * The leaf's own failure names the leaf; nothing names the z9 ancestor a reader is polling, and
 * that is the row somebody is waiting on. Written once per transition rather than once per drain
 * — see `rollUpSplitTile`, which compares it against the parent's stored `lastError`.
 */
export const SUBTREE_STUCK_MARKER = 'switchback-ingest-subtree-stuck';

/**
 * Runs of a single child tile after which `queueStaleChildren` stops reviving it.
 *
 * Two full retry ladders, derived rather than written out, so raising the ladder raises this with
 * it. `IngestTile.attempts` is the counter because it is the only durable one: `processTile`
 * increments it on every run and nothing resets it, while `enqueue` clears the *job*'s `attempts`
 * on each revival — which is precisely how a revived child restarts its five-attempt ladder from
 * zero and why an uncapped revival never terminates.
 *
 * `reconcileDeadJobs` reads this cap rather than working around it: a child past it is retired
 * there rather than granted a second budget, so the two revival paths do not sum into an
 * unbounded one.
 */
export const SPLIT_CHILD_ATTEMPT_CAP = 2 * DEFAULT_MAX_ATTEMPTS;

/**
 * The zoom past which a tile is failed rather than split. `INGEST_ZOOM` disables subdivision, and
 * that is what an absent or unusable variable returns — it has to be switched on deliberately,
 * which is also what makes deleting the setting a rollback. `infra/azure/ingest.bicep` declares it
 * on the Function App, the only process that drains `ingest_jobs`, and an application-settings write
 * replaces the collection whole — so a deploy that drops the entry reads as off rather than stale.
 *
 * Subdividing cuts fresh interior seam, and a seam fragments any trail crossing it unless
 * `TrailWay` is deciding identity. So the ceiling is held at `INGEST_ZOOM` whenever
 * `INGEST_TRAIL_IDENTITY` is not `claim`, however the zoom variable is set — the two cannot be
 * flipped independently into the combination that corrupts the corpus. Clamped rather than
 * rejected: this runs inside a request path, and a fail-safe default beats a startup error.
 */
export function subdivideMaxZoom(source: NodeJS.ProcessEnv = process.env): number {
  const value = Number(source.INGEST_SUBDIVIDE_MAX_ZOOM);
  if (!Number.isInteger(value) || value < INGEST_ZOOM || value > MAX_INGEST_ZOOM) {
    return INGEST_ZOOM;
  }
  if (trailIdentityMode(source) !== 'claim') return INGEST_ZOOM;
  return value;
}

/** Whether a tile at this zoom has anywhere left to go. */
export function canSubdivide(z: number, maxZoom = subdivideMaxZoom()): boolean {
  return z < maxZoom;
}

/** The columns a roll-up reads off each child. */
export interface ChildTile {
  quadkey: string;
  status: TileStatus;
  fetchedAt: Date | null;
  trailCount: number;
  fetchMs: number | null;
  /** Runs of this tile, ever. The revival cap counts in these — see `SPLIT_CHILD_ATTEMPT_CAP`. */
  attempts: number;
}

/** What a parent row becomes once every child is in. */
export interface Rollup {
  status: TileStatus;
  fetchedAt: Date;
  trailCount: number;
  fetchMs: number;
}

/**
 * The parent's row from its children's, or null while any child is outstanding.
 *
 * Two rules carry the whole thing. **All four or nothing**: reporting ready with three children
 * in tells a reader an area is complete while a quarter of it is missing, and nothing later
 * corrects that until the TTL. And **the oldest child sets `fetchedAt`**, so the parent leaves
 * the TTL when its stalest quarter does — taking the freshest would let one child refreshed
 * yesterday hold three stale ones out of the refresh sweep indefinitely.
 */
export function rollUp(children: readonly ChildTile[]): Rollup | null {
  if (children.length !== CHILDREN_PER_TILE) return null;
  if (!children.every((child) => isTileSettled(child.status) && child.fetchedAt !== null)) {
    return null;
  }

  const oldest = children.reduce((a, b) => (a.fetchedAt! < b.fetchedAt! ? a : b));
  const trailCount = children.reduce((sum, child) => sum + child.trailCount, 0);

  return {
    // `empty` only when every child was: it is what lets the refresh sweep skip ocean, and one
    // child with trails in it makes the parent a place worth re-querying.
    status: children.every((child) => child.status === TileStatus.empty)
      ? TileStatus.empty
      : TileStatus.ready,
    fetchedAt: oldest.fetchedAt!,
    trailCount,
    fetchMs: children.reduce((sum, child) => sum + (child.fetchMs ?? 0), 0),
  };
}

const childSelect = {
  quadkey: true,
  status: true,
  fetchedAt: true,
  trailCount: true,
  fetchMs: true,
  attempts: true,
} as const;

/**
 * The child rows of a tile, if it has any. Four means split; zero means never split. A quadkey
 * is a prefix code, so this is a range scan on the primary key rather than a second column.
 */
export async function childTiles(db: PrismaClient, quadkey: string): Promise<ChildTile[]> {
  return db.ingestTile.findMany({
    where: { quadkey: { in: childQuadkeys(quadkey) } },
    select: childSelect,
    orderBy: { quadkey: 'asc' },
  });
}

/** A tile row as it stood before the run that is now splitting it. Null when there was no row. */
export type TileSnapshot = { status: TileStatus; fetchedAt: Date | null } | null;

/**
 * Replace a tile with its four children and queue them.
 *
 * Admission control is deliberately not consulted. `queueTiles` asks it because a viewport is
 * requesting *new ground*; this is ground already admitted, already attempted, and already paid
 * for with a ten-minute invocation — a refusal here would strand the parent with no children and
 * no route to ready.
 *
 * A parent that has served trails before keeps its `ready`/`empty` status and its old
 * `fetchedAt` rather than dropping to `pending`. `ensureCoverage` classifies a settled-but-stale
 * tile as ready-and-refreshing and anything else as pending, so demoting it would flip a reader
 * from "here are your trails, refreshing" to "still loading" for as long as the four children
 * take.
 *
 * **`previous` is a parameter and not a read, because by the time this runs the row no longer
 * says what the tile was.** `processTile` writes `running` before it fetches, so a re-read here
 * sees `running` for every caller and the preservation above is dead code — which is exactly what
 * it was until this parameter existed. The caller holds the only honest answer.
 *
 * `lostNote` rides *behind* the split marker, never in front of it: `reconcileOrphanedSplits` and
 * `countOrphanedSplits` both match the marker as a prefix, so anything prepended would hide the
 * parent from its own repair sweep.
 */
export async function splitTile(
  db: PrismaClient,
  quadkey: string,
  options: {
    previous: TileSnapshot;
    fetchMs?: number;
    priority?: number;
    /** Trails this tile owed and does not have, appended to `lastError` after the marker. */
    lostNote?: string;
    /** Trails the splitting run did commit, so the parent is not read as holding nothing. */
    trailCount?: number;
  },
): Promise<string[]> {
  const children = childQuadkeys(quadkey);
  const priority = options.priority ?? SPLIT_PRIORITY;
  const previous = options.previous;

  for (const child of children) {
    const { x, y, z } = quadkeyToTile(child);
    const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(child);
    await db.ingestTile.upsert({
      where: { quadkey: child },
      create: { quadkey: child, x, y, z, status: TileStatus.pending, bboxW, bboxS, bboxE, bboxN },
      update: {},
    });
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey(child),
      payload: { quadkey: child },
      priority,
    });
  }

  const servesData =
    previous !== null && isTileSettled(previous.status) && previous.fetchedAt !== null;
  const marker = `${SPLIT_MARKER_PREFIX}${children.length} tiles at z${quadkey.length + 1}`;

  await db.ingestTile.update({
    where: { quadkey },
    data: {
      status: servesData ? previous.status : TileStatus.pending,
      lastError: `${marker}${options.lostNote ?? ''}`.slice(0, 1000),
      ...(options.fetchMs === undefined ? {} : { fetchMs: options.fetchMs }),
      ...(options.trailCount === undefined ? {} : { trailCount: options.trailCount }),
    },
  });

  return children;
}

/** What a drain of a split parent decided about its children. */
export interface ChildQueueOutcome {
  /** Children this call put back on the queue. */
  queued: string[];
  /** Children the queue already owns: claimed, running, or waiting out a backoff. */
  waiting: string[];
  /**
   * Children whose retry ladder ran out. A subset of `queued` — they are revived here, because
   * nothing else can — and separately named because five failed attempts is a fact about the
   * ground, not about the schedule, and a sixth is unlikely to go differently.
   */
  exhausted: string[];
  /**
   * Children past `SPLIT_CHILD_ATTEMPT_CAP`, left off the queue. Disjoint from `queued`: this is
   * the set no automatic path will run again — `reconcileDeadJobs` honours the same cap — and the
   * parent stays incomplete until an operator intervenes.
   */
  abandoned: string[];
}

/**
 * Queue every child that is not serving fresh data and that nothing else is going to run.
 *
 * The job row decides, not the tile row. `IngestTile.status` is `failed` both for a child thirty
 * seconds from its next attempt and for one that has given up, and `enqueue` clears `attempts` —
 * so re-queueing on tile status alone resets the backoff ladder of a child that was already
 * coming back, on every viewport poll. `failJob` writes `queued` with a future `runAfter` while
 * attempts remain and `dead` only when they are gone, which is the distinction this reads.
 *
 * **A `dead` child is revived, deliberately, but only up to `SPLIT_CHILD_ATTEMPT_CAP` runs.** This
 * is the path back for a child: `splitTile` enqueues each exactly once, `ensureCoverage` covers z9
 * alone, `reclaimExpiredJobs` does not touch a dead row, and `reconcileDeadJobs` retires a child
 * this cap has already stopped rather than granting it a second budget. The cap is what keeps that
 * from running forever — a revived child starts a fresh five-attempt ladder, so without a counter
 * the ladder restarts for as long as anyone leaves a map open over the parent. `attempts` on the
 * *tile* survives the revival where the job's does not.
 *
 * Past the cap the parent is **held, not promoted**: `rollUp` needs all four children settled, so
 * an abandoned child leaves the parent short rather than letting it report an area complete with a
 * quarter of it missing. `rollUpSplitTile` names the abandoned children on the parent's row and in
 * `SUBTREE_STUCK_MARKER`, and `unsplitTile` is the way back.
 */
export async function queueStaleChildren(
  db: PrismaClient,
  children: readonly ChildTile[],
  now: Date,
  priority = SPLIT_PRIORITY,
): Promise<ChildQueueOutcome> {
  const outstanding = children.filter((child) => !isTileFresh(child, now));
  if (outstanding.length === 0) return { queued: [], waiting: [], exhausted: [], abandoned: [] };

  const jobs = await db.ingestJob.findMany({
    where: { dedupeKey: { in: outstanding.map((child) => tileJobKey(child.quadkey)) } },
    select: { dedupeKey: true, status: true },
  });
  const jobStatus = new Map(jobs.map((job) => [job.dedupeKey, job.status]));

  const outcome: ChildQueueOutcome = { queued: [], waiting: [], exhausted: [], abandoned: [] };

  for (const child of outstanding) {
    const status = jobStatus.get(tileJobKey(child.quadkey)) ?? null;
    if (status === JobStatus.queued || status === JobStatus.running) {
      outcome.waiting.push(child.quadkey);
      continue;
    }

    if (status === JobStatus.dead) {
      if (child.attempts >= SPLIT_CHILD_ATTEMPT_CAP) {
        outcome.abandoned.push(child.quadkey);
        continue;
      }
      outcome.exhausted.push(child.quadkey);
    }

    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey(child.quadkey),
      payload: { quadkey: child.quadkey },
      priority,
    });
    outcome.queued.push(child.quadkey);
  }

  return outcome;
}

/**
 * Promote `quadkey` from its children, then its own parent, and so on — innermost first,
 * stopping at the first tile that is not complete. A z11 finishing can make its z10 parent
 * ready, which can in turn make the z9 ready, and the z9 is the one a reader is polling.
 */
export async function promoteFrom(db: PrismaClient, quadkey: string): Promise<string[]> {
  const promoted: string[] = [];
  let key: string | null = quadkey;

  while (key !== null && key.length >= INGEST_ZOOM) {
    const settled = rollUp(await childTiles(db, key));
    if (!settled) break;

    await db.ingestTile.update({
      where: { quadkey: key },
      data: { ...settled, lastError: null },
    });
    promoted.push(key);
    key = parentQuadkey(key);
  }

  return promoted;
}

/** Promote every ancestor of a tile that has just finished. A no-op at `INGEST_ZOOM`. */
export async function rollUpAncestors(db: PrismaClient, quadkey: string): Promise<string[]> {
  const parent = parentQuadkey(quadkey);
  if (parent === null || parent.length < INGEST_ZOOM) return [];
  return promoteFrom(db, parent);
}

/** What the sweep did to one parent. `status` is what the row holds afterwards. */
export interface OrphanedSplitRepair {
  quadkey: string;
  status: TileStatus;
}

/**
 * How many marked parents the repair below would actually act on.
 *
 * The predicate is orphanhood — the marker *and* an incomplete set of children — not the marker
 * alone. A parent midway through a legitimate subdivision carries the marker for as long as its
 * four children take, and counting those as distress would make the health gauge read dozens of
 * wedged tiles on a system doing exactly what it should. `quadkey || '_'` is the child set: a
 * quadkey is digits `0`–`3`, so it carries no `LIKE` metacharacter of its own.
 */
export async function countOrphanedSplits(db: PrismaClient): Promise<number> {
  const [row] = await db.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count
      FROM ingest_tiles parent
     WHERE parent."lastError" LIKE ${`${SPLIT_MARKER_PREFIX}%`}
       AND (SELECT count(*) FROM ingest_tiles child
             WHERE child.quadkey LIKE parent.quadkey || '_') < ${CHILDREN_PER_TILE}
  `;
  return row?.count ?? 0;
}

/**
 * Clear the split marker from any parent whose children do not exist, and put it back on the
 * queue.
 *
 * A parent carrying the marker with no children on the ground is a row saying it was subdivided
 * when nothing of the subdivision remains. Six such rows are in production, written 2026-08-05
 * 21:03 to 2026-08-06 00:54 UTC by a build that was not merged until 2026-08-07 10:10; all 483
 * tile rows are z9 and those six parents have no descendants at all. Nothing else repairs them:
 * `promoteFrom` needs four children to read, `queueStaleChildren` needs children to queue, and
 * `processTile` only reaches its roll-up branch when `childTiles` returns four.
 *
 * **The split itself cannot leave this state**, and reading it as a crash window sends the next
 * reader hunting for one that does not exist. `splitTile` upserts all four children *before* it
 * writes the parent's marker, so a run that dies between the two leaves no marker at all. Marker
 * with no children is what a *later* deletion of the subtree leaves behind — which is what
 * production holds, having had its stranded z10 rows cleared after the splits completed. The
 * hazard to carry forward: anything that deletes a subtree must clear its parent's marker in the
 * same pass, or it wedges the parent exactly this way.
 *
 * That same ordering is why this is safe to run beside a live split rather than merely tidy after
 * a dead one: a split that has got as far as writing the marker has already written four
 * children, so `childTiles` returns four and the parent is left alone.
 *
 * The repair writes `status` and `lastError` and nothing else. `trailCount`, `fetchedAt`,
 * `fetchMs` and every trail, waypoint and photograph the tile has ever produced are untouched —
 * a parent that was serving data keeps serving it, and only a parent that has nothing to show
 * drops back to `pending`, which is what it honestly is.
 *
 * Idempotent: the predicate is the marker, which the repair removes, so a second pass over the
 * same rows finds nothing. `enqueue` dedupes on the tile's job key.
 */
export async function reconcileOrphanedSplits(
  db: PrismaClient,
  limit = 64,
): Promise<OrphanedSplitRepair[]> {
  const marked = await db.ingestTile.findMany({
    where: { lastError: { startsWith: SPLIT_MARKER_PREFIX } },
    select: { quadkey: true, status: true },
    take: limit,
  });
  if (marked.length === 0) return [];

  const repaired: OrphanedSplitRepair[] = [];
  for (const parent of marked) {
    const children = await childTiles(db, parent.quadkey);
    if (children.length === CHILDREN_PER_TILE) continue;

    const status = isTileSettled(parent.status) ? parent.status : TileStatus.pending;
    await db.ingestTile.update({
      where: { quadkey: parent.quadkey },
      data: { status, lastError: null },
    });
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey(parent.quadkey),
      payload: { quadkey: parent.quadkey },
      priority: SPLIT_PRIORITY,
    });
    repaired.push({ quadkey: parent.quadkey, status });
  }

  return repaired;
}

/** What `unsplitTile` took apart. */
export interface UnsplitResult {
  quadkey: string;
  /** Descendant tile rows deleted, at every depth below the parent. */
  descendantsRemoved: number;
  /** The status the parent was left in — its own if it had one worth keeping, else `pending`. */
  status: TileStatus;
}

/**
 * Undo a subdivision: delete the tile's descendants and put the parent back on the queue.
 *
 * `INGEST_SUBDIVIDE_MAX_ZOOM` stops *new* splits and nothing else. `processTile` routes any tile
 * with four children straight to the roll-up with no flag to read, so a tile already split stays
 * split however the ceiling is set, and lowering the ceiling is therefore not a rollback for
 * anything that has already happened. This is the rollback, and it exists in code because the
 * obvious manual version wedges the tile: deleting the subtree without clearing the parent's
 * marker leaves a row claiming a subdivision that is not there, which only
 * `reconcileOrphanedSplits` repairs and only on its own schedule.
 *
 * **Trails are not deleted with the tiles.** A trail belongs to the corpus, not to the tile that
 * fetched it, so the corpus survives this whether or not the parent's re-ingest completes. What is
 * lost is the record of which box fetched what, which nothing reads.
 *
 * **The parent is unlikely to complete.** A tile splits because it did not fit one invocation, so
 * with the ceiling down the re-queued parent runs out of clock again and `processTile` writes it
 * `failed` and throws to `dead`. That is the pre-subdivision state, restored faithfully enough to
 * include its failure. Callers reach for this when a split is the problem, not when the area is.
 *
 * Refuses while any descendant job is `running`. That job's handler would upsert its tile row back
 * after this deleted it — re-wedging the parent — and a lease is at most `LEASE_TIMEOUT_MS` old, so
 * waiting is a bounded instruction rather than an open one.
 *
 * Every read this depends on is taken **inside** the transaction, under `DRAIN_ADMISSION_KEY` —
 * the refusal count and the parent's own status alike. Every claim of a tile job is made under
 * that same lock, so a reading taken outside it dates from before the drain that is about to
 * start: the cron fires on a schedule the operator does not control, and `INGEST_MAX_DRAINERS=1`
 * narrows the window without closing it.
 */
export async function unsplitTile(db: PrismaClient, quadkey: string): Promise<UnsplitResult> {
  // One transaction, because a parent whose marker survives its children is precisely the wedged
  // state this exists to prevent. The parent's own status is read inside it for the same reason
  // the refusal count is: a drain admitted between an outside read and this write would have its
  // status silently overwritten by whatever was true beforehand.
  const { descendantsRemoved, status } = await db.$transaction(async (tx) => {
    await tx.$executeRaw`select pg_advisory_xact_lock(${DRAIN_ADMISSION_KEY})`;

    const parent = await tx.ingestTile.findUnique({
      where: { quadkey },
      select: { status: true },
    });
    if (!parent) throw new Error(`no ingest_tiles row for ${quadkey}`);
    const restored = isTileSettled(parent.status) ? parent.status : TileStatus.pending;

    // Quadkeys are hierarchical prefixes, so every descendant at every depth starts with the
    // parent's — which the parent itself also does, hence the exclusion.
    const descendants = await tx.ingestTile.findMany({
      where: { quadkey: { startsWith: quadkey }, NOT: { quadkey } },
      select: { quadkey: true },
    });
    const keys = descendants.map((tile) => tile.quadkey);
    const jobKeys = keys.map(tileJobKey);

    const running = await tx.ingestJob.count({
      where: { dedupeKey: { in: jobKeys }, status: JobStatus.running },
    });
    if (running > 0) {
      throw new Error(
        `${quadkey}: ${running} descendant job(s) still running. Wait for the lease to expire ` +
          `(at most ${Math.round(LEASE_TIMEOUT_MS / 60_000)} min) and run this again.`,
      );
    }

    await tx.ingestJob.deleteMany({ where: { dedupeKey: { in: jobKeys } } });
    await tx.ingestTile.deleteMany({ where: { quadkey: { in: keys } } });
    await tx.ingestTile.update({ where: { quadkey }, data: { status: restored, lastError: null } });
    return { descendantsRemoved: keys.length, status: restored };
  });

  await enqueue(db, {
    kind: JobKind.ingest_tile,
    dedupeKey: tileJobKey(quadkey),
    payload: { quadkey },
    priority: SPLIT_PRIORITY,
  });

  return { quadkey, descendantsRemoved, status };
}
