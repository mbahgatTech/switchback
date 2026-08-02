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
  writeTrailGeometry,
  writeWaypointPoints,
} from '@switchback/db';
import type { Prisma, PrismaClient } from '@switchback/db';
import {
  INGEST_ZOOM,
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

/**
 * A tile is re-fetched when its data is older than this. Weekly would be mostly wasted
 * Overpass load; a season would let a rerouted path go unnoticed. See `docs/architecture.md`.
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
 * Fetch, assemble and commit every trail in one z9 tile. Returns rather than throws for the
 * ordinary failure modes — the caller is a job handler that records the outcome either way —
 * but throws when Overpass is unavailable, so the queue backs off instead of burning attempts.
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
      log('features failed', { quadkey, error: String(error) });
    }
  }

  let committed = 0;
  let skipped = 0;
  let failed = 0;

  // The try lives here in the body rather than inside `forEachConcurrent`: a trail that
  // throws must cost its tile one row, not the rest of the tile.
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
 * Queue the long-distance routes this tile's trails turn out to be pieces of. Runs after the
 * tile is marked ready and swallows its own failures: it is strictly additive, and marking
 * the tile failed would re-run the expensive half to retry the cheap half.
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
    log('parent route lookup failed', { error: String(error) });
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
 * One trail, committed or skipped. The transaction covers the trail row, its geometry, its
 * profile and its waypoints: a trail row whose `geom` write failed is invisible to every
 * spatial query while still appearing in search, and nothing about it looks broken.
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
   * `alongLengthM` is not an optimisation. A capped profile resamples the PCT at 725 m, and
   * the straight lines between samples skip every switchback: measured that way it comes out
   * at 3,214 km instead of 4,221. Handing the true along-line length down keeps the sample
   * distances — and every stat, axis and weather point derived from them — exact.
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

    const saved = await tx.trail.upsert({
      where: { osmType_osmId: { osmType, osmId } },
      create: row,
      // `slug` is omitted from the update on purpose: it is a public URL from the moment
      // the trail is first indexed, and a rename in OSM must not 404 every link to it.
      update: { ...row, slug: undefined },
    });

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
 * Country and region for a tile, from one `is_in` query at its centre. Fails soft to nulls: a
 * trail with no region name is fully usable, and a boundary lookup is not worth failing a
 * tile of otherwise good data over.
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
