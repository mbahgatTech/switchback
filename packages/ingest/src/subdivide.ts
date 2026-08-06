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
import { isTileFresh, isTileSettled } from './freshness';
import { enqueue, tileJobKey } from './jobs';

/** How many children a quadkey has. Four, always — that is what "quad" means. */
export const CHILDREN_PER_TILE = 4;

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
 * The zoom past which a tile is failed rather than split. `INGEST_ZOOM` disables subdivision,
 * and that is what an absent or unusable variable returns: the two processes that drain
 * `ingest_jobs` do not both declare it — `apps/web/src/env.ts` has no entry — so a default of
 * `MAX_INGEST_ZOOM` turned subdivision on wherever nobody had thought about it. It has to be
 * switched on deliberately, which is also what makes deleting the setting a rollback.
 */
export function subdivideMaxZoom(source: NodeJS.ProcessEnv = process.env): number {
  const value = Number(source.INGEST_SUBDIVIDE_MAX_ZOOM);
  if (!Number.isInteger(value) || value < INGEST_ZOOM || value > MAX_INGEST_ZOOM) {
    return INGEST_ZOOM;
  }
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
 */
export async function splitTile(
  db: PrismaClient,
  quadkey: string,
  options: { previous: TileSnapshot; fetchMs?: number; priority?: number },
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

  await db.ingestTile.update({
    where: { quadkey },
    data: {
      status: servesData ? previous.status : TileStatus.pending,
      lastError: `split into ${children.length} tiles at z${quadkey.length + 1}`,
      ...(options.fetchMs === undefined ? {} : { fetchMs: options.fetchMs }),
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
 * **A `dead` child is revived, deliberately.** It is the only path back: `splitTile` enqueues each
 * child exactly once, `ensureCoverage` covers z9 alone, and `reclaimExpiredJobs` does not touch a
 * dead row. Before subdivision a viewport poll revived a dead z9 the same way, so this restores
 * the recovery the split had removed rather than inventing one.
 */
export async function queueStaleChildren(
  db: PrismaClient,
  children: readonly ChildTile[],
  now: Date,
  priority = SPLIT_PRIORITY,
): Promise<ChildQueueOutcome> {
  const outstanding = children.filter((child) => !isTileFresh(child, now));
  if (outstanding.length === 0) return { queued: [], waiting: [], exhausted: [] };

  const jobs = await db.ingestJob.findMany({
    where: { dedupeKey: { in: outstanding.map((child) => tileJobKey(child.quadkey)) } },
    select: { dedupeKey: true, status: true },
  });
  const jobStatus = new Map(jobs.map((job) => [job.dedupeKey, job.status]));

  const outcome: ChildQueueOutcome = { queued: [], waiting: [], exhausted: [] };

  for (const child of outstanding) {
    const status = jobStatus.get(tileJobKey(child.quadkey)) ?? null;
    if (status === JobStatus.queued || status === JobStatus.running) {
      outcome.waiting.push(child.quadkey);
      continue;
    }

    if (status === JobStatus.dead) outcome.exhausted.push(child.quadkey);
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
