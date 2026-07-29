/**
 * The walkable network, fetched for its own sake.
 *
 * The trail pipeline and this one look similar and answer different questions. `pipeline.ts`
 * asks "what named hikes exist here", assembles route relations into single curated lines,
 * and throws away everything that is not one of those: `pickPrimary` keeps the longest
 * contiguous run of a relation and discards the branches, and `MIN_TRAIL_LENGTH_M` drops
 * anything under 200 m. That is the right catalogue and the wrong graph. The 150 m unnamed
 * spur joining two trails is the piece that turns an out-and-back into a loop, and it is
 * the first thing the catalogue deletes.
 *
 * So planning gets its own cache: every foot-legal way in an area, named or not, kept as
 * raw runs rather than assembled lines, at a finer tile than the catalogue uses. Same lazy
 * pattern, same terrain source, different query and different table.
 */

import type { BBox, LngLat, PathKind, PathSegment } from '@switchback/core';
import { JobKind, JobStatus, TileStatus, backgroundPrisma, prisma } from '@switchback/db';
import type { Prisma, PrismaClient } from '@switchback/db';
import {
  TERRARIUM_ZOOM,
  coverBBox,
  quadkeyToBBox,
  quadkeyToTile,
  sampleElevations,
} from '@switchback/geo';
import { fillGaps } from './elevate';
import { TerrainSource } from './elevate';
import { enqueue, networkJobKey } from './jobs';
import { OverpassUnavailableError } from './overpass';
import type { OverpassElement, OverpassWay } from './overpass';
import type { PipelineDeps } from './pipeline';

/**
 * Routing tiles are z12 — about 10 km across at mid-latitudes, against the catalogue's z9.
 *
 * The catalogue can afford big tiles because it only keeps named trails, so a z9 tile over
 * a national park is a few hundred rows. This query keeps every path, alley and service
 * road; the same z9 tile over a city is hundreds of thousands of ways and an Overpass
 * timeout. Smaller tiles also match how planning is actually used — you plan inside one
 * valley, not across a province — so a session usually touches one or two of them.
 */
export const ROUTING_ZOOM = 12;

/**
 * How far past the tile edge to fetch, in degrees of latitude — roughly 250 m.
 *
 * Without it, every tile boundary is a wall. A way crossing the edge is clipped, its far
 * vertices are missing, and the graph gains a dead end exactly where the network is in
 * fact continuous. The pad means the neighbouring tile's first few hundred metres arrive
 * with this one, the shared vertices carry identical coordinates, and `buildGraph` fuses
 * the two copies into one network with no merge step. Overlap is the cheap fix; stitching
 * clipped ways back together afterwards is the expensive one.
 */
export const ROUTING_TILE_PAD_DEG = 0.00225;

/**
 * Which OSM `highway` values become which `PathKind`.
 *
 * Two judgements are baked in. The first is the ceiling: nothing above `tertiary`. A
 * planner that offers to hike someone along a primary A-road has produced a technically
 * valid route and a bad one, and the parallel footway is almost always mapped. The second
 * is the floor: roads *are* included, because a route that refuses tarmac cannot leave most
 * car parks, and the penalty in `KIND_PENALTY` — not exclusion — is the right tool for
 * "possible but unpleasant".
 */
const HIGHWAY_KIND: Record<string, PathKind> = {
  path: 'path',
  footway: 'footway',
  track: 'track',
  bridleway: 'bridleway',
  steps: 'steps',
  cycleway: 'cycleway',
  pedestrian: 'pedestrian',
  living_street: 'road',
  residential: 'road',
  unclassified: 'road',
  tertiary: 'road',
  service: 'road',
  road: 'road',
};

const HIGHWAY_VALUES = Object.keys(HIGHWAY_KIND);

/** Access values that mean "not for you", on either the general or the foot key. */
const BARRED_ACCESS = /^(private|no|permit|customers)$/u;

/**
 * `service` values that are not through-routes: a driveway to one house, a parking aisle,
 * the lane behind a drive-through. Forest and access tracks keep the bare `service` tag or
 * a value not in this list, and those are exactly the ways a hiker uses to reach a trail.
 */
const BARRED_SERVICE = /^(driveway|parking_aisle|drive-through)$/u;

/**
 * Every way a hiker may legally use in the box.
 *
 * Note what is absent: the `["name"]` filter that the trail query carries. That filter is
 * what keeps the catalogue from cataloguing every garden path, and it is precisely wrong
 * here — the connectors that make routes possible are overwhelmingly unnamed.
 *
 * The access filters run server-side rather than in `classifyWay` below because they are
 * the difference between a response that fits in memory and one that does not. Overpass
 * treats `["k"!~"v"]` as satisfied when the key is absent, so an untagged way passes, which
 * is the behaviour we want: OSM's default for a path is that you may hike it.
 *
 * `out body geom` for the same reason as everywhere else in this file's neighbour: `tags`
 * is a verbosity that would drop the geometry we came for.
 */
export function buildNetworkQuery(
  bbox: BBox,
  options: { timeoutS?: number; maxSizeBytes?: number } = {},
): string {
  const [w, s, e, n] = bbox;
  const timeout = options.timeoutS ?? 180;
  const maxSize = options.maxSizeBytes ?? 536_870_912;
  // Overpass bbox order is (south, west, north, east) — transposed from GeoJSON's.
  const box = `${s},${w},${n},${e}`;

  return `[out:json][timeout:${timeout}][maxsize:${maxSize}];
way["highway"~"^(${HIGHWAY_VALUES.join('|')})$"]["access"!~"^(private|no)$"]["foot"!~"^(private|no|use_sidepath)$"]["service"!~"^(driveway|parking_aisle|drive-through)$"](${box});
out body geom;`;
}

/** What a way's tags say about it, or null if it is not walkable after all. */
export function classifyWay(
  tags: Record<string, string> | undefined,
): Pick<PathSegment, 'kind' | 'name' | 'surface' | 'sacScale'> | null {
  if (!tags) return null;
  const kind = HIGHWAY_KIND[tags.highway ?? ''];
  if (!kind) return null;

  // Re-checked here as well as in the query, because a segment can also arrive from a
  // cached tile fetched under an older filter set, and because the server-side test is a
  // performance measure rather than the definition.
  if (BARRED_ACCESS.test(tags.access ?? '')) return null;
  if (BARRED_ACCESS.test(tags.foot ?? '') || tags.foot === 'use_sidepath') return null;
  if (BARRED_SERVICE.test(tags.service ?? '')) return null;
  // A way under construction or merely proposed has no surface to hike on.
  if (tags.highway === 'construction' || tags.highway === 'proposed') return null;

  const sac = tags.sac_scale;
  return {
    kind,
    name: tags.name ?? null,
    surface: tags.surface ?? null,
    sacScale: isSacScale(sac) ? sac : null,
  };
}

const SAC_VALUES = new Set([
  'hiking',
  'mountain_hiking',
  'demanding_mountain_hiking',
  'alpine_hiking',
  'demanding_alpine_hiking',
  'difficult_alpine_hiking',
]);

function isSacScale(value: string | undefined): value is NonNullable<PathSegment['sacScale']> {
  return value !== undefined && SAC_VALUES.has(value);
}

/**
 * Overpass ways to segments, splitting each way at any hole rather than dropping it.
 *
 * This is the one place where the routing ingest deliberately disagrees with
 * `wayToCoords`. The catalogue drops a clipped way whole, because a trail with an
 * interpolated hole through it is a wrong trail and the neighbouring tile will supply a
 * correct one. A graph has no such luxury: dropping the way removes a *connection*, and
 * the resulting dead end is indistinguishable from real topology. Splitting keeps both
 * halves, each true, and the tile that owns the middle contributes the join.
 *
 * Elevations come back as zeros; `elevateSegments` fills them. Keeping the two apart means
 * the geometry step is synchronous and testable without a terrain source.
 */
export function waysToSegments(elements: readonly OverpassElement[]): PathSegment[] {
  const segments: PathSegment[] = [];

  for (const element of elements) {
    if (element.type !== 'way') continue;
    const way: OverpassWay = element;
    const classified = classifyWay(way.tags);
    if (!classified || !way.geometry) continue;

    let run: number[] = [];
    const flush = () => {
      if (run.length >= 4) {
        segments.push({
          wayId: way.id,
          ...classified,
          coords: run,
          eleM: Array.from({ length: run.length >> 1 }, () => 0),
        });
      }
      run = [];
    };

    for (const point of way.geometry) {
      if (typeof point.lat !== 'number' || typeof point.lon !== 'number') {
        flush();
        continue;
      }
      run.push(point.lon, point.lat);
    }
    flush();
  }

  return segments;
}

/**
 * Ground elevation at every vertex, in one batched pass over the whole tile.
 *
 * Deliberately *not* `elevateLine`. That resamples to a fixed 25 m spacing, which is right
 * for a profile chart and wrong for a graph — the resampled points are not OSM nodes, so
 * two ways that share a junction would stop sharing a coordinate and the network would
 * fall apart into disconnected fragments. Here the vertices are the graph, so they are
 * sampled exactly where they lie.
 *
 * Batching matters: a z12 tile is tens of thousands of vertices across maybe a dozen
 * terrain tiles, and `tilesFor` fetches each of those once for all of them.
 */
export async function elevateSegments(
  segments: readonly PathSegment[],
  terrain: TerrainSource,
  zoom = TERRARIUM_ZOOM,
): Promise<{ segments: PathSegment[]; gapCount: number }> {
  const all: LngLat[] = [];
  for (const segment of segments) {
    for (let i = 0; i < segment.coords.length; i += 2) {
      all.push([segment.coords[i]!, segment.coords[i + 1]!]);
    }
  }
  if (all.length === 0) return { segments: [], gapCount: 0 };

  const tiles = await terrain.tilesFor(all, zoom);
  const { filled, gapCount } = fillGaps(sampleElevations(all, tiles, zoom));

  let cursor = 0;
  const out = segments.map((segment) => {
    const count = segment.coords.length >> 1;
    const eleM = filled.slice(cursor, cursor + count);
    cursor += count;
    return { ...segment, eleM };
  });

  return { segments: out, gapCount };
}

/**
 * The bbox to actually ask Overpass for: the tile, grown by the pad.
 *
 * Longitude is scaled by `1/cos(lat)` so the pad is 250 m on the ground at every latitude
 * rather than 250 m at the equator and 60 m in northern Norway. Clamped at the poles, where
 * the scaling diverges and the whole idea stops meaning anything.
 */
export function padBBox(bbox: BBox, padDeg = ROUTING_TILE_PAD_DEG): BBox {
  const [w, s, e, n] = bbox;
  const midLat = (s + n) / 2;
  const lngPad = padDeg / Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
  return [
    Math.max(-180, w - lngPad),
    Math.max(-85, s - padDeg),
    Math.min(180, e + lngPad),
    Math.min(85, n + padDeg),
  ];
}

/**
 * How much of a tile's payload is worth keeping, as a rough byte count.
 *
 * Used only to decide whether a tile is pathologically large before it is written. A z12
 * tile in open country is a few hundred kilobytes; one over central London is tens of
 * megabytes of alley and parking aisle, and a planner does not need that resolution to get
 * someone out of a city.
 */
export function segmentsBytes(segments: readonly PathSegment[]): number {
  let bytes = 0;
  for (const segment of segments)
    bytes += segment.coords.length * 9 + (segment.name?.length ?? 0) + 48;
  return bytes;
}

/**
 * The point past which a tile is trimmed rather than written whole.
 *
 * A z12 tile in open country is a few hundred kilobytes. The same tile over central London
 * is the entire street network plus every parking aisle and alley, and writing it costs more
 * than the routes it enables are worth.
 */
export const MAX_TILE_BYTES = 12_000_000;

/**
 * Bring an oversized tile under budget by dropping the road network, keeping the foot one.
 *
 * The honest trade, stated plainly: in a dense city this can disconnect two footpaths that
 * were only joined by a residential street, and a route across that join will come back as
 * "no path found" rather than as a bad route. That is the better failure. The alternative —
 * truncating at an arbitrary row count — drops ways in Overpass's order, which is to say at
 * random, and produces a network with holes nobody can predict or explain.
 *
 * Paths are never dropped, so a tile that is still over budget with roads gone is written
 * over budget. At that point the size is the pedestrian network itself, which is the data
 * we came for.
 */
export function trimForBudget(
  segments: readonly PathSegment[],
  maxBytes = MAX_TILE_BYTES,
): { segments: PathSegment[]; dropped: number } {
  if (segmentsBytes(segments) <= maxBytes) return { segments: [...segments], dropped: 0 };
  const kept = segments.filter((segment) => segment.kind !== 'road');
  return { segments: kept, dropped: segments.length - kept.length };
}

/**
 * How many distinct coordinates the tile contributes — the graph's node count.
 *
 * Rounded to seven decimals, matching `buildGraph`'s interning, so this is the number of
 * nodes the tile will actually produce rather than the number of vertices it stores. The
 * difference is large: a junction shared by four ways is four vertices and one node.
 */
export function countNodes(segments: readonly PathSegment[]): number {
  const seen = new Set<string>();
  for (const segment of segments) {
    for (let i = 0; i < segment.coords.length; i += 2) {
      seen.add(`${segment.coords[i]!.toFixed(7)},${segment.coords[i + 1]!.toFixed(7)}`);
    }
  }
  return seen.size;
}

/**
 * Routing tiles go stale on the same 30-day clock as trail tiles.
 *
 * Same reasoning, same number, deliberately not shared as a constant: these are two caches
 * of two different queries, and the day one of them wants a different TTL, it should be able
 * to have one without an edit that silently changes the other.
 */
export const ROUTING_TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether a routing tile's cached network is still good enough to plan on. */
export function isRoutingTileFresh(
  tile: { status: TileStatus; fetchedAt: Date | null } | null,
  now: Date,
  ttlMs = ROUTING_TILE_TTL_MS,
): boolean {
  if (!tile?.fetchedAt) return false;
  if (tile.status !== TileStatus.ready && tile.status !== TileStatus.empty) return false;
  return now.getTime() - tile.fetchedAt.getTime() < ttlMs;
}

export interface ProcessNetworkTileResult {
  quadkey: string;
  status: TileStatus;
  segmentCount: number;
  nodeCount: number;
  /** Vertices the terrain source could not answer for, filled by interpolation. */
  gapCount: number;
  /** Road segments discarded to bring an oversized tile under budget. */
  dropped: number;
  fetchMs: number;
}

/** Rows per `createMany`. Postgres takes one parameter per column per row; this stays clear of the 65,535 cap. */
const WRITE_CHUNK = 500;

/**
 * Fetch and cache the walkable network for one z12 tile.
 *
 * Shaped after `processTile` and diverging in one respect: there is no per-segment failure
 * isolation, because there is no per-segment work to isolate. A trail is derived, enriched
 * and committed individually, so one bad geometry costs one row; a network segment is
 * geometry and nothing else, and the whole tile is written in one statement. If that
 * statement fails the tile failed, which is the truth.
 */
export async function processNetworkTile(
  quadkey: string,
  deps: PipelineDeps,
): Promise<ProcessNetworkTileResult> {
  const db = deps.db ?? backgroundPrisma;
  const now = deps.now ?? (() => new Date());
  const log = deps.logger ?? (() => {});
  const terrain = deps.terrain ?? new TerrainSource({ fetchImpl: deps.fetchImpl });

  const tile = quadkeyToTile(quadkey);
  if (tile.z !== ROUTING_ZOOM) {
    throw new Error(
      `processNetworkTile expects a z${ROUTING_ZOOM} quadkey, got z${tile.z} (${quadkey})`,
    );
  }
  const bbox = quadkeyToBBox(quadkey);
  const startedAt = Date.now();

  await db.routingTile.upsert({
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
    const response = await deps.overpass.query(buildNetworkQuery(padBBox(bbox)));
    elements = response.elements ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.routingTile.update({
      where: { quadkey },
      data: { status: TileStatus.failed, lastError: message.slice(0, 1000) },
    });
    // Same contract as the trail pipeline: a breaker-open is the service's problem, not this
    // tile's, and rethrowing lets the queue back off instead of burning an attempt.
    if (error instanceof OverpassUnavailableError) throw error;
    throw error;
  }

  const parsed = waysToSegments(elements);
  const { segments: budgeted, dropped } = trimForBudget(parsed);
  log('network parsed', { quadkey, elements: elements.length, segments: budgeted.length, dropped });

  if (budgeted.length === 0) {
    await db.$transaction([
      db.pathSegmentRow.deleteMany({ where: { quadkey } }),
      db.routingTile.update({
        where: { quadkey },
        data: {
          status: TileStatus.empty,
          fetchedAt: now(),
          segmentCount: 0,
          nodeCount: 0,
          lastError: null,
          fetchMs: Date.now() - startedAt,
        },
      }),
    ]);
    return {
      quadkey,
      status: TileStatus.empty,
      segmentCount: 0,
      nodeCount: 0,
      gapCount: 0,
      dropped,
      fetchMs: Date.now() - startedAt,
    };
  }

  const { segments, gapCount } = await elevateSegments(budgeted, terrain);
  const nodeCount = countNodes(segments);

  /**
   * `run` disambiguates the several rows one way can produce — a way split at a hole, or a
   * way whose geometry the tile clips into two pieces. Numbered per way in arrival order,
   * which is stable for a given Overpass response and irrelevant across responses, since the
   * whole tile is replaced at once.
   */
  const runs = new Map<number, number>();
  const rows = segments.map((segment) => {
    const run = runs.get(segment.wayId) ?? 0;
    runs.set(segment.wayId, run + 1);
    let w = Infinity;
    let s = Infinity;
    let e = -Infinity;
    let n = -Infinity;
    for (let i = 0; i < segment.coords.length; i += 2) {
      const lng = segment.coords[i]!;
      const lat = segment.coords[i + 1]!;
      if (lng < w) w = lng;
      if (lng > e) e = lng;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
    return {
      quadkey,
      wayId: BigInt(segment.wayId),
      run,
      kind: segment.kind,
      name: segment.name,
      surface: segment.surface,
      sacScale: segment.sacScale,
      coords: segment.coords,
      eleM: segment.eleM,
      bboxW: w,
      bboxS: s,
      bboxE: e,
      bboxN: n,
    };
  });

  /**
   * Replace rather than merge, in one transaction.
   *
   * A tile's segments are meaningful only as a set: OSM renumbers nothing, but a way deleted
   * upstream leaves a row that upserting would never touch and the graph would keep routing
   * over. Delete-then-insert is the only version of this that can remove things, and doing it
   * in a transaction means a reader never sees the half-empty middle.
   */
  await db.$transaction(
    async (tx) => {
      await tx.pathSegmentRow.deleteMany({ where: { quadkey } });
      for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
        await tx.pathSegmentRow.createMany({ data: rows.slice(i, i + WRITE_CHUNK) });
      }
      await tx.routingTile.update({
        where: { quadkey },
        data: {
          status: TileStatus.ready,
          fetchedAt: now(),
          segmentCount: rows.length,
          nodeCount,
          lastError: null,
          fetchMs: Date.now() - startedAt,
        },
      });
    },
    { timeout: 120_000 },
  );

  return {
    quadkey,
    status: TileStatus.ready,
    segmentCount: rows.length,
    nodeCount,
    gapCount,
    dropped,
    fetchMs: Date.now() - startedAt,
  };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/**
 * Priority for a routing tile somebody is planning on.
 *
 * Below `VIEWPORT_PRIORITY`, because a blank map is a worse thing to be staring at than a
 * planner that has not offered to snap yet — the planner still draws freehand meanwhile.
 * Above the area sweep, because this one has a person waiting on it.
 */
export const NETWORK_PRIORITY = 4;

/**
 * How many z12 tiles one planning viewport may pull.
 *
 * Nine is a 3×3 block, roughly 30 km across — a day's hike in any direction from the middle,
 * which is the honest limit of what one route is going to cover. Past that the planner asks
 * the user to zoom in, and says why.
 */
export const MAX_ROUTING_TILES = 9;

export interface NetworkCoverage {
  quadkeys: string[];
  /** Tiles whose network can be planned on right now. */
  ready: string[];
  /** Tiles with nothing to plan on yet. */
  pending: string[];
  /** What this call put on the queue. */
  queued: string[];
  tooLarge: boolean;
  requiredTiles: number;
  maxTiles: number;
}

export interface NetworkCoverageOptions {
  db?: PrismaClient;
  now?: Date;
  maxTiles?: number;
  /** Set false to survey without queueing — the read half, for a "what do we hold" probe. */
  queue?: boolean;
}

/**
 * Work out which routing tiles a planning viewport needs, and queue what is missing.
 *
 * The trail equivalent (`ensureCoverage`) distinguishes `refreshing` from `pending`, because
 * a month-old trail is still worth drawing while its refresh runs. This one does not: a
 * month-old path network is equally worth planning on, so a stale-but-present tile is simply
 * `ready` and its refresh is queued behind the scenes with nothing said about it.
 */
export async function ensureNetworkCoverage(
  bbox: BBox,
  options: NetworkCoverageOptions = {},
): Promise<NetworkCoverage> {
  const db = options.db ?? prisma;
  const now = options.now ?? new Date();
  const maxTiles = options.maxTiles ?? MAX_ROUTING_TILES;

  const cover = coverBBox(bbox, ROUTING_ZOOM, maxTiles);
  if (cover.tooLarge) {
    return {
      quadkeys: [],
      ready: [],
      pending: [],
      queued: [],
      tooLarge: true,
      requiredTiles: cover.requiredTiles,
      maxTiles,
    };
  }

  const existing = await db.routingTile.findMany({
    where: { quadkey: { in: cover.quadkeys } },
    select: { quadkey: true, status: true, fetchedAt: true },
  });
  const byKey = new Map(existing.map((tile) => [tile.quadkey, tile]));

  const ready: string[] = [];
  const pending: string[] = [];
  const needsWork: string[] = [];

  for (const quadkey of cover.quadkeys) {
    const tile = byKey.get(quadkey) ?? null;
    if (isRoutingTileFresh(tile, now)) {
      ready.push(quadkey);
      continue;
    }
    needsWork.push(quadkey);
    if (tile?.status === TileStatus.ready || tile?.status === TileStatus.empty) ready.push(quadkey);
    else pending.push(quadkey);
  }

  const queued = options.queue === false ? [] : await queueNetworkTiles(db, needsWork);

  return {
    quadkeys: cover.quadkeys,
    ready,
    pending,
    queued,
    tooLarge: false,
    requiredTiles: cover.requiredTiles,
    maxTiles,
  };
}

/** Register routing tiles and enqueue their fetches. Tile row first, for the reason `queueTiles` gives. */
export async function queueNetworkTiles(
  db: PrismaClient,
  quadkeys: readonly string[],
  priority = NETWORK_PRIORITY,
): Promise<string[]> {
  for (const quadkey of quadkeys) {
    const { x, y, z } = quadkeyToTile(quadkey);
    const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(quadkey);

    await db.routingTile.upsert({
      where: { quadkey },
      create: { quadkey, x, y, z, status: TileStatus.pending, bboxW, bboxS, bboxE, bboxN },
      update: {},
    });

    await enqueue(db, {
      kind: JobKind.ingest_network,
      dedupeKey: networkJobKey(quadkey),
      payload: { quadkey },
      priority,
    });
  }

  return [...quadkeys];
}

/** True while any of these tiles still has a network fetch queued or running. */
export async function networkTilesInFlight(
  db: PrismaClient,
  quadkeys: readonly string[],
): Promise<string[]> {
  if (quadkeys.length === 0) return [];
  const jobs = await db.ingestJob.findMany({
    where: {
      dedupeKey: { in: quadkeys.map(networkJobKey) },
      status: { in: [JobStatus.queued, JobStatus.running] },
    },
    select: { dedupeKey: true },
  });
  const inFlight = new Set(jobs.map((job) => job.dedupeKey));
  return quadkeys.filter((quadkey) => inFlight.has(networkJobKey(quadkey)));
}

function numbers(value: Prisma.JsonValue): number[] {
  return Array.isArray(value) ? (value as number[]) : [];
}

/**
 * Read back every cached segment for a set of tiles, ready for `buildGraph`.
 *
 * Deliberately returns the cross-tile duplicates rather than filtering them: the padded
 * fetch means neighbouring tiles hold overlapping copies of the same way, carrying identical
 * OSM node coordinates, and `buildGraph`'s edge set reconciles them for free. Filtering here
 * would mean choosing which copy to keep, which is a decision with no correct answer and a
 * real chance of dropping the half that reaches across the boundary.
 */
export async function loadNetworkSegments(
  db: PrismaClient,
  quadkeys: readonly string[],
): Promise<PathSegment[]> {
  if (quadkeys.length === 0) return [];
  const rows = await db.pathSegmentRow.findMany({
    where: { quadkey: { in: [...quadkeys] } },
    select: {
      wayId: true,
      kind: true,
      name: true,
      surface: true,
      sacScale: true,
      coords: true,
      eleM: true,
    },
  });

  return rows.map((row) => ({
    wayId: Number(row.wayId),
    kind: row.kind as PathKind,
    name: row.name,
    surface: row.surface,
    sacScale: row.sacScale,
    coords: numbers(row.coords),
    eleM: numbers(row.eleM),
  }));
}
