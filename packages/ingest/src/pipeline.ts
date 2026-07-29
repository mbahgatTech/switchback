/**
 * `processTile` — the whole lazy ingest, one z9 tile at a time.
 *
 * This is where the pieces meet: Overpass gives raw elements, `assemble` turns them into
 * ordered lines, `elevate` gives each line a profile, `derive` turns that into the numbers
 * on a trail card, `enrich` attaches what is around it, and this module commits the lot
 * and marks the tile ready.
 *
 * Three properties matter more than anything else here, because this runs unattended:
 *
 * **Idempotent.** Every trail is keyed by `(osmType, osmId)` and every write is an upsert,
 * so running a tile twice produces the same rows, not duplicates. That is what makes the
 * at-least-once job queue safe.
 *
 * **Per-trail failure isolation.** One trail with broken geometry must not cost the other
 * thirty-nine in its tile. Each trail commits in its own transaction and its own try.
 *
 * **Honest tile status.** A tile is only `ready` when Overpass actually answered. A tile
 * that failed stays `failed` with the reason on it, so the next request re-queues it
 * rather than serving an empty map as though the area had no trails.
 *
 * The one thing deliberately *not* done here is photos. Commons lookups are one HTTP
 * request per trail and they are decoration; doing them inline would double the wall-clock
 * of a tile to no benefit. They are enqueued as `enrich_trail` jobs and land a minute later.
 */

import type { BBox, LngLat, LineString } from '@switchback/core';
import {
  BACKGROUND_POOL_SIZE,
  JobKind,
  OsmElementType,
  PhotoSource,
  TileStatus,
  backgroundPrisma,
  writeTrailGeometry,
  writeWaypointPoints,
} from '@switchback/db';
import type { Prisma, PrismaClient } from '@switchback/db';
import {
  INGEST_ZOOM,
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
import {
  OverpassUnavailableError,
  buildFeatureQuery,
  buildParentRouteQuery,
  buildRegionQuery,
  buildRelationSkeletonQuery,
  buildRouteQuery,
  buildTileQuery,
  buildWayGeometryQuery,
} from './overpass';
import type { OverpassClient, OverpassElement, OverpassRelation } from './overpass';
import { enqueue, routeIngestJobKey, trailEnrichJobKey } from './jobs';
import { Gate, forEachConcurrent } from './pool';

/** Resample interval for the elevation profile. Matches `ElevationProfile.spacingM`. */
const PROFILE_SPACING_M = 25;

/** Vertex tolerance for the copy every client renders. 5 m is invisible at z15. */
const RENDER_SIMPLIFY_M = 5;

/**
 * Ceilings that turn "long trail" into "trail we can actually store and draw".
 *
 * Both constants exist because of one class of route: the continental ones. A 20 km path
 * sampled every 25 m is 800 elevation points and a few hundred rendered vertices, and
 * nothing about that needs a limit. The Pacific Crest Trail is 4,270 km — the same rules
 * give it 170,000 terrain samples across several thousand DEM tiles, and a `geometryJson`
 * measured in megabytes that `browse` would then return up to 300 of at once. Neither is a
 * slow version of the right answer; they are a stalled ingest and an unusable map.
 *
 * The honest cost is stated rather than hidden: a route past the ceiling gets a coarser
 * profile, so its gain figure is sampled at hundreds of metres and will understate the
 * real climbing. That is the correct trade at this scale — nobody reads a 4,270 km
 * elevation chart for a 25 m feature — but it is a trade, and `ElevationProfile.spacingM`
 * records which one each trail got rather than letting every profile claim 25 m.
 */
const MAX_PROFILE_POINTS = 6_000;
const MAX_RENDER_VERTICES = 3_000;

/**
 * How many trails are committed at once, process-wide.
 *
 * This number is the difference between a map that fills in and a map that appears broken.
 * A z9 tile in the Cascades assembles around 150 trails, and each one waits on terrain
 * tiles over HTTP and then on a transaction's worth of round-trips to Postgres — a few
 * seconds of almost pure latency, of which this process spends nearly none doing work.
 * Sequentially that is eight minutes per tile, which is not slow so much as it is
 * indistinguishable from broken: the user sees "trails appear as they land" and then
 * nothing at all for longer than anybody waits.
 *
 * Six, not sixty. The ceiling is not our CPU, it is the two scarce resources underneath:
 * `TerrainSource` already caps its own fetches at six and dedupes in-flight requests, and
 * the ingest holds a pool of `BACKGROUND_POOL_SIZE` connections, of which this may take all
 * but the four the queue's own bookkeeping needs. Pushing past that converts the wait from
 * "fetching terrain" into "waiting for a connection", which is the same wall clock with
 * worse failure modes. Six saturates the latency without contending for either.
 *
 * Measured on quadkey 021231030 (144 trails, Cascades): 490.5 s sequential, 88.0 s at six,
 * 95.5 s at twelve. The curve is flat past six and then bends the wrong way, which is what
 * saturating a latency and then contending for a pool looks like. Raise this by raising
 * `BACKGROUND_POOL_SIZE` and `TerrainSource.maxConcurrent` together, and only with a number.
 *
 * Overpass is untouched by this. Its per-tile queries happen before this loop, and the one
 * place a trail might reach it — `discoverParentRoutes` — runs after.
 */
const COMMIT_CONCURRENCY = Math.max(1, Math.min(6, BACKGROUND_POOL_SIZE - 4));

/**
 * The ceiling above, enforced across drains rather than within one.
 *
 * `forEachConcurrent` bounds the loop it is given, which was enough for as long as one drain
 * ran at a time. Three code paths start them — the trails router's `waitUntil` kick, the
 * routes router's, and the cron — and each is guarded only against starting a second of its
 * own kind, so all three can be committing at once while each one obeys the six. Eighteen
 * open transactions is not a number anybody chose; it is what independently-reasonable local
 * limits multiply out to. The gate is module-level so the resource sees one ceiling.
 *
 * Inside a single drain it never blocks: the loop below asks for exactly as many permits as
 * exist, so this costs one already-resolved promise per trail and changes nothing.
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
 * The rendered copy, coarsened until it fits.
 *
 * Douglas-Peucker takes a tolerance, not a vertex count, and the relationship between them
 * depends on how wiggly the line is — so this asks rather than predicts, quadrupling the
 * tolerance until the result is small enough. Ordinary trails exit on the first pass at
 * the 5 m tolerance they have always had.
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

/**
 * A tile is re-fetched when its data is older than this.
 *
 * 30 days is a compromise between two real costs: OSM trail geometry changes slowly, so
 * refetching weekly is mostly wasted Overpass load; but a trail closure or a rerouted path
 * mapped today should not take a season to reach us.
 */
export const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PipelineDeps {
  db?: PrismaClient;
  overpass: OverpassClient;
  terrain?: TerrainSource;
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
}

/** Whether a tile's cached data is still good enough to serve without re-fetching. */
export function isTileFresh(
  tile: { status: TileStatus; fetchedAt: Date | null } | null,
  now: Date,
  ttlMs = TILE_TTL_MS,
): boolean {
  if (!tile?.fetchedAt) return false;
  if (tile.status !== TileStatus.ready && tile.status !== TileStatus.empty) return false;
  return now.getTime() - tile.fetchedAt.getTime() < ttlMs;
}

/**
 * Fetch, assemble, and commit every trail in one z9 tile.
 *
 * Returns rather than throws for the ordinary failure modes, because the caller is a job
 * handler that needs to record the outcome either way. It *does* throw when Overpass is
 * unavailable, so the job queue backs off rather than burning attempts against a service
 * that has already told us it is down.
 */
export async function processTile(quadkey: string, deps: PipelineDeps): Promise<ProcessTileResult> {
  const db = deps.db ?? backgroundPrisma;
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? (() => {});
  const terrain = deps.terrain ?? new TerrainSource({ fetchImpl: deps.fetchImpl });

  const tile = quadkeyToTile(quadkey);
  if (tile.z !== INGEST_ZOOM) {
    throw new Error(`processTile expects a z${INGEST_ZOOM} quadkey, got z${tile.z} (${quadkey})`);
  }
  const bbox = quadkeyToBBox(quadkey);
  const startedAt = Date.now();

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
    return {
      quadkey,
      status: TileStatus.empty,
      trailCount: 0,
      skipped: 0,
      failed: 0,
      fetchMs: Date.now() - startedAt,
    };
  }

  const region = await lookupRegion(bbox, deps);

  /**
   * Waypoints for the whole tile in one query rather than one per trail.
   *
   * Forty trails would be forty Overpass requests at two concurrent — several minutes of
   * a public service's time to fetch overlapping data. One tile-wide query costs the same
   * as one trail's, and `attachWaypoints` does the per-trail assignment locally.
   */
  let features: OverpassElement[] = [];
  if (deps.enrichWaypoints !== false) {
    try {
      const response = await deps.overpass.query(buildFeatureQuery(featureSearchBBox(bbox)));
      features = response.elements ?? [];
    } catch (error) {
      // Waypoints are decoration; a trail without them is still a trail.
      log('features failed', { quadkey, error: String(error) });
    }
  }

  let committed = 0;
  let skipped = 0;
  let failed = 0;

  /**
   * Commit trails concurrently, `COMMIT_CONCURRENCY` at a time.
   *
   * The failure isolation the sequential loop had is preserved exactly: each trail is its
   * own try, its own transaction, and its own line in the log. What changes is only how
   * many are in flight — which is why the try lives here, in the body, rather than inside
   * `forEachConcurrent`. A trail that throws must cost its tile one row, not the rest of
   * the tile.
   */
  await forEachConcurrent(assembled, COMMIT_CONCURRENCY, async (trail) => {
    try {
      const outcome = await commitGate.run(() =>
        commitTrail(db, trail, {
          quadkey,
          features,
          region,
          terrain,
          now: now(),
        }),
      );
      if (outcome === 'committed') committed += 1;
      else skipped += 1;
    } catch (error) {
      failed += 1;
      log('trail failed', {
        quadkey,
        osm: `${trail.osmType}/${trail.osmId}`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const fetchMs = Date.now() - startedAt;
  await db.ingestTile.update({
    where: { quadkey },
    data: {
      status: TileStatus.ready,
      fetchedAt: now(),
      trailCount: committed,
      lastError: failed > 0 ? `${failed} trail(s) failed to commit` : null,
      fetchMs,
    },
  });

  await discoverParentRoutes(db, assembled, deps);

  return { quadkey, status: TileStatus.ready, trailCount: committed, skipped, failed, fetchMs };
}

/**
 * Queue the long-distance routes that this tile's trails turn out to be pieces of.
 *
 * Runs after the tile is marked ready, and swallows its own failures, because it is
 * strictly additive: a tile that ingested forty trails and then failed to notice one of
 * them belongs to the Pacific Crest Trail is a good tile with a missing extra, not a
 * failed one. Marking it failed would re-run the expensive half to retry the cheap half.
 */
async function discoverParentRoutes(
  db: PrismaClient,
  assembled: readonly AssembledTrail[],
  deps: PipelineDeps,
): Promise<void> {
  const log = deps.logger ?? (() => {});
  const relationIds = assembled.filter((t) => t.osmType === 'relation').map((t) => t.osmId);
  if (relationIds.length === 0) return;

  try {
    const response = await deps.overpass.query(buildParentRouteQuery(relationIds));
    const parents = (response.elements ?? []).filter(
      (element): element is OverpassRelation => element.type === 'relation',
    );

    for (const parent of parents) {
      // `type=superroute` is the tag that means "this relation's members are routes". A
      // parent that is a plain `type=route` is a section container we already ingest by
      // bbox, and re-fetching it whole would duplicate work rather than add anything.
      if (parent.tags?.type !== 'superroute') continue;
      if (!(parent.tags.name ?? parent.tags['name:en'])) continue;

      await enqueue(db, {
        kind: JobKind.ingest_route,
        dedupeKey: routeIngestJobKey(parent.id),
        payload: { osmId: parent.id },
        // Below tile work. A user is waiting on the tile under their cursor; nobody is
        // waiting on a continental route, and it is the most expensive job we run.
        priority: -10,
      });
      log('queued route', { osmId: parent.id, name: parent.tags.name });
    }
  } catch (error) {
    log('parent route lookup failed', { error: String(error) });
  }
}

/** How deep a superroute hierarchy is followed before we stop expanding member relations. */
const MAX_ROUTE_DEPTH = 3;

/**
 * How many route relations are asked for in one Overpass request.
 *
 * Not politeness — feasibility. `out body geom` on all 31 sections of the Pacific Crest
 * Trail is a single response holding the inline coordinates of roughly 400,000 nodes:
 * tens of megabytes down one socket that the server spends minutes generating before it
 * sends the first byte. The first real attempt died exactly there, with a transport-level
 * `fetch failed` after every mirror had been given its turn — no status code, because the
 * connection never got far enough to have one.
 *
 * Four sections is around 500 km, which arrives in a few megabytes and well inside the
 * client's abort window. Eight sequential requests instead of one is slower in the best
 * case and the only version that finishes in the actual case.
 */
const ROUTE_BATCH_SIZE = 4;

/**
 * Fetch route relations by id, halving the batch whenever a request fails.
 *
 * A fixed stride cannot be right, because the ceiling it has to stay under is not ours and
 * is not advertised. `[timeout:180]` is a promise Overpass makes about its own execution;
 * it says nothing about the reverse proxy in front of a given mirror, and the one this
 * project depends on most gives up at roughly 38 seconds and answers `504`. So the same
 * batch of four sections is comfortable against one mirror and impossible against another,
 * and no single constant tuned on a good day survives a bad one.
 *
 * Halving turns that from a cliff into a slope. A batch that fails is not evidence that
 * the route is unfetchable, only that this many sections at once was too much for whoever
 * answered; two halves are each half the work and get a fresh mirror from the rotation.
 * The recursion bottoms out at a single id, and a single id that still fails after the
 * client has exhausted its own mirrors and backoff is a real failure and is thrown.
 *
 * **It throws rather than skipping.** Dropping an unfetchable section and committing the
 * rest is the tempting recovery and it is the exact bug this whole module exists to fix: a
 * Pacific Crest Trail quietly missing 300 km still renders, still looks finished, and lies
 * about its length in the one place a user would check. A route that fails to assemble
 * leaves the previous data in place and the job retryable; a route that assembles wrongly
 * is committed, cached, and believed.
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
        // The unit is one relation and it still will not come. Below a relation there is a
        // smaller unit — its ways — so this is a continuation of the halving, not a
        // different strategy. Only if that also fails is the route genuinely unfetchable.
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
 * How many way geometries are asked for in one request.
 *
 * The unit below a relation. A PCT section is on the order of a thousand ways, so 250 is
 * four or five requests per section — each a couple of megabytes, which every mirror serves
 * comfortably, including the one whose proxy gives up at 38 seconds.
 */
const WAY_GEOMETRY_BATCH_SIZE = 250;

/**
 * Rebuild one relation from a skeleton plus its ways, when it cannot be fetched whole.
 *
 * `out body geom` asks a mirror to assemble a relation and all of its coordinates in one
 * response, and for the largest PCT sections no public mirror reliably will — the halving
 * in `fetchRelations` runs out of things to halve and the whole 4,270 km route fails on one
 * section. This is the step below that: ask for the member list without geometry, which is
 * always cheap, then ask for the coordinates in batches sized by us instead of by the
 * relation.
 *
 * The result is spliced back into the members and is structurally identical to what
 * `out body geom` would have returned, so nothing downstream knows this happened. That is
 * the point — `assembleTrails` chains members by their inline geometry and must not grow a
 * second code path for routes that took the long way here.
 *
 * **A missing way is fatal, deliberately.** The failure this module exists to prevent is a
 * route that assembles from most of its parts, renders, and lies about its length. If the
 * geometry for even one member never arrives, the original error is thrown and the job stays
 * retryable — the previous data, right or wrong, is left alone rather than replaced with
 * something confidently incomplete.
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
      // The member list is the cheapest thing we ask any mirror for. If even this fails the
      // problem is not the relation's size, so report the original failure rather than this
      // one — it is the more informative of the two.
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
 * Way geometry for one relation, halving on failure exactly as `fetchRelations` does.
 *
 * The batch size above is a guess about what a mirror will serve, and on the heaviest PCT
 * sections it is sometimes wrong — 250 ways through a dense stretch is a bigger response
 * than the same count through open desert, and the mirror answers 504. Without this the
 * whole 4,270 km route failed on that one timeout, which is what kept happening: the largest
 * sections are both the ones that need this path and the ones whose batches are heaviest.
 *
 * So the recovery is the one this module already uses a level up. Ask for less, then less
 * again. `fetchRelations` halves relations and then descends to ways; this halves ways, and
 * below a way there is nothing smaller to ask Overpass for — so a single-way request that
 * still fails is allowed to throw, and the caller treats it as the fatal gap it is. That
 * keeps the guarantee that matters: a route is committed whole or not at all.
 *
 * The error that escapes is the way-level one rather than the relation-level `cause` the
 * caller started with. It names the request that actually failed, which is the more useful
 * of the two when someone reads the job's `lastError` a day later.
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
 * Ingest one long-distance route whole, by relation id rather than by area.
 *
 * The case this exists for: OSM models the Pacific Crest Trail as a `type=superroute`
 * whose members are the section relations, and a bbox query returns relations by their
 * node and way members only — it never recurses into member relations. So no tile can ever
 * see the PCT itself. Every tile along it sees a section, commits it under the section's
 * own name, and the product ends up insisting that the Pacific Crest Trail is 111 km long,
 * or 61 km, depending on which fragment won. The trail is not missing; it is misdescribed,
 * which is worse, because nothing looks wrong.
 *
 * Resolution hikes the hierarchy: fetch the root, fetch its member relations, repeat until
 * the members are ways. Then the flattened member list is handed to the ordinary assembler
 * as a single synthetic relation, so chaining, gap-bridging, and orientation are the same
 * code that every other trail goes through — a superroute is a long trail, not a new kind
 * of object.
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
   * Flatten the hierarchy into one member list, in the order the relations declare.
   *
   * Order is the whole point. The assembler chains by matching endpoints and bridges what
   * it cannot match, and a shuffled member list turns a continuous route into a hundred
   * disjoint lines of which it keeps the longest. Depth-first over the declared order is
   * the order a hiker would meet them in.
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
  // another's begins — reliably within a few hundred metres, occasionally more where a
  // route crosses a road. Tighter than the default and the PCT arrives in 31 pieces.
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
}

/**
 * One trail, committed or skipped.
 *
 * The transaction covers the trail row, its geometry, its profile, and its waypoints,
 * because a trail row whose `geom` write failed is invisible to every spatial query while
 * still appearing in search — the worst kind of partial state, since nothing about it
 * looks broken.
 */
async function commitTrail(
  db: PrismaClient,
  trail: AssembledTrail,
  ctx: CommitContext,
): Promise<'committed' | 'skipped'> {
  const spacingM = profileSpacingFor(trail.lengthM);
  const resampled = resampleLine(trail.coords, spacingM);
  if (resampled.length < 2) return 'skipped';

  /*
   * `alongLengthM` is not an optimisation — it is the difference between publishing a
   * thru-hike and publishing a lie about one. A long trail's profile is capped at 6,000
   * points, so the Pacific Crest Trail resamples at 725 m, and the straight lines between
   * those samples skip every switchback in between. Measured that way it comes out at
   * 3,214 km instead of 4,221. Handing the true along-line length down makes the sample
   * distances exact, and everything derived from them — the stats, the chart axis, the
   * waypoint distances, the weather sample points — correct with it.
   */
  const { points, gapCount } = await elevateLine(resampled, ctx.terrain, {
    spacingM,
    alongLengthM: trail.lengthM,
  });

  // An all-gap profile means every terrain tile under this line failed or does not exist.
  // Storing it would publish a flat sea-level trail with zero gain, which reads as fact.
  if (gapCount === points.length) return 'skipped';

  const derived = deriveTrail({
    coords: trail.coords,
    profile: points,
    bbox: trail.bbox,
    tags: trail.tags,
    // Read off the un-oriented line, before `deriveTrail` may flip it — see
    // `terminusFeatures` for why that is safe.
    termini: ctx.features.length ? terminusFeatures(trail.coords, ctx.features) : undefined,
  });

  // `derived.coords` and `derived.profile`, never `trail.coords` and `points`. OSM stores
  // roughly half of all point-to-point paths running downhill, and `deriveTrail` flips
  // those so the stats describe the hike rather than the mapper's drawing direction.
  // Everything below has to agree with the numbers: the drawn line, the profile chart, and
  // the waypoint distances all measure from whichever end is now the start.
  const oriented = derived.coords;
  const profile = [...derived.profile];

  const waypoints = ctx.features.length ? attachWaypoints(oriented, ctx.features) : [];
  const trailhead = synthesiseTrailhead(oriented);
  const allWaypoints = trailhead ? [trailhead, ...waypoints] : waypoints;

  const geometry: LineString = { type: 'LineString', coordinates: [...oriented] };
  const rendered = renderGeometry(oriented);
  const osmType = trail.osmType === 'relation' ? OsmElementType.relation : OsmElementType.way;
  const osmId = BigInt(trail.osmId);

  const trailId = await commitWithSlugRetry(db, async (tx) => {
    const slug = await uniqueSlug(tx, trail.name, ctx.region.regionName, osmType, osmId);

    const row = {
      slug,
      name: trail.name,
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

    const saved = await tx.trail.upsert({
      where: { osmType_osmId: { osmType, osmId } },
      create: row,
      // `slug` is omitted from the update on purpose: it is a public URL from the moment
      // the trail is first indexed, and a rename in OSM must not silently 404 every link
      // to it. Renames land on `name` and are reconciled deliberately, not by ingest.
      update: { ...row, slug: undefined },
    });

    await writeTrailGeometry(tx, {
      trailId: saved.id,
      geometry,
      centroid: derived.centroid,
      name: trail.name,
      regionName: ctx.region.regionName,
      description: derived.description,
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

    // Waypoints are replaced wholesale rather than diffed. They are derived data with no
    // user-owned state attached, and OSM ids on nodes are not stable enough across a
    // retag to make a diff more correct than a rewrite.
    //
    // Three statements for any number of waypoints, not two per waypoint: the rows go in
    // one `createMany`, and `writeWaypointPoints` derives every PostGIS point from the
    // `lng`/`lat` it just wrote. See the note on that function for why the round-trip count
    // rather than the work is what used to exhaust this transaction's budget.
    await tx.waypoint.deleteMany({ where: { trailId: saved.id } });
    if (allWaypoints.length > 0) {
      await tx.waypoint.createMany({
        data: allWaypoints.map((waypoint) => ({
          trailId: saved.id,
          kind: waypoint.kind,
          name: waypoint.name,
          lng: waypoint.lng,
          lat: waypoint.lat,
          eleM: elevationAt(profile, waypoint),
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
 *
 * Prisma's defaults are 5 s and 2 s, both sized for a web request rather than for this. A
 * trail's transaction is a slug lookup, an upsert, two spatial writes, a profile upsert,
 * and a write per waypoint — dozens of round-trips — and with several running at once the
 * 5 s ceiling starts aborting perfectly healthy commits under nothing worse than load.
 * That failure is expensive and misleading: the trail is counted failed, the terrain work
 * that produced it is discarded, and the tile records "1 trail(s) failed to commit" for a
 * problem that is entirely ours.
 */
const TRAIL_TX_TIMEOUT_MS = 30_000;

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

/**
 * Attempts allowed per trail, one for each slug `uniqueSlug` can offer.
 *
 * It offers four — bare name, region-qualified, id-qualified, and type-and-id-qualified —
 * and each losing attempt burns exactly one, because the winner of the race is committed by
 * the time we look again. So the cap has to be the candidate count: any lower and the last
 * candidate is unreachable, and the last candidate is the only one unique by construction.
 * Stopping at three would mean giving up one step before the answer that cannot fail.
 */
const MAX_SLUG_ATTEMPTS = 4;

/**
 * Run a trail's transaction, retrying when it loses a race for a slug.
 *
 * `uniqueSlug` reads and the upsert writes, and between those two moments another worker
 * may take the name. That gap was unreachable while trails committed one at a time and is
 * routine now that six do: a tile holding a hundred and fifty paths in one valley contains
 * several called "Lake Trail", and they are now in flight together.
 *
 * A retry is the whole fix, because the read is inside the transaction. The second attempt
 * finds the row that beat us, `uniqueSlug` moves on to its next candidate — region-
 * qualified, then id-qualified, then type-and-id-qualified — and that last one is unique by
 * construction, so this terminates rather than spins.
 *
 * Only unique violations are retried. Every other error belongs to that trail and is
 * rethrown to `processTile`, which records it and carries on with the rest of the tile.
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
 * A slug that is unique and stays that way.
 *
 * Tries the bare name first, because `/trails/ben-nevis` is the URL somebody would guess.
 * On collision it qualifies with the region, which is genuinely informative — there are
 * several Eagle Peak Trails and the region says which one. Only if that also collides does
 * it fall back to the OSM id, which is unlovely but unique and stable.
 */
async function uniqueSlug(
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
    if (!existing) return candidate;
    if (existing.osmType === osmType && existing.osmId === osmId) return candidate;
  }
  return `${slugify(name)}-${osmType}-${osmId.toString(36)}`;
}

export interface RegionInfo {
  regionName: string | null;
  countryCode: string | null;
}

/**
 * Country and region for a tile, from one `is_in` query at its centre.
 *
 * Fails soft to nulls. A trail with no region name is fully usable — it just ranks
 * slightly differently in search and gets a plainer slug — and a boundary lookup is not
 * worth failing a tile of otherwise good data over.
 */
async function lookupRegion(bbox: BBox, deps: PipelineDeps): Promise<RegionInfo> {
  const centre: LngLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  try {
    const response = await deps.overpass.query(buildRegionQuery(centre));
    return pickRegion(response.elements ?? []);
  } catch {
    return { regionName: null, countryCode: null };
  }
}

/**
 * Choose the most useful administrative level present.
 *
 * Descending from level 6 (county) to 4 (state/region), because the more local name is
 * the more informative one — "Snowdonia" beats "Wales" beats "United Kingdom" on a trail
 * card. Level 2 is only ever read for its ISO country code, never as a display name.
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
 * Which photo becomes the trail's hero, given what it already has and what just landed.
 *
 * `Trail.primaryPhotoId` is one half of a one-to-one relation, so Prisma requires it to be
 * `@unique` and Postgres therefore enforces that **no two trails may share a hero**. That
 * makes the obvious `trail.primaryPhotoId ?? savedIds[0]` a write that can fail — and it
 * did. An earlier version of the upsert below keyed photos on `(source, sourceId)` alone,
 * so a neighbouring trail's enrichment re-parented rows out from under a trail that had
 * already claimed one as its hero. The key was fixed; the rows it left behind were not,
 * and each one is now a trail whose enrichment dies on a unique violation before it can
 * write anything at all.
 *
 * So both ends are checked rather than assumed:
 *
 * - the hero already on the trail is kept only if that photograph is genuinely ours. A
 *   pointer at another trail's photo is a wrong picture at the top of the page, not a
 *   preference worth preserving.
 * - a replacement is the first candidate nobody else has claimed.
 *
 * `null` when nothing qualifies, which clears a stolen hero rather than re-writing it.
 */
export async function chooseHero(
  db: PrismaClient,
  trailId: string,
  current: string | null,
  candidates: readonly string[],
): Promise<string | null> {
  if (current !== null) {
    const held = await db.photo.findUnique({ where: { id: current }, select: { trailId: true } });
    // A user-uploaded photo, once chosen, outranks anything we scraped, and a re-run of
    // enrichment must not quietly take it back.
    if (held?.trailId === trailId) return current;
  }
  if (candidates.length === 0) return null;

  const claimed = await db.trail.findMany({
    where: { id: { not: trailId }, primaryPhotoId: { in: [...candidates] } },
    select: { primaryPhotoId: true },
  });
  const taken = new Set(claimed.map((row) => row.primaryPhotoId));
  return candidates.find((id) => !taken.has(id)) ?? null;
}

/**
 * Attach seed photos to one trail.
 *
 * Runs as its own job so a slow Commons response delays a photo, not a tile of trails.
 *
 * Upserts on `(source, sourceId, trailId)`. The trail belongs in that key because Commons
 * geosearch is a radius query and neighbouring trails share photographs: without it, the
 * second trail's upsert would reassign the row and silently strip the first trail of a
 * photo its `photoCount` still claimed.
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

  // Counted rather than assumed. `savedIds.length` is what enrichment just wrote, which
  // stops being the trail's photo count the moment a user uploads one of their own.
  const photoCount = await db.photo.count({ where: { trailId: trail.id } });
  const primaryPhotoId = await chooseHero(db, trail.id, trail.primaryPhotoId, savedIds);

  await db.trail.update({
    where: { id: trail.id },
    data: { photoCount, primaryPhotoId },
  });

  return savedIds.length;
}
