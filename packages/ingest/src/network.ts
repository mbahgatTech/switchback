/**
 * The walkable network, cached per z12 tile for route planning. Separate from the trail
 * catalogue because the 150 m unnamed connector that makes a loop possible is the first thing
 * `pickPrimary` and `MIN_TRAIL_LENGTH_M` throw away. See `docs/architecture.md`.
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
import { admitIngest } from './backpressure';
import type { QueueOutcome, QueueRefusal } from './coverage';
import { spendIngestBudget } from './rate-limit';
import type { IngestPrincipal } from './rate-limit';
import { enqueue, networkJobKey } from './jobs';
import { OverpassUnavailableError } from './overpass';
import type { OverpassElement, OverpassWay } from './overpass';
import type { PipelineDeps } from './pipeline';

/**
 * Routing tiles are z12 — about 10 km across — against the catalogue's z9. This query keeps
 * every path, alley and service road, and a z9 tile over a city is hundreds of thousands of
 * ways and an Overpass timeout.
 */
export const ROUTING_ZOOM = 12;

/**
 * How far past the tile edge to fetch, in degrees of latitude — roughly 250 m. Without it a
 * way crossing the boundary is clipped and the graph gains a dead end where the network is
 * continuous. The overlap carries identical shared coordinates, so `buildGraph` fuses the two
 * copies with no merge step.
 */
export const ROUTING_TILE_PAD_DEG = 0.00225;

/**
 * Which OSM `highway` values become which `PathKind`. Two judgements: nothing above
 * `tertiary`, because hiking someone along a primary A-road is a valid route and a bad one;
 * and roads *are* included, because a route refusing tarmac cannot leave most car parks —
 * `KIND_PENALTY`, not exclusion, is the tool for "possible but unpleasant".
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
 * `service` values that are not through-routes. Forest and access tracks keep the bare
 * `service` tag or a value not listed here, and those are how a hiker reaches a trail.
 */
const BARRED_SERVICE = /^(driveway|parking_aisle|drive-through)$/u;

/**
 * Every way a hiker may legally use in the box. Note what is absent: the `["name"]` filter the
 * trail query carries, which is exactly wrong here — the connectors that make routes possible
 * are overwhelmingly unnamed. The access filters run server-side because they are the
 * difference between a response that fits in memory and one that does not; Overpass treats
 * `["k"!~"v"]` as satisfied when the key is absent, which matches OSM's default that a path is
 * walkable. `out body geom` because `tags` is a verbosity that would drop the geometry.
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

  // Re-checked here as well as in the query: a segment can arrive from a tile cached under an
  // older filter set, and the server-side test is a performance measure, not the definition.
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
 * Overpass ways to segments, splitting each way at any hole rather than dropping it. This
 * deliberately disagrees with `wayToCoords`: the catalogue drops a clipped way whole, but for
 * a graph that removes a *connection* and the dead end is indistinguishable from real
 * topology. Elevations come back as zeros; `elevateSegments` fills them, which keeps this step
 * synchronous and testable without a terrain source.
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
 * Ground elevation at every vertex, batched over the whole tile. Deliberately *not*
 * `elevateLine`: that resamples to 25 m, and resampled points are not OSM nodes, so two ways
 * sharing a junction would stop sharing a coordinate and the graph would fall apart. Here the
 * vertices are the graph, so they are sampled exactly where they lie.
 */
export async function elevateSegments(
  segments: readonly PathSegment[],
  terrain: TerrainSource,
  zoom = TERRARIUM_ZOOM,
  deadlineAt?: number,
): Promise<{ segments: PathSegment[]; gapCount: number }> {
  const all: LngLat[] = [];
  for (const segment of segments) {
    for (let i = 0; i < segment.coords.length; i += 2) {
      all.push([segment.coords[i]!, segment.coords[i + 1]!]);
    }
  }
  if (all.length === 0) return { segments: [], gapCount: 0 };

  const tiles = await terrain.tilesFor(all, zoom, deadlineAt);
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
 * The bbox to ask Overpass for: the tile, grown by the pad. Longitude is scaled by `1/cos(lat)`
 * so the pad is 250 m on the ground at every latitude, clamped near the poles where the
 * scaling diverges.
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

/** Rough byte count for a tile's payload, used only to spot a pathologically large one. */
export function segmentsBytes(segments: readonly PathSegment[]): number {
  let bytes = 0;
  for (const segment of segments)
    bytes += segment.coords.length * 9 + (segment.name?.length ?? 0) + 48;
  return bytes;
}

/**
 * The point past which a tile is trimmed rather than written whole. A z12 tile in open country
 * is a few hundred kilobytes; the same tile over central London is the entire street network.
 */
export const MAX_TILE_BYTES = 12_000_000;

/**
 * Bring an oversized tile under budget by dropping the road network and keeping the foot one.
 * The trade, stated plainly: in a dense city this can disconnect two footpaths joined only by
 * a residential street, and that route comes back "no path found" rather than as a bad route.
 * Truncating at a row count instead drops ways in Overpass's order — holes nobody can predict.
 * Paths are never dropped, so a tile still over budget with roads gone is written over budget.
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
 * How many distinct coordinates the tile contributes — the graph's node count. Rounded to
 * seven decimals to match `buildGraph`'s interning: a junction shared by four ways is four
 * vertices and one node.
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
 * Routing tiles go stale on the same 30-day clock as trail tiles. Deliberately not shared as
 * one constant: two caches of two different queries, either of which may want its own TTL.
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
 * Fetch and cache the walkable network for one z12 tile. Shaped after `processTile` but with
 * no per-segment failure isolation: a segment is geometry and nothing else, and the whole tile
 * is written in one statement, so a failure there means the tile failed.
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
    // A breaker-open is the service's problem, not this tile's; rethrowing lets the queue
    // back off instead of burning an attempt.
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

  const { segments, gapCount } = await elevateSegments(
    budgeted,
    terrain,
    TERRARIUM_ZOOM,
    deps.deadlineAt,
  );
  const nodeCount = countNodes(segments);

  /**
   * `run` disambiguates the several rows one way can produce — split at a hole, or clipped
   * into two pieces. Numbered per way in arrival order, which is irrelevant across responses
   * since the whole tile is replaced at once.
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
   * Replace rather than merge, in one transaction. A way deleted upstream leaves a row an
   * upsert would never touch and the graph would keep routing over; delete-then-insert is the
   * only version that can remove things, and the transaction hides the half-empty middle.
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

/**
 * Priority for a routing tile somebody is planning on. Below `VIEWPORT_PRIORITY` — a blank map
 * is worse to stare at than a planner that has not offered to snap yet — and above the area
 * sweep, which has nobody waiting on it.
 */
export const NETWORK_PRIORITY = 4;

/**
 * How many z12 tiles one planning viewport may pull. Nine is a 3×3 block, roughly 30 km
 * across; past that the planner asks the reader to zoom in, and says why.
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
  /**
   * True when ingest was refused, so the outstanding tiles are not on their way. Read by the
   * route planner, which is the only consumer that can be *wrong* about it: a leg over ground
   * we declined to fetch is not a leg with no path under it, and saying so on a hiking planner
   * is a false claim about terrain dressed as a safety warning. See `planRoute`.
   */
  busy: boolean;
  /**
   * Which refusal, when `busy`. Null otherwise. `/plan` needs the distinction: "try again
   * later" is right for a deep queue, wrong for a full database, which nobody can wait out,
   * and wrong again for a spent allowance, which is about this caller and nobody else.
   */
  busyReason: QueueRefusal | null;
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
  /** Who to charge new ground to. Null leaves only the product-wide ceilings applying. */
  principal?: IngestPrincipal | null;
}

/**
 * Work out which routing tiles a planning viewport needs, and queue what is missing. Unlike
 * `ensureCoverage` there is no `refreshing` state: a month-old path network is worth planning
 * on, so a stale-but-present tile is simply `ready` and its refresh runs unannounced.
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
      busy: false,
      busyReason: null,
      tooLarge: true,
      requiredTiles: cover.requiredTiles,
      maxTiles,
    };
  }

  /*
   * The job table is read to tell a tile nobody has asked for apart from one somebody is
   * already waiting on — `RoutingTile.status` cannot answer that, since a row sits at
   * `pending` whether its job is running or died five attempts ago.
   */
  const [existing, working] = await Promise.all([
    db.routingTile.findMany({
      where: { quadkey: { in: cover.quadkeys } },
      select: { quadkey: true, status: true, fetchedAt: true },
    }),
    networkTilesInFlight(db, cover.quadkeys),
  ]);
  const byKey = new Map(existing.map((tile) => [tile.quadkey, tile]));
  const inFlight = new Set(working);

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

  /*
   * The depth ceiling judges only new ground. `enqueue` upserts on `dedupeKey`, so refusing a
   * tile whose job is already queued bounds nothing — and the refusal reaches the planner as
   * `networkPaused`, which stops `use-plan.ts` re-planning while the tiles it needs land
   * unread behind it.
   */
  const newGround = needsWork.filter((quadkey) => !inFlight.has(quadkey));

  // Every outstanding tile is still handed to `queueNetworkTiles`; only `newGround` is what
  // admission may judge. Re-enqueueing an in-flight tile writes no row but does raise the
  // job's priority, which is how a tile a background sweep queued at 0 jumps the line.
  const enqueued =
    options.queue === false
      ? { queued: [] as string[], refused: null }
      : await queueNetworkTiles(db, needsWork, {
          newGround,
          principal: options.principal ?? null,
          now,
        });
  const queued = enqueued.queued;

  /*
   * New ground outstanding with nothing queued means backpressure refused it. Judged on
   * `newGround`, not `needsWork`: tiles already in flight are coming, and a refusal about
   * other ground says nothing about them.
   *
   * `pending` is left intact, unlike the trail side, where clearing it is what stops a
   * refusing database also taking a poll storm. Here `planRoute` uses it as the tiebreaker
   * between "still downloading" and "no path exists", and zeroing it relabelled every
   * unsnappable leg as open country. `busy` is what that reads now.
   */
  const busy = options.queue !== false && newGround.length > 0 && queued.length === 0;

  return {
    quadkeys: cover.quadkeys,
    ready,
    pending,
    queued,
    busy,
    busyReason: busy ? enqueued.refused : null,
    tooLarge: false,
    requiredTiles: cover.requiredTiles,
    maxTiles,
  };
}

/**
 * Register routing tiles and enqueue their fetches. Tile row first, for the reason
 * `queueTiles` gives. `newGround` narrows what admission is *judged* on without narrowing what
 * is enqueued: a quadkey already queued adds no row when re-enqueued, so refusing it bounds
 * nothing while telling the planner the network under those anchors is not coming.
 */
export async function queueNetworkTiles(
  db: PrismaClient,
  quadkeys: readonly string[],
  options: {
    priority?: number;
    /** The subset of `quadkeys` with nothing already on the queue. Defaults to all of them. */
    newGround?: readonly string[];
    /** Who to charge the new ground to. Null leaves only the product-wide ceilings applying. */
    principal?: IngestPrincipal | null;
    now?: Date;
  } = {},
): Promise<QueueOutcome> {
  if (quadkeys.length === 0) return { queued: [], refused: null };

  const newGround = options.newGround ?? quadkeys;
  const priority = options.priority ?? NETWORK_PRIORITY;

  // Nothing new to bound: the upserts below are all collisions, so they keep the priority
  // bump without asking the guard about work it has already admitted once.
  if (newGround.length > 0) {
    // The routing queue's share of the same ceiling — it enqueues `ingest_network`, which the
    // depth guard once did not count. See `backpressure.ts`.
    const refused = await admitIngest(db);
    if (refused !== null) return { queued: [], refused };

    // The caller's own share, from the same bucket the trail side spends: a planner and a map
    // pointed at the same cold ground are one person asking for it twice.
    const principal = options.principal ?? null;
    if (principal !== null) {
      const budget = await spendIngestBudget(db, principal, newGround.length, options.now);
      if (!budget.spent) return { queued: [], refused: 'rate-limit' };
    }
  }

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

  return { queued: [...quadkeys], refused: null };
}

/**
 * Which of these tiles still has a network fetch queued or running. Read by
 * `ensureNetworkCoverage` to keep already-queued tiles out of admission's way.
 */
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
 * Read back every cached segment for a set of tiles, ready for `buildGraph`. Deliberately
 * returns the cross-tile duplicates the padded fetch creates: they carry identical OSM node
 * coordinates and `buildGraph`'s edge set reconciles them, whereas filtering here would mean
 * choosing which copy to keep and risking the half that reaches across the boundary.
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
