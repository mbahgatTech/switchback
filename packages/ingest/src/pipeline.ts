/**
 * `processTile` — the whole lazy ingest, one z9 tile at a time. Idempotent upserts, per-trail
 * failure isolation and honest tile status; see `docs/architecture.md` for why each matters.
 */

import type { BBox, LngLat, LineString } from '@switchback/core';
import { deriveDisplayName } from '@switchback/core';
import {
  BACKGROUND_POOL_SIZE,
  JobKind,
  OsmElementType,
  PhotoSource,
  TileStatus,
  backgroundPrisma,
  mergeTrailGeometry,
  writeTrailGeometry,
  writeWaypointPoints,
} from '@switchback/db';
import { Prisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  INGEST_ZOOM,
  MAX_INGEST_ZOOM,
  bboxOf,
  lineLengthM,
  lngLatToTile,
  quadkeyToBBox,
  quadkeyToTile,
  resampleLine,
  simplifyLine,
  tileToQuadkey,
} from '@switchback/geo';
import { assembleTrails } from './assemble';
import type { AssembledTrail } from './assemble';
import { deriveTrail, slugify } from './derive';
import {
  attachWaypoints,
  featureSearchBBox,
  fetchSeedPhotos,
  parkingCapacity,
  synthesiseTrailhead,
  terminusFeatures,
} from './enrich';
import type { EnrichedWaypoint } from './enrich';
import { TerrainSource, elevateLine } from './elevate';
import { IngestDeadlineError, assertBefore } from './deadline';
import {
  OverpassDeadlineError,
  OverpassUnavailableError,
  buildFeatureQuery,
  buildParentRouteQuery,
  buildRegionQuery,
  buildRelationSkeletonQuery,
  buildRouteQuery,
  buildTileQuery,
  buildWayGeometryQuery,
} from './overpass';
import type { OverpassElement, OverpassQuerier, OverpassRelation } from './overpass';
import { enqueue, routeIngestJobKey, trailEnrichJobKey } from './jobs';
import {
  ClaimConflictError,
  canMergeTrails,
  claimWays,
  mergeTrails,
  resolveTrail as resolveClaims,
  trailIdentityMode,
} from './identity';
import type { ClaimPolicy, TrailIdentityMode } from './identity';
import {
  CHILDREN_PER_TILE,
  SPLIT_CHILD_ATTEMPT_CAP,
  SUBTREE_STUCK_MARKER,
  TILE_SPLIT_MARKER,
  canSubdivide,
  childTiles,
  promoteFrom,
  queueStaleChildren,
  rollUpAncestors,
  splitTile,
  subdivideMaxZoom,
} from './subdivide';
import type { ChildTile } from './subdivide';
import { Gate, forEachConcurrent } from './pool';

/** Resample interval for the elevation profile. Matches `ElevationProfile.spacingM`. */
const PROFILE_SPACING_M = 25;

/** Vertex tolerance for the copy every client renders. 5 m is invisible at z15. */
const RENDER_SIMPLIFY_M = 5;

/**
 * Ceilings that turn "long trail" into "trail we can store and draw". The Pacific Crest Trail
 * at 25 m spacing is 170,000 terrain samples and megabytes of `geometryJson` that `browse`
 * would return 300 of. A route past the ceiling gets a coarser profile and so understates its
 * climbing — `ElevationProfile.spacingM` records which spacing each trail actually got.
 */
const MAX_PROFILE_POINTS = 6_000;
const MAX_RENDER_VERTICES = 3_000;

/**
 * How many trails are committed at once, process-wide. The ceiling is not our CPU but the two
 * scarce resources underneath — `TerrainSource` caps its own fetches at six, and the ingest
 * holds `BACKGROUND_POOL_SIZE` connections less the four the queue's bookkeeping needs. On
 * quadkey 021231030 (144 trails): 490.5 s sequential, 88.0 s at six, 95.5 s at twelve. Raise
 * this only by raising `BACKGROUND_POOL_SIZE` and `TerrainSource.maxConcurrent` together.
 */
const COMMIT_CONCURRENCY = Math.max(1, Math.min(6, BACKGROUND_POOL_SIZE - 4));

/**
 * The ceiling above, enforced across drains rather than within one: three code paths start
 * drains, each guarded only against a second of its own kind, so all three can commit at once
 * while each obeys the six. Module-level so the resource sees one ceiling. Inside a single
 * drain it never blocks — the loop asks for exactly as many permits as exist.
 */
const commitGate = new Gate(COMMIT_CONCURRENCY);

/** Profile spacing for a trail of this length: 25 m until that would blow the point cap. */
function profileSpacingFor(lengthM: number): number {
  const ideal = PROFILE_SPACING_M;
  if (lengthM <= MAX_PROFILE_POINTS * ideal) return ideal;
  // Kept a multiple of 25 so the stored spacing stays a round number in the UI.
  return Math.ceil(lengthM / MAX_PROFILE_POINTS / ideal) * ideal;
}

/**
 * The rendered copy, coarsened until it fits. Douglas-Peucker takes a tolerance, not a vertex
 * count, and the relation between them depends on how wiggly the line is — so this asks rather
 * than predicts. Ordinary trails exit on the first pass at the 5 m tolerance.
 */
function renderGeometry(coords: readonly LngLat[]): LngLat[] {
  let toleranceM = RENDER_SIMPLIFY_M;
  let rendered = simplifyLine(coords, toleranceM);
  while (rendered.length > MAX_RENDER_VERTICES && toleranceM < 5_000) {
    toleranceM *= 4;
    rendered = simplifyLine(coords, toleranceM);
  }
  return rendered;
}

/** Re-exported from their own module so subdivision can ask the same question without a cycle. */
export { TILE_TTL_MS, isTileFresh, isTileSettled } from './freshness';

/**
 * The literal `switchback-ingest-overpass-skipped` greps for.
 *
 * Three of a tile's four Overpass queries fail soft — region, waypoints, parent routes — so a
 * budget that refuses them costs metadata silently: the tile still reaches `ready`, the request row
 * still reads success, and no job row records anything. This token is what makes the loss
 * countable, and it is why `lookupRegion` logs at all.
 */
export const OVERPASS_SKIPPED_MARKER = 'switchback-ingest-overpass-skipped';

/**
 * The literal an operator greps for when a tile could not commit a trail it had fetched.
 *
 * `switchback-ingest-drain-failed` reads it, and the split exit is why. On the failing exit the
 * tile rethrows and the worker logs `ingest-job-failed` beside this token, so the union counts one
 * window and the pair cannot page twice. On the split exit `splitTile` returns `pending` and
 * `failJob` never runs, so this token is the only thing marking the ground that did not commit.
 */
export const TRAIL_LOST_MARKER = 'switchback-ingest-trail-lost';

/** How many OSM ids the message names before it stops; the count beside them is always exact. */
const NAMED_TRAIL_LIMIT = 10;

/**
 * The sentence naming the trails a tile assembled and could not commit. A function because a
 * tile can run out of clock *and* lose a trail, and both exits have to carry the ids.
 */
function describeLost(quadkey: string, lost: readonly string[], assembled: number): string {
  const named = lost.slice(0, NAMED_TRAIL_LIMIT).join(', ');
  const rest = lost.length > NAMED_TRAIL_LIMIT ? `, +${lost.length - NAMED_TRAIL_LIMIT} more` : '';
  return `${TRAIL_LOST_MARKER} ${quadkey}: ${lost.length} of ${assembled} trail(s) did not commit: ${named}${rest}`;
}

export interface PipelineDeps {
  db?: PrismaClient;
  /** The shared client, or a `withDeadline` view of it — never a second client. */
  overpass: OverpassQuerier;
  /**
   * The same client for the phases that run *after* the commit loop, bounded only by
   * `deadlineAt`. `overpass` gives up early to leave the commit loop its reserve; a query that
   * runs once the commits are done has nothing left to reserve for, and gating it on that
   * deadline refuses work the invocation still has minutes to do. Defaults to `overpass`.
   */
  overpassAfterCommits?: OverpassQuerier;
  terrain?: TerrainSource;
  /**
   * Epoch milliseconds after which this handler stops doing work. Overpass has its own budget
   * (`withDeadline`); this is the outer bound covering terrain and the per-trail commits, so
   * the invocation ends on a caught error rather than on the host killing the process. Unset
   * on the Vercel path, where the platform's own timeout is the bound.
   */
  deadlineAt?: number;
  /**
   * Deepest zoom a tile may split to. Resolved once in `pipelineDeps` rather than read from
   * `process.env` here, so the value a process will actually use is visible at the seam and a
   * test can set it without touching the environment. `INGEST_ZOOM` disables subdivision.
   */
  subdivideMaxZoom?: number;
  /**
   * Whether a way-derived trail is identified by its `TrailWay` claims or by `(osmType, osmId)`.
   * Resolved once in `pipelineDeps` for the same reason as `subdivideMaxZoom`: the value a process
   * will actually use is visible at the seam, and a test can drive the claim path without setting
   * an environment variable.
   */
  trailIdentity?: TrailIdentityMode;
  now?: () => Date;
  mapillaryToken?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
  /** Set false in tests that only exercise geometry. */
  enrichWaypoints?: boolean;
  logger?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface ProcessTileResult {
  quadkey: string;
  status: TileStatus;
  trailCount: number;
  skipped: number;
  failed: number;
  fetchMs: number;
  /** The z+1 quadkeys this run put in play. Empty unless the tile is subdivided. */
  children: string[];
}

/**
 * Fetch, assemble and commit every trail in one tile. Returns rather than throws for the
 * ordinary failure modes — the caller is a job handler that records the outcome either way —
 * but throws when Overpass is unavailable, so the queue backs off instead of burning attempts.
 *
 * A tile that already has children is never fetched: subdivision has moved the work down a
 * level, so this becomes the roll-up — queue whatever child is stale, promote the parent once
 * all four are in. See `subdivide.ts`.
 */
export async function processTile(quadkey: string, deps: PipelineDeps): Promise<ProcessTileResult> {
  const db = deps.db ?? backgroundPrisma;
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? (() => {});
  const terrain = deps.terrain ?? new TerrainSource({ fetchImpl: deps.fetchImpl });
  const maxZoom = deps.subdivideMaxZoom ?? subdivideMaxZoom();
  const identity = deps.trailIdentity ?? trailIdentityMode();

  const tile = quadkeyToTile(quadkey);
  if (tile.z < INGEST_ZOOM || tile.z > MAX_INGEST_ZOOM) {
    throw new Error(
      `processTile expects a z${INGEST_ZOOM}-z${MAX_INGEST_ZOOM} quadkey, got z${tile.z} (${quadkey})`,
    );
  }
  const bbox = quadkeyToBBox(quadkey);
  const startedAt = Date.now();

  /*
   * Read before the `running` write below, because that write destroys the answer. Whether this
   * tile is already serving trails decides what a split leaves behind, and after the upsert every
   * tile looks like `running` — see `splitTile`, whose preservation was dead code for exactly as
   * long as it re-read the row itself.
   */
  const previous = await db.ingestTile.findUnique({
    where: { quadkey },
    select: { status: true, fetchedAt: true, lastError: true, trailCount: true },
  });

  const children = await childTiles(db, quadkey);
  if (children.length === CHILDREN_PER_TILE) {
    return rollUpSplitTile(db, quadkey, children, {
      now: now(),
      log,
      startedAt,
      lastError: previous?.lastError ?? null,
    });
  }

  await db.ingestTile.upsert({
    where: { quadkey },
    create: {
      quadkey,
      z: tile.z,
      x: tile.x,
      y: tile.y,
      status: TileStatus.running,
      bboxW: bbox[0],
      bboxS: bbox[1],
      bboxE: bbox[2],
      bboxN: bbox[3],
      attempts: 1,
    },
    update: { status: TileStatus.running, attempts: { increment: 1 } },
  });

  let elements: OverpassElement[];
  try {
    const response = await deps.overpass.query(buildTileQuery(bbox));
    elements = response.elements ?? [];
  } catch (error) {
    /*
     * Running out of clock on the tile query is the same verdict as running out of it in the
     * commit loop — the box is too big to serve — so it splits rather than fails. The two are
     * kept apart from every other Overpass error deliberately: a breaker that is open, a mirror
     * answering 504, a malformed query are all "come back later", and subdividing on those would
     * quadruple the load on a service that is already refusing.
     */
    if (error instanceof OverpassDeadlineError && canSubdivide(tile.z, maxZoom)) {
      const fetchMs = Date.now() - startedAt;
      const split = await splitTile(db, quadkey, { previous, fetchMs });
      log(`${TILE_SPLIT_MARKER} ${quadkey}: Overpass could not answer the tile query in time`, {
        quadkey,
        phase: 'tile query',
        children: split,
        fetchMs,
      });
      return {
        quadkey,
        status: TileStatus.pending,
        trailCount: 0,
        skipped: 0,
        failed: 0,
        fetchMs,
        children: split,
      };
    }

    const message = error instanceof Error ? error.message : String(error);
    await db.ingestTile.update({
      where: { quadkey },
      data: { status: TileStatus.failed, lastError: message.slice(0, 1000) },
    });
    // Breaker-open is not this tile's fault. Rethrow so the job retries later rather than
    // consuming an attempt on a service outage.
    if (error instanceof OverpassUnavailableError) throw error;
    throw error;
  }

  const assembled = assembleTrails(elements);
  log('assembled', { quadkey, elements: elements.length, trails: assembled.length });

  if (assembled.length === 0) {
    await db.ingestTile.update({
      where: { quadkey },
      data: {
        // `empty` rather than `ready` so the refresh sweep can skip ocean and desert
        // entirely instead of re-querying Overpass for them every month.
        status: TileStatus.empty,
        fetchedAt: now(),
        trailCount: 0,
        lastError: null,
        fetchMs: Date.now() - startedAt,
      },
    });
    await rollUpAncestors(db, quadkey);
    return {
      quadkey,
      status: TileStatus.empty,
      trailCount: 0,
      skipped: 0,
      failed: 0,
      fetchMs: Date.now() - startedAt,
      children: [],
    };
  }

  const region = await lookupRegion(bbox, deps);
  /**
   * Waypoints for the whole tile in one query rather than one per trail: forty trails would
   * be forty Overpass requests at two concurrent, for overlapping data. `attachWaypoints`
   * does the per-trail assignment locally.
   */
  let features: OverpassElement[] = [];
  if (deps.enrichWaypoints !== false) {
    try {
      const response = await deps.overpass.query(buildFeatureQuery(featureSearchBBox(bbox)));
      features = response.elements ?? [];
    } catch (error) {
      // Waypoints are decoration; a trail without them is still a trail.
      log(`${OVERPASS_SKIPPED_MARKER} features failed`, { quadkey, error: String(error) });
    }
  }

  let committed = 0;
  let skipped = 0;
  let failed = 0;
  /** Trails the deadline refused outright. The only count that justifies a split. */
  let refused = 0;
  /** OSM ids of trails that threw on their own account, so the failure can name them. */
  const lost: string[] = [];
  /*
   * Retiring a trail row is the one thing this pipeline does that no setting reverses, and a
   * refused union is the one thing that leaves a seam fragmented. Both are counted per tile so an
   * operator who turns `INGEST_TRAIL_IDENTITY` on can measure what it did.
   */
  const identityOutcomes = new Map<IdentityOutcome, number>();

  // The try lives here in the body rather than inside `forEachConcurrent`: a trail that
  // throws must cost its tile one row, not the rest of the tile.
  await forEachConcurrent(assembled, COMMIT_CONCURRENCY, async (trail) => {
    try {
      assertBefore(deps.deadlineAt, 'commit');
      const outcome = await commitGate.run(() =>
        commitTrail(db, trail, {
          quadkey,
          features,
          region,
          terrain,
          now: now(),
          identity,
          deadlineAt: deps.deadlineAt,
          onIdentity: (kind) => identityOutcomes.set(kind, (identityOutcomes.get(kind) ?? 0) + 1),
        }),
      );
      if (outcome === 'committed') committed += 1;
      else skipped += 1;
    } catch (error) {
      if (error instanceof IngestDeadlineError) refused += 1;
      else lost.push(`${trail.osmType}/${trail.osmId}`);
      failed += 1;
      log('trail failed', {
        quadkey,
        osm: `${trail.osmType}/${trail.osmId}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  if (identityOutcomes.size > 0) {
    log('identity resolved', { quadkey, ...Object.fromEntries(identityOutcomes) });
  }

  /*
   * The per-trail catch above is what keeps one bad trail from costing its tile, and it
   * swallows the deadline too — so re-check it here and decide deliberately.
   *
   * The clock alone is not the test, and `failed` is not either. `forEachConcurrent` visits
   * every trail, so a tile is only short of work when the deadline *refused* one: a tile whose
   * last commit landed a millisecond late is finished, and splitting it would discard the
   * `ready` write and queue four children to redo work already in `trails`. `refused` counts
   * only `IngestDeadlineError`, so a trail that threw for its own reasons costs its row and
   * nothing else — as it always did.
   *
   * Running out of clock with trails unattempted is what "this tile is too big" looks like from
   * inside, so this is where subdivision is triggered rather than at the top: nothing before
   * the commit loop knows how much of the handler's budget a tile will want. Below the zoom
   * floor there is nowhere left to go, so the tile fails as it always did.
   */
  if (refused > 0) {
    const fetchMs = Date.now() - startedAt;
    /*
     * The clock decides this tile's fate — it is what says the box is too big — but a tile can
     * run out of clock *and* lose a trail on its own account, and the ids have to survive that.
     * Without this the one tile that hit both failures is the only one whose missing ground is
     * invisible, because the branch below never runs for it.
     */
    const alsoLost = lost.length > 0 ? ` — ${describeLost(quadkey, lost, assembled.length)}` : '';

    if (canSubdivide(tile.z, maxZoom)) {
      /*
       * `splitTile`'s write is the last one this path makes to the parent, and it returns rather
       * than throwing — so `failJob` never runs and an id that reaches only the log line reaches
       * no row an operator can query. `trailCount` goes with it because a split parent that
       * committed nothing reads as holding nothing, which puts it in `ensureCoverage`'s pending
       * set and makes the client poll it every 2.5 s until the last child lands.
       */
      const split = await splitTile(db, quadkey, {
        previous,
        fetchMs,
        lostNote: alsoLost,
        trailCount: Math.max(committed, previous?.trailCount ?? 0),
      });
      log(
        `${TILE_SPLIT_MARKER} ${quadkey}: ran out of clock with ${refused} trail(s) unattempted${alsoLost}`,
        {
          quadkey,
          phase: 'commit',
          committed,
          skipped,
          failed,
          refused,
          lost,
          children: split,
          fetchMs,
        },
      );
      return {
        quadkey,
        status: TileStatus.pending,
        trailCount: committed,
        skipped,
        failed,
        fetchMs,
        children: split,
      };
    }

    const error = new IngestDeadlineError('tile', Date.now() - deps.deadlineAt!, alsoLost);
    await db.ingestTile.update({
      where: { quadkey },
      data: {
        status: TileStatus.failed,
        trailCount: Math.max(committed, previous?.trailCount ?? 0),
        lastError: error.message.slice(0, 1000),
      },
    });
    log(error.message, { quadkey, committed, skipped, failed, refused, lost, fetchMs });
    throw error;
  }

  const fetchMs = Date.now() - startedAt;

  /*
   * A trail that threw is ground this tile was responsible for and does not have, so the tile
   * does not get to say `ready`. That status plus `fetchedAt` is what `isTileFresh` sells to
   * `ensureCoverage`, and writing it here bought `TILE_TTL_MS` of silence over a hole: tile
   * 1202212023 reached `ready` with `trailCount=900` and `lastError="6 trail(s) failed to
   * commit"`, and four of the six had no row in `trails` at all. Nothing read that `lastError` —
   * the heartbeat's gauges match `'429'` and `SUBTREE_STUCK_MARKER`, neither of which it is.
   *
   * **Rethrowing is the requeue, and the ladder is the bound.** `failJob` puts the row back with
   * a backoff of 30 s, 2 m, 10 m, 30 m and buries it `dead` on the fifth failure, roughly 43
   * minutes in. `queueHealth` counts it there and `ensureCoverage` stops queueing and stops
   * reporting it pending, so a tile that fails every time costs five runs and then nothing.
   *
   * **Priced on the unit that re-runs, which is a whole ~900-trail tile.** Over the trailing
   * seven days to 2026-08-09T10:47Z production logged 30 non-deadline `trail failed` lines, but
   * one invocation logs one line per trail: they collapse to **10 tile-invocations over 10
   * distinct tiles**, against 14,040 deadline refusals. Ten failing tiles a week at five runs
   * each is the ceiling. That is a cost this pays for the first time — the `ready` write it
   * replaces suppressed every re-run for `TILE_TTL_MS`, so the measured 10 is a count of *first*
   * failures and prices the old behaviour, not this one. A per-trail job was the alternative and
   * is the same work with a new `JobKind`: the geometry is not on the row, so the job would
   * re-run the tile query to get it back.
   *
   * `refused` is zero here — the branch above owns the mixed tile. `skipped` is deliberate — no
   * terrain under the line, a relation another tile owns — and leaves the tile's ground covered.
   */
  if (failed > 0) {
    const message = describeLost(quadkey, lost, assembled.length);
    const error = new Error(message);
    await db.ingestTile.update({
      where: { quadkey },
      data: {
        status: TileStatus.failed,
        // Commits are upserts and this path deletes nothing, so the row must not claim fewer
        // trails than the tile already had drawn. `ensureCoverage` reads this to tell a tile
        // holding most of its ground from one holding none.
        trailCount: Math.max(committed, previous?.trailCount ?? 0),
        lastError: message.slice(0, 1000),
      },
    });
    log(error.message, { quadkey, committed, skipped, failed, fetchMs });
    throw error;
  }

  await db.ingestTile.update({
    where: { quadkey },
    data: {
      status: TileStatus.ready,
      fetchedAt: now(),
      trailCount: committed,
      lastError: null,
      fetchMs,
    },
  });

  await discoverParentRoutes(db, assembled, deps);
  await rollUpAncestors(db, quadkey);

  return {
    quadkey,
    status: TileStatus.ready,
    trailCount: committed,
    skipped,
    failed,
    fetchMs,
    children: [],
  };
}

/**
 * The parent's account of a subtree that is not moving, or null while every child still is.
 *
 * The marker leads the text because `queueHealth`'s `stuckSubtrees` gauge counts
 * `ingest_tiles.lastError` containing it, and a message carrying the marker only in the log left
 * that gauge reading zero over a wedged subtree.
 */
function describeStalledSubtree(
  quadkey: string,
  exhausted: readonly string[],
  abandoned: readonly string[],
): string | null {
  const clauses: string[] = [];
  // Named apart because they are different instructions: an exhausted child is back on the queue,
  // an abandoned one is past the cap and no automatic path will touch it again.
  if (abandoned.length > 0) {
    clauses.push(`abandoned after ${SPLIT_CHILD_ATTEMPT_CAP} runs: ${abandoned.join(', ')}`);
  }
  if (exhausted.length > 0) {
    clauses.push(`requeued after five failures: ${exhausted.join(', ')}`);
  }
  if (clauses.length === 0) return null;
  return `${SUBTREE_STUCK_MARKER} ${quadkey}: blocked by descendant(s) — ${clauses.join('; ')}`.slice(
    0,
    1000,
  );
}

/**
 * A tile that has been subdivided, revisited. It fetches nothing: the children own the ground
 * now, so all this does is put back whatever child has gone stale and promote the parent once
 * all four are in. Cheap by design — every viewport over a split tile lands here, because
 * `ensureCoverage` still queues the z9 parent and knows nothing about the split.
 */
async function rollUpSplitTile(
  db: PrismaClient,
  quadkey: string,
  children: readonly ChildTile[],
  context: {
    now: Date;
    log: (message: string, detail?: Record<string, unknown>) => void;
    startedAt: number;
    /** The parent's stored `lastError`, which is what makes the report below edge-triggered. */
    lastError: string | null;
  },
): Promise<ProcessTileResult> {
  const { queued, waiting, exhausted, abandoned } = await queueStaleChildren(
    db,
    children,
    context.now,
  );
  const promoted = await promoteFrom(db, quadkey);
  const settled = promoted.includes(quadkey);

  /*
   * A descendant that is not moving is the one state nothing else reports: `ingest-job-failed`
   * names the leaf, and the z9 a reader is actually polling stays `pending` with nothing said
   * about it.
   *
   * A parent with an abandoned child is **held, not promoted and not failed**: `rollUp` needs all
   * four children settled, so it will not report an area complete with a quarter of it missing,
   * and the trails the parent did commit stay on the row. `unsplitTile` is the way back.
   *
   * Written once per transition, not once per drain. A blocked parent is `pending`, so
   * `ensureCoverage` re-queues it on every viewport poll and `explore.tsx` polls *because* it is
   * pending — a line per drain would page every fifteen minutes for as long as anyone left that
   * map open, on the same rule as the genuine failure signal. The parent's stored `lastError` is
   * the edge, and it survives a restart where a module-level flag would not. Clearing it is
   * `promoteFrom`'s job, which nulls it the moment the roll-up lands.
   */
  const stalled = describeStalledSubtree(quadkey, exhausted, abandoned);
  if (stalled !== null && !settled && stalled !== context.lastError) {
    context.log(stalled, {
      quadkey,
      exhausted,
      abandoned,
      // Whether anything else is still moving is the difference between "wait" and "intervene".
      queued,
      waiting,
    });
    await db.ingestTile.update({ where: { quadkey }, data: { lastError: stalled } });
  }

  return {
    quadkey,
    status: settled ? TileStatus.ready : TileStatus.pending,
    trailCount: children.reduce((sum, child) => sum + child.trailCount, 0),
    skipped: 0,
    failed: 0,
    fetchMs: Date.now() - context.startedAt,
    children: children.map((child) => child.quadkey),
  };
}

/**
 * Queue the long-distance routes this tile's trails turn out to be pieces of. Runs after the
 * tile is marked ready and swallows its own failures: it is strictly additive, and marking
 * the tile failed would re-run the expensive half to retry the cheap half.
 *
 * Uses `overpassAfterCommits` because it runs past the commit loop the ordinary Overpass deadline
 * reserves clock for. Measured on the deployed budget: five of five invocations that reached here
 * on 2026-08-08 between 22:34 and 22:48 UTC were refused, at 181, 207, 214, 249 and 253 s into a
 * handler bounded at 540 s.
 */
async function discoverParentRoutes(
  db: PrismaClient,
  assembled: readonly AssembledTrail[],
  deps: PipelineDeps,
): Promise<void> {
  const log = deps.logger ?? (() => {});
  const relationIds = assembled.filter((t) => t.osmType === 'relation').map((t) => t.osmId);
  if (relationIds.length === 0) return;

  const overpass = deps.overpassAfterCommits ?? deps.overpass;
  try {
    const response = await overpass.query(buildParentRouteQuery(relationIds));
    const parents = (response.elements ?? []).filter(
      (element): element is OverpassRelation => element.type === 'relation',
    );

    for (const parent of parents) {
      // `type=superroute` means "this relation's members are routes". A plain `type=route`
      // parent is a section container tiles already ingest by bbox.
      if (parent.tags?.type !== 'superroute') continue;
      if (!(parent.tags.name ?? parent.tags['name:en'])) continue;

      await enqueue(db, {
        kind: JobKind.ingest_route,
        dedupeKey: routeIngestJobKey(parent.id),
        payload: { osmId: parent.id },
        // Below tile work: somebody is waiting on the tile under their cursor, nobody is
        // waiting on a continental route, and it is the most expensive job we run.
        priority: -10,
      });
      log('queued route', { osmId: parent.id, name: parent.tags.name });
    }
  } catch (error) {
    log(`${OVERPASS_SKIPPED_MARKER} parent route lookup failed`, { error: String(error) });
  }
}

/** How deep a superroute hierarchy is followed before we stop expanding member relations. */
const MAX_ROUTE_DEPTH = 3;

/**
 * How many route relations are asked for in one Overpass request. Feasibility, not politeness:
 * `out body geom` on all 31 PCT sections is ~400,000 inline node coordinates down one socket,
 * which dies as a transport-level `fetch failed` with no status. Four sections is ~500 km and
 * arrives well inside the client's abort window.
 */
const ROUTE_BATCH_SIZE = 4;

/**
 * Fetch route relations by id, halving the batch whenever a request fails. A fixed stride
 * cannot be right: `[timeout:180]` is a promise about Overpass's own execution and says
 * nothing about the reverse proxy in front of a mirror, one of which gives up at ~38 s with a
 * 504. Halving turns that cliff into a slope, bottoming out at a single id.
 *
 * **It throws rather than skipping.** A Pacific Crest Trail quietly missing 300 km still
 * renders, still looks finished, and lies about its length. A route that fails to assemble
 * leaves the previous data in place and the job retryable.
 */
async function fetchRelations(
  ids: readonly number[],
  deps: PipelineDeps,
  log: (message: string, fields?: Record<string, unknown>) => void,
  depth: number,
): Promise<OverpassRelation[]> {
  const found: OverpassRelation[] = [];

  const take = async (batch: readonly number[]): Promise<void> => {
    try {
      const response = await deps.overpass.query(buildRouteQuery(batch));
      for (const element of response.elements ?? []) {
        if (element.type === 'relation') found.push(element);
      }
      log('route batch', { depth, ids: batch.length, found: found.length });
    } catch (error) {
      if (batch.length === 1) {
        // Below a relation there is a smaller unit — its ways — so this continues the
        // halving rather than switching strategy.
        found.push(await fetchRelationInParts(batch[0]!, deps, log, depth, error));
        return;
      }
      const middle = Math.ceil(batch.length / 2);
      log('route batch split', { depth, ids: batch.length, error: String(error) });
      await take(batch.slice(0, middle));
      await take(batch.slice(middle));
    }
  };

  for (let i = 0; i < ids.length; i += ROUTE_BATCH_SIZE) {
    await take(ids.slice(i, i + ROUTE_BATCH_SIZE));
  }
  return found;
}

/**
 * How many way geometries are asked for in one request. The unit below a relation: a PCT
 * section is on the order of a thousand ways, so 250 is four or five requests per section.
 */
const WAY_GEOMETRY_BATCH_SIZE = 250;

/**
 * Rebuild one relation from a skeleton plus its ways, when no mirror will serve it whole.
 * The result is spliced back into the members and is structurally identical to what `out body
 * geom` would have returned, so `assembleTrails` needs no second code path.
 *
 * **A missing way is fatal, deliberately.** A route that assembles from most of its parts
 * renders and lies about its length; throwing leaves the previous data alone and the job
 * retryable.
 */
async function fetchRelationInParts(
  id: number,
  deps: PipelineDeps,
  log: (message: string, fields?: Record<string, unknown>) => void,
  depth: number,
  cause: unknown,
): Promise<OverpassRelation> {
  log('route relation too large, fetching in parts', { depth, id, error: String(cause) });

  const skeleton = await deps.overpass
    .query(buildRelationSkeletonQuery([id]))
    .catch((error: unknown) => {
      // The member list is the cheapest thing we ask any mirror for, so a failure here is
      // not about size — report the original, more informative error.
      log('route skeleton failed', { depth, id, error: String(error) });
      throw cause;
    });

  const relation = skeleton.elements?.find(
    (element): element is OverpassRelation => element.type === 'relation' && element.id === id,
  );
  if (!relation) throw cause;

  const wayIds = (relation.members ?? [])
    .filter((member) => member.type === 'way')
    .map((member) => member.ref);
  const unique = [...new Set(wayIds)];

  const geometries = await fetchWayGeometries(unique, deps, log, depth, id);

  for (const member of relation.members ?? []) {
    if (member.type !== 'way') continue;
    const geometry = geometries.get(member.ref);
    if (!geometry) {
      log('route way missing geometry', { depth, id, way: member.ref });
      throw cause;
    }
    member.geometry = geometry;
  }

  log('route relation rebuilt', { depth, id, ways: unique.length });
  return relation;
}

/**
 * Way geometry for one relation, halving on failure exactly as `fetchRelations` does — 250
 * ways through a dense stretch is a much bigger response than through open desert, and the
 * mirror answers 504. Below a way there is nothing smaller to ask for, so a single-way request
 * that still fails throws, keeping the guarantee that a route is committed whole or not at all.
 * The escaping error is the way-level one, which names the request that actually failed.
 */
export async function fetchWayGeometries(
  ids: readonly number[],
  deps: PipelineDeps,
  log: (message: string, fields?: Record<string, unknown>) => void,
  depth: number,
  id: number,
): Promise<Map<number, Array<{ lat: number; lon: number }>>> {
  const geometries = new Map<number, Array<{ lat: number; lon: number }>>();

  const take = async (batch: readonly number[]): Promise<void> => {
    try {
      const response = await deps.overpass.query(buildWayGeometryQuery(batch));
      for (const element of response.elements ?? []) {
        if (element.type === 'way' && element.geometry) {
          geometries.set(element.id, element.geometry);
        }
      }
      log('route way batch', { depth, id, ways: geometries.size, of: ids.length });
    } catch (error) {
      if (batch.length === 1) throw error;
      const middle = Math.ceil(batch.length / 2);
      log('route way batch split', { depth, id, ways: batch.length, error: String(error) });
      await take(batch.slice(0, middle));
      await take(batch.slice(middle));
    }
  };

  for (let i = 0; i < ids.length; i += WAY_GEOMETRY_BATCH_SIZE) {
    await take(ids.slice(i, i + WAY_GEOMETRY_BATCH_SIZE));
  }
  return geometries;
}

export interface ProcessRouteResult {
  osmId: number;
  name: string | null;
  status: 'committed' | 'skipped' | 'not_found';
  lengthM: number;
  fetchMs: number;
}

/**
 * Ingest one long-distance route whole, by relation id rather than by area — a bbox query
 * never recurses into member relations, so no tile can see the Pacific Crest Trail itself,
 * only its sections, and the product insists the PCT is 111 km long. See
 * `docs/architecture.md`. The flattened member list goes to the ordinary assembler as one
 * synthetic relation, so chaining and orientation stay a single code path.
 */
export async function processRoute(osmId: number, deps: PipelineDeps): Promise<ProcessRouteResult> {
  const db = deps.db ?? backgroundPrisma;
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? (() => {});
  const terrain = deps.terrain ?? new TerrainSource({ fetchImpl: deps.fetchImpl });
  const startedAt = Date.now();

  const byId = new Map<number, OverpassRelation>();
  let frontier = [osmId];

  for (let depth = 0; depth < MAX_ROUTE_DEPTH && frontier.length > 0; depth += 1) {
    const wanted = frontier.filter((id) => !byId.has(id));
    if (wanted.length === 0) break;

    const next: number[] = [];
    for (const relation of await fetchRelations(wanted, deps, log, depth)) {
      byId.set(relation.id, relation);
      for (const member of relation.members ?? []) {
        if (member.type === 'relation') next.push(member.ref);
      }
    }
    frontier = next;
  }

  const root = byId.get(osmId);
  if (!root) {
    return { osmId, name: null, status: 'not_found', lengthM: 0, fetchMs: Date.now() - startedAt };
  }

  const name = root.tags?.name ?? root.tags?.['name:en'] ?? null;
  if (!name) {
    return { osmId, name: null, status: 'skipped', lengthM: 0, fetchMs: Date.now() - startedAt };
  }

  /**
   * Flatten the hierarchy into one member list, in the order the relations declare. Order is
   * the whole point: the assembler chains by matching endpoints, and a shuffled member list
   * becomes a hundred disjoint lines of which it keeps the longest.
   */
  const members: OverpassRelation['members'] = [];
  const seen = new Set<number>();
  const flatten = (relation: OverpassRelation, depth: number): void => {
    if (depth > MAX_ROUTE_DEPTH || seen.has(relation.id)) return;
    seen.add(relation.id);
    for (const member of relation.members ?? []) {
      if (member.type === 'way') {
        members.push(member);
      } else if (member.type === 'relation') {
        const child = byId.get(member.ref);
        if (child) flatten(child, depth + 1);
      }
    }
  };
  flatten(root, 0);

  if (members.length === 0) {
    return { osmId, name, status: 'skipped', lengthM: 0, fetchMs: Date.now() - startedAt };
  }

  // Sections abut rather than overlap, and the join is where one mapper's way ends and
  // another's begins — reliably within a few hundred metres. Tighter and the PCT arrives
  // in 31 pieces.
  const [assembled] = assembleTrails([{ ...root, members }], { gapToleranceM: 2_000 });
  if (!assembled) {
    return { osmId, name, status: 'skipped', lengthM: 0, fetchMs: Date.now() - startedAt };
  }

  const [w, s, e, n] = assembled.bbox;
  const region = await lookupRegion([w, s, e, n], deps);
  const start = assembled.coords[0] ?? [(w + e) / 2, (s + n) / 2];
  const quadkey = tileToQuadkey(lngLatToTile(start[0], start[1], INGEST_ZOOM));

  // No waypoint query: `buildFeatureQuery` over a Mexico-to-Canada bbox would ask a public
  // Overpass instance for every gate and viewpoint in the western United States.
  const outcome = await commitTrail(db, assembled, {
    quadkey,
    features: [],
    region,
    terrain,
    now: now(),
    identity: deps.trailIdentity ?? trailIdentityMode(),
    deadlineAt: deps.deadlineAt,
  });

  const fetchMs = Date.now() - startedAt;
  log('route ingested', {
    osmId,
    name,
    km: Math.round(assembled.lengthM / 1000),
    sections: seen.size,
    outcome,
  });
  return { osmId, name, status: outcome, lengthM: assembled.lengthM, fetchMs };
}

interface CommitContext {
  quadkey: string;
  features: readonly OverpassElement[];
  region: RegionInfo;
  terrain: TerrainSource;
  now: Date;
  identity: TrailIdentityMode;
  deadlineAt?: number;
  onIdentity?: (outcome: IdentityOutcome) => void;
}

/**
 * The line this commit should derive from, and the row it belongs to. Null when the trail is
 * already accounted for and this tile's copy adds nothing.
 */
interface ResolvedTrail {
  trailId: string | null;
  retiredIds: string[];
  claim: ClaimPolicy;
  conceded: readonly number[];
  coords: LngLat[];
  bbox: BBox;
  lengthM: number;
}

/** What claim resolution did with one assembly, counted per tile so the flag is measurable. */
export type IdentityOutcome =
  'adopted' | 'merged' | 'refused-geometry' | 'refused-review' | 'yielded-to-relation';

/**
 * Settle identity and geometry before anything expensive runs.
 *
 * The union has to happen here, not at the write: every stat, the elevation profile and each
 * waypoint's `distM` are computed from the coordinate array further down, so a merge applied at
 * the end would leave all of them describing one fragment of the trail.
 *
 * A resolution the geometry refuses is abandoned whole rather than half-applied. The assembly
 * keeps its own row, its own line and its own free ways, which is what the `osm-id` default would
 * have given it — adopting a winner whose line cannot contain this one would store the incoming
 * geometry nowhere while claiming the ways it was drawn from.
 */
async function resolveIdentity(
  db: PrismaClient,
  trail: AssembledTrail,
  mode: TrailIdentityMode,
  report: (outcome: IdentityOutcome) => void,
): Promise<ResolvedTrail | null> {
  const fallback: ResolvedTrail = {
    trailId: null,
    retiredIds: [],
    claim: 'fail',
    conceded: [],
    coords: trail.coords,
    bbox: trail.bbox,
    lengthM: trail.lengthM,
  };
  if (mode !== 'claim') return fallback;

  const resolution = await resolveClaims(db, {
    osmType: trail.osmType,
    name: trail.name,
    memberWayIds: trail.memberWayIds,
  });
  if (resolution.kind === 'skip') return null;

  const conceded = resolution.conceded;
  if (resolution.kind === 'create') {
    if (conceded.length > 0) report('yielded-to-relation');
    return { ...fallback, claim: resolution.claim, conceded };
  }

  /*
   * Settled before the union, because the union is computed over whatever it is told to absorb.
   * A merge refused here has to stand down whole: retiring nothing while still unioning the
   * losers in would leave the winner holding line that the losers' own rows still serve, and
   * every stat, the profile and each waypoint's `distM` are derived from these coordinates.
   */
  if (
    resolution.kind === 'merge' &&
    !(await canMergeTrails(db, resolution.trailId, resolution.retiredIds))
  ) {
    report('refused-review');
    return { ...fallback, conceded };
  }
  const retiredIds = resolution.kind === 'merge' ? resolution.retiredIds : [];

  const merged = await mergeTrailGeometry(db, {
    trailId: resolution.trailId,
    // Exactly the lines that are about to be retired, so `unioned` is also the proof that
    // retiring them keeps their geometry: a loser the union cannot absorb makes the result branch.
    alsoTrailIds: retiredIds,
    incoming: { type: 'LineString', coordinates: [...trail.coords] },
  });
  // The winner was deleted between the claim read and here. Drop the whole resolution rather
  // than keep half of it, and let the `(osmType, osmId)` upsert give this assembly a row.
  if (!merged) return { ...fallback, conceded };

  // One line cannot hold a fork, a lollipop or two halves that do not touch. Standing down here
  // leaves both shapes stored under their own rows, fragmented exactly as `osm-id` leaves them —
  // one trail unrepresented is a worse corpus than two rows that each hold their own geometry.
  if (!merged.unioned) {
    report('refused-geometry');
    return { ...fallback, conceded };
  }

  report(retiredIds.length > 0 ? 'merged' : 'adopted');

  return {
    trailId: resolution.trailId,
    retiredIds,
    claim: resolution.claim,
    conceded,
    coords: merged.coords,
    bbox: bboxOf(merged.coords),
    // Measured here rather than taken off PostGIS: `lineLengthM` is what the assembler and
    // `deriveDisplayName` use, and a trail must not change length by 0.3% because a second tile
    // touched it.
    lengthM: lineLengthM(merged.coords),
  };
}

/**
 * Attempts a trail gets when it loses a race for the ways it is made of. Each one re-reads the
 * claims, so a second pass sees the winner the first pass collided with and adopts it. Two, not
 * more: a third would be re-running a full elevation pass on a contention that is already rare.
 */
const MAX_CLAIM_ATTEMPTS = 2;

/**
 * One trail, committed or skipped. Retried when another committer claims a way underneath this
 * one — that conflict invalidates the resolution the line and every derived stat were built from,
 * so the whole commit is re-run rather than the transaction alone. A trail that loses twice
 * concedes: the ways belong to the winner, and this tile's copy of them is a fragment of it.
 */
async function commitTrail(
  db: PrismaClient,
  trail: AssembledTrail,
  ctx: CommitContext,
): Promise<'committed' | 'skipped'> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attemptCommit(db, trail, ctx);
    } catch (error) {
      if (!(error instanceof ClaimConflictError)) throw error;
      if (attempt >= MAX_CLAIM_ATTEMPTS) return 'skipped';
    }
  }
}

/**
 * The transaction covers the trail row, its geometry, its profile and its waypoints: a trail row
 * whose `geom` write failed is invisible to every spatial query while still appearing in search,
 * and nothing about it looks broken.
 */
async function attemptCommit(
  db: PrismaClient,
  trail: AssembledTrail,
  ctx: CommitContext,
): Promise<'committed' | 'skipped'> {
  const resolved = await resolveIdentity(db, trail, ctx.identity, ctx.onIdentity ?? (() => {}));
  if (!resolved) return 'skipped';

  const spacingM = profileSpacingFor(resolved.lengthM);
  const resampled = resampleLine(resolved.coords, spacingM);
  if (resampled.length < 2) return 'skipped';

  /*
   * `alongLengthM` is not an optimisation. A capped profile resamples the PCT at 725 m, and
   * the straight lines between samples skip every switchback: measured that way it comes out
   * at 3,214 km instead of 4,221. Handing the true along-line length down keeps the sample
   * distances — and every stat, axis and weather point derived from them — exact.
   */
  const { points, gapCount } = await elevateLine(resampled, ctx.terrain, {
    spacingM,
    alongLengthM: resolved.lengthM,
    deadlineAt: ctx.deadlineAt,
  });

  // An all-gap profile means every terrain tile under this line failed or does not exist.
  // Storing it would publish a flat sea-level trail with zero gain, which reads as fact.
  if (gapCount === points.length) return 'skipped';

  const derived = deriveTrail({
    coords: resolved.coords,
    profile: points,
    bbox: resolved.bbox,
    tags: trail.tags,
    // Read off the un-oriented line, before `deriveTrail` may flip it — see
    // `terminusFeatures` for why that is safe.
    termini: ctx.features.length ? terminusFeatures(resolved.coords, ctx.features) : undefined,
  });

  // `derived.coords` and `derived.profile`, never `trail.coords` and `points`. OSM stores
  // about half of all point-to-point paths running downhill and `deriveTrail` flips those,
  // so the drawn line, the chart and the waypoint distances must all agree with the stats.
  const oriented = derived.coords;
  const profile = [...derived.profile];

  const waypoints = ctx.features.length ? attachWaypoints(oriented, ctx.features) : [];
  const trailhead = synthesiseTrailhead(oriented);
  const allWaypoints = trailhead ? [trailhead, ...waypoints] : waypoints;
  // Elevations are resolved once here rather than inside the insert below, because the display
  // name is derived from the same numbers and the two must not be allowed to disagree.
  const placed = allWaypoints.map((waypoint) => ({
    ...waypoint,
    eleM: elevationAt(profile, waypoint),
  }));

  // Guarded like `waypoints` and `termini` above: a failed feature query is indistinguishable
  // here from a trail with nothing near it, and deriving null from no evidence would write
  // that null over a good title on re-ingest — dragging the search vector with it.
  const displayName = ctx.features.length
    ? deriveDisplayName({
        name: trail.name,
        routeType: derived.routeType,
        lengthM: derived.stats.lengthM,
        lineLengthM: lineLengthM(oriented),
        gainM: derived.stats.gainM,
        minEleM: derived.stats.minEleM,
        maxEleM: derived.stats.maxEleM,
        waypoints: placed,
      })
    : undefined;

  const geometry: LineString = { type: 'LineString', coordinates: [...oriented] };
  const rendered = renderGeometry(oriented);
  const osmType = trail.osmType === 'relation' ? OsmElementType.relation : OsmElementType.way;
  const osmId = BigInt(trail.osmId);

  const trailId = await commitWithSlugRetry(db, async (tx) => {
    if (resolved.trailId && resolved.retiredIds.length > 0) {
      await mergeTrails(tx, resolved.trailId, resolved.retiredIds);
    }

    const slug = await uniqueSlug(tx, trail.name, ctx.region.regionName, osmType, osmId);

    const row = {
      slug,
      name: trail.name,
      displayName,
      description: derived.description,
      regionName: ctx.region.regionName,
      countryCode: ctx.region.countryCode,
      osmType,
      osmId,
      sourceUpdatedAt: ctx.now,
      quadkey: ctx.quadkey,
      geometryJson: { type: 'LineString', coordinates: rendered } as Prisma.InputJsonValue,
      centroidLng: derived.centroid[0],
      centroidLat: derived.centroid[1],
      bboxW: derived.bbox[0],
      bboxS: derived.bbox[1],
      bboxE: derived.bbox[2],
      bboxN: derived.bbox[3],
      lengthM: derived.stats.lengthM,
      gainM: derived.stats.gainM,
      lossM: derived.stats.lossM,
      minEleM: derived.stats.minEleM,
      maxEleM: derived.stats.maxEleM,
      maxSustainedGrade: derived.stats.maxSustainedGrade,
      estimatedTimeS: derived.stats.estimatedTimeS,
      difficulty: derived.difficulty,
      difficultyScore: derived.difficultyScore,
      routeType: derived.routeType,
      activityTypes: derived.activityTypes,
      surface: derived.surface,
      sacScale: derived.sacScale,
      dogsAllowed: derived.dogsAllowed,
      wheelchairAccessible: derived.wheelchairAccessible,
      feeRequired: derived.feeRequired,
      parkingCapacity: parkingCapacity(allWaypoints),
    };

    // `osmType`/`osmId` are never rewritten on an existing row. For a way-derived trail they are
    // one member id out of many, and moving them would shift the unique key a concurrent tile is
    // upserting against — `TrailWay` is the identity now, not `min(wayId)`.
    //
    // `quadkey` is held for the same reason: a trail spanning a seam is committed by both tiles,
    // and rewriting it each time would make "trails owned by tile X" answer differently depending
    // on which sibling drained last.
    const saved = resolved.trailId
      ? await tx.trail.update({
          where: { id: resolved.trailId },
          data: {
            ...row,
            slug: undefined,
            osmType: undefined,
            osmId: undefined,
            quadkey: undefined,
          },
        })
      : await tx.trail.upsert({
          where: { osmType_osmId: { osmType, osmId } },
          create: row,
          // `slug` is omitted from the update on purpose: it is a public URL from the moment
          // the trail is first indexed, and a rename in OSM must not 404 every link to it.
          update: { ...row, slug: undefined },
        });

    // Gated with resolution, not written unconditionally: `osm-id` must stay a complete rollback,
    // and a runtime that reaches a database without `trail_ways` must still ingest rather than
    // fail every trail and record the tile covered.
    if (ctx.identity === 'claim') {
      await claimWays(tx, saved.id, trail.memberWayIds, resolved.claim, resolved.conceded);
    }

    await writeTrailGeometry(tx, {
      trailId: saved.id,
      geometry,
      centroid: derived.centroid,
    });

    await tx.elevationProfile.upsert({
      where: { trailId: saved.id },
      create: {
        trailId: saved.id,
        points: profile,
        spacingM,
        highPointIndex: derived.highPointIndex,
      },
      update: {
        points: profile,
        spacingM,
        highPointIndex: derived.highPointIndex,
      },
    });

    // Waypoints are replaced wholesale rather than diffed: derived data with no user-owned
    // state, and OSM node ids are not stable enough across a retag for a diff to be better.
    // Three statements for any number of waypoints — one `createMany`, then
    // `writeWaypointPoints` derives every PostGIS point from the `lng`/`lat` just written.
    await tx.waypoint.deleteMany({ where: { trailId: saved.id } });
    if (placed.length > 0) {
      await tx.waypoint.createMany({
        data: placed.map((waypoint) => ({
          trailId: saved.id,
          kind: waypoint.kind,
          name: waypoint.name,
          lng: waypoint.lng,
          lat: waypoint.lat,
          eleM: waypoint.eleM,
          osmEleM: waypoint.osmEleM,
          distM: waypoint.distM,
          osmType: waypoint.osmId ? (waypoint.osmType as OsmElementType) : null,
          osmId: waypoint.osmId ? BigInt(waypoint.osmId) : null,
        })),
      });
      await writeWaypointPoints(tx, saved.id);
    }

    return saved.id;
  });

  // Outside the transaction: a queue write failing must not roll back a good trail.
  await enqueue(db, {
    kind: JobKind.enrich_trail,
    dedupeKey: trailEnrichJobKey(trailId),
    payload: { trailId },
    priority: -10,
  });

  return 'committed';
}

/**
 * How long one trail's transaction may take, and how long it may wait for a connection.
 * Prisma's 5 s / 2 s defaults are sized for a web request; a trail's transaction is dozens of
 * round-trips, and under load the default aborts healthy commits and blames the trail.
 *
 * **Thirty seconds is not always enough, and raising it is not obviously the fix.** Of the 30
 * non-deadline trail failures production logged in the trailing seven days to 2026-08-09T10:47Z,
 * 29 were this transaction expiring — 26 naming an elapsed figure, spread 31.5 s / 39.2 s median
 * / 80.5 s, and
 * three reaching a closed transaction from a later statement. No value short of a multiple covers
 * that tail, and a multiple holds one of `BACKGROUND_POOL_SIZE` connections for over a minute
 * while `COMMIT_CONCURRENCY` commits run, buying one trail's success with other trails' failures.
 * The thirtieth failure is the reason to suspect contention rather than slow work: a Postgres
 * `40P01` deadlock between two committers on `trail_ways`. Whether the body is slow because of
 * database work or because six concurrent commits starve the event loop between its awaits is
 * **UNVERIFIED** — 418 `[HostMonitor] Host CPU threshold exceeded (100 >= 80)` lines over the same
 * window are consistent with starvation but do not establish it. Measure that before moving this.
 */
const TRAIL_TX_TIMEOUT_MS = 30_000;

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Attempts allowed per trail — must stay equal to the number of slugs `uniqueSlug` can offer,
 * since each losing attempt burns exactly one. Any lower and the last candidate is
 * unreachable, and the last candidate is the only one unique by construction.
 */
const MAX_SLUG_ATTEMPTS = 4;

/**
 * Run a trail's transaction, retrying when it loses a race for a slug. `uniqueSlug` reads and
 * the upsert writes; with six trails in flight and several called "Lake Trail" in one valley,
 * another worker takes the name in between. A retry is the whole fix because the read is
 * inside the transaction, and the last candidate is unique by construction, so this
 * terminates. Only unique violations are retried — everything else belongs to that trail.
 */
async function commitWithSlugRetry(
  db: PrismaClient,
  body: (tx: Prisma.TransactionClient) => Promise<string>,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.$transaction(body, {
        timeout: TRAIL_TX_TIMEOUT_MS,
        maxWait: TRAIL_TX_TIMEOUT_MS,
      });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== UNIQUE_VIOLATION || attempt >= MAX_SLUG_ATTEMPTS) throw error;
    }
  }
}

/** Elevation for a waypoint that sits on the line, from the profile we already built. */
function elevationAt(
  points: readonly { distM: number; eleM: number }[],
  waypoint: EnrichedWaypoint,
): number | null {
  if (waypoint.distM === null || points.length === 0) return null;
  let best = points[0]!;
  for (const point of points) {
    if (Math.abs(point.distM - waypoint.distM) < Math.abs(best.distM - waypoint.distM))
      best = point;
  }
  return Math.round(best.eleM);
}

/**
 * A slug that is unique and stays that way. The bare name first, because `/trails/ben-nevis`
 * is what somebody would guess; then region-qualified, which says which Eagle Peak Trail this
 * is; then the OSM id, unlovely but unique and stable.
 */
export async function uniqueSlug(
  tx: Prisma.TransactionClient,
  name: string,
  regionName: string | null,
  osmType: OsmElementType,
  osmId: bigint,
): Promise<string> {
  const candidates = [slugify(name)];
  if (regionName) candidates.push(slugify(name, regionName));
  candidates.push(`${slugify(name)}-${osmId.toString(36)}`);

  for (const candidate of candidates) {
    const existing = await tx.trail.findUnique({
      where: { slug: candidate },
      select: { osmType: true, osmId: true },
    });
    // Free, or already ours — a re-ingest of the same trail keeps its URL.
    if (existing) {
      if (existing.osmType !== osmType || existing.osmId !== osmId) continue;
      return candidate;
    }
    // A retired slug still answers on `/trails/<slug>`, so handing it to a different trail would
    // point a permanent link at somebody else's trail — worse than the 404 the alias prevents.
    // Read in every mode, not only `claim`: a merge made while the flag was on retires a slug
    // permanently, and the rollback that turns the flag off is exactly when an unrelated trail
    // would otherwise be free to take it.
    //
    // P2021 only, and it is what keeps `osm-id` free of any dependency on this table: a database
    // the DDL has not reached has no aliases, so no candidate is retired and the bare name is
    // free. Vercel Preview builds run branch code against whichever database they are pointed at
    // while `ci.yml`'s `migrate` job runs on `master` alone, so that gap is reachable. Any other
    // error is a real failure and has to keep failing the commit.
    const alias = await tx.trailSlugAlias
      .findUnique({
        where: { slug: candidate },
        select: { slug: true },
      })
      .catch((error: unknown) => {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2021') {
          return null;
        }
        throw error;
      });
    if (!alias) return candidate;
  }
  return `${slugify(name)}-${osmType}-${osmId.toString(36)}`;
}

export interface RegionInfo {
  regionName: string | null;
  countryCode: string | null;
}

/**
 * Country and region for a tile, from one `is_in` query at its centre. Fails soft to nulls: a
 * trail with no region name is fully usable, and a boundary lookup is not worth failing a
 * tile of otherwise good data over. Soft, not silent — an empty catch here was the one Overpass
 * refusal in the pipeline that left no trace at all.
 */
async function lookupRegion(bbox: BBox, deps: PipelineDeps): Promise<RegionInfo> {
  const centre: LngLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  try {
    const response = await deps.overpass.query(buildRegionQuery(centre));
    return pickRegion(response.elements ?? []);
  } catch (error) {
    (deps.logger ?? (() => {}))(`${OVERPASS_SKIPPED_MARKER} region lookup failed`, {
      error: String(error),
    });
    return { regionName: null, countryCode: null };
  }
}

/**
 * Choose the most useful administrative level present. Descending from 6 (county) to 4
 * (state/region), because the more local name is the more informative one on a trail card.
 * Level 2 is only ever read for its ISO country code, never as a display name.
 */
export function pickRegion(elements: readonly OverpassElement[]): RegionInfo {
  let regionName: string | null = null;
  let countryCode: string | null = null;
  let bestLevel = -1;

  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;
    const level = Number(tags.admin_level);
    if (!Number.isFinite(level)) continue;

    if (level === 2) {
      const code = tags['ISO3166-1:alpha2'] ?? tags['ISO3166-1'];
      if (code && code.length === 2) countryCode = code.toUpperCase();
      continue;
    }

    const name = tags['name:en'] ?? tags.name;
    if (name && level > bestLevel) {
      regionName = name;
      bestLevel = level;
    }
  }

  return { regionName, countryCode };
}

/**
 * Which photo becomes the trail's hero. `Trail.primaryPhotoId` is `@unique`, so **no two
 * trails may share a hero** and the obvious `current ?? candidates[0]` is a write that can
 * fail — historic rows re-parented by an older upsert key still point across trails. So both
 * ends are checked: the existing hero is kept only if that photograph is genuinely ours, and
 * a replacement is the first candidate nobody else has claimed. `null` clears a stolen hero.
 */
export async function chooseHero(
  db: PrismaClient,
  trailId: string,
  current: string | null,
  candidates: readonly string[],
): Promise<string | null> {
  if (current !== null) {
    const held = await db.photo.findUnique({
      where: { id: current },
      select: { trailId: true, hiddenAt: true },
    });
    // A user-uploaded hero outranks anything we scraped and a re-run must not take it back —
    // unless a moderator hid it, in which case the hero has to move. Without the `hiddenAt`
    // check the next enrich pass re-pins a hidden photograph to the top of the trail page.
    if (held?.trailId === trailId && held.hiddenAt === null) return current;
  }
  if (candidates.length === 0) return null;

  const [claimed, visible] = await Promise.all([
    db.trail.findMany({
      where: { id: { not: trailId }, primaryPhotoId: { in: [...candidates] } },
      select: { primaryPhotoId: true },
    }),
    // Ordinarily all of these are visible, but a re-run over a trail where one was moderated
    // must not promote it.
    db.photo.findMany({
      where: { id: { in: [...candidates] }, hiddenAt: null },
      select: { id: true },
    }),
  ]);
  const taken = new Set(claimed.map((row) => row.primaryPhotoId));
  const showable = new Set(visible.map((row) => row.id));
  return candidates.find((id) => showable.has(id) && !taken.has(id)) ?? null;
}

/**
 * Attach seed photos to one trail, as its own job so a slow Commons response delays a photo
 * rather than a tile of trails. Upserts on `(source, sourceId, trailId)` — the trail belongs
 * in that key because Commons geosearch is a radius query and neighbouring trails share
 * photographs, so without it the second trail's upsert reassigns the row.
 */
export async function enrichTrailPhotos(trailId: string, deps: PipelineDeps): Promise<number> {
  const db = deps.db ?? backgroundPrisma;

  const trail = await db.trail.findUnique({
    where: { id: trailId },
    select: {
      id: true,
      centroidLng: true,
      centroidLat: true,
      bboxW: true,
      bboxS: true,
      bboxE: true,
      bboxN: true,
      lengthM: true,
      primaryPhotoId: true,
    },
  });
  if (!trail) return 0;

  const photos = await fetchSeedPhotos(
    {
      centroid: [trail.centroidLng, trail.centroidLat],
      bbox: [trail.bboxW, trail.bboxS, trail.bboxE, trail.bboxN],
      lengthM: trail.lengthM,
    },
    {
      fetchImpl: deps.fetchImpl,
      userAgent: deps.userAgent,
      mapillaryToken: deps.mapillaryToken,
    },
  );
  if (photos.length === 0) return 0;

  const savedIds: string[] = [];
  for (const photo of photos) {
    const source = photo.source === 'wikimedia' ? PhotoSource.wikimedia : PhotoSource.mapillary;
    const data = {
      trailId: trail.id,
      source,
      sourceId: photo.externalId,
      url: photo.url,
      thumbUrl: photo.thumbUrl,
      width: photo.width,
      height: photo.height,
      license: photo.license,
      attribution: photo.attribution,
      sourceUrl: photo.sourceUrl,
      lng: photo.lng,
      lat: photo.lat,
    };
    const saved = await db.photo.upsert({
      where: { source_sourceId_trailId: { source, sourceId: photo.externalId, trailId: trail.id } },
      create: data,
      update: data,
    });
    savedIds.push(saved.id);
  }

  // Counted rather than assumed: `savedIds.length` stops being the trail's photo count the
  // moment a reader uploads one. `hiddenAt: null` because the count is what the gallery
  // shows, and recounting hidden photographs would undo the numeric half of a takedown.
  const photoCount = await db.photo.count({ where: { trailId: trail.id, hiddenAt: null } });
  const primaryPhotoId = await chooseHero(db, trail.id, trail.primaryPhotoId, savedIds);

  await db.trail.update({
    where: { id: trail.id },
    data: { photoCount, primaryPhotoId },
  });

  return savedIds.length;
}
