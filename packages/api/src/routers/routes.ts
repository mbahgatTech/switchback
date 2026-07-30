/**
 * Routes: planning a line of your own, and keeping it.
 *
 * The catalogue answers "where shall I hike". This answers "I want to hike *here*, and then
 * here, and then back to the car" — and it runs on a different cache for the reason
 * `core/routing.ts` sets out: trail assembly keeps named, curated lines and throws away the
 * 150 m unnamed connector, which is the exact piece that makes a loop possible.
 *
 * **The client sends points, never lines.** Every plan and every save is computed here from
 * the anchors alone. That is one trust surface removed — nobody can post a route through a
 * cliff face and have it served back under our name — and one payload removed, since the
 * anchors of a 30 km route are a few hundred bytes against a few hundred kilobytes of
 * geometry. It also means a route saved today and reopened next year replans against
 * whatever OSM knows by then, rather than preserving a line whose path has since moved.
 *
 * **Why `plan` is a mutation when it plainly reads.** tRPC puts a query's input in the URL,
 * and sixty anchors is several kilobytes of it — close enough to the header ceiling that a
 * long route would start failing in production and nowhere else. The cache a query would buy
 * is worth little here anyway: every drag of a waypoint is a fresh key, so the hit rate is
 * near zero, and the one case that does repeat — undo — is served better by the anchor stack
 * the editor already keeps.
 *
 * The on-demand pattern is `trails.ts`'s, unchanged: ask `ensureNetworkCoverage` what we
 * hold, queue what is missing, plan on what is ready, and say how many tiles are still
 * coming. It never blocks on Overpass.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  bboxSchema,
  routePlanInputSchema,
  routeSaveSchema,
  routeSlug,
  routeUpdateSchema,
} from '@switchback/core';
import type {
  ElevationPoint,
  LineString,
  LngLat,
  PlannedRouteDetail,
  PlannedRouteSummary,
  RouteAnchor,
  RouteLeg,
  RouteLegReason,
  RoutePlan,
  RoutePlanInput,
  TrailStats,
} from '@switchback/core';
import { routeAnchorSchema, elevationPointSchema, lineStringSchema } from '@switchback/core';
import type { Prisma, PrismaClient, User } from '@switchback/db';
import {
  bboxOf,
  buildGraph,
  buildProfile,
  computeTrailStats,
  encodeBase64,
  findPath,
  lineLengthM,
  padBBox,
  pathGeometry,
  resampleLine,
  simplifyLine,
  snapToGraph,
  toFitCourse,
  toRouteGpx,
} from '@switchback/geo';
import type { RouteGraph, SnapResult } from '@switchback/geo';
import {
  centroidOf,
  drainIngest,
  elevateLine,
  ensureNetworkCoverage,
  getTerrain,
  loadNetworkSegments,
  networkJobKey,
} from '@switchback/ingest';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import type { Context } from '../context';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Profile spacing, and the vertex tolerance of the copy every client draws.
 *
 * Both restated from `pipeline.ts`, where they are module-private, because a planned route
 * and an ingested trail of the same shape must report the same numbers. Gain is measured
 * with a 10 m hysteresis threshold, so a profile sampled at 25 m and one sampled at 60 m do
 * not merely differ in resolution — they differ in *answer*. Two figures for one hike is the
 * kind of thing that reads as the product not knowing which of its own screens to believe.
 */
const PROFILE_SPACING_M = 25;
const RENDER_SIMPLIFY_M = 5;

/** Ceiling on the profile, matching `pipeline.ts`. Spacing widens rather than truncating. */
const MAX_PROFILE_POINTS = 6_000;

/**
 * How finely a straight leg is cut before terrain is read along it.
 *
 * Coarser than the profile spacing on purpose. A freehand leg is a line the user drew across
 * ground we have no path for; sampling it at 25 m would double the terrain reads to add
 * detail to the one part of the route that is already an approximation.
 */
const FREEHAND_SAMPLE_M = 50;

/**
 * Room around the anchors for the router to work in.
 *
 * A path between two points does not stay inside their bounding box — a switchback stack
 * climbing out of the corner of it is the ordinary case. A kilometre is enough for that and
 * small enough that it rarely pulls in another z12 tile, which at ~10 km across is the unit
 * this actually rounds to.
 */
const PLAN_PAD_M = 1_000;

/** How many queued routing tiles one request will drain on its response's coattails. */
const MAX_INLINE_DRAIN = 3;

/**
 * The built-graph cache.
 *
 * Dragging one waypoint replans the whole route, and rebuilding a nine-tile graph — a
 * database read of every segment plus node interning — on each frame would make the planner
 * feel like a batch job. The key is the ready quadkey set, so a tile landing mid-edit changes
 * the key and gets a fresh graph for free. The TTL only covers the other case: a tile
 * refreshed in place under an unchanged key.
 *
 * Three entries, because each one is tens of megabytes of typed arrays and this process also
 * has to serve everything else.
 */
const GRAPH_CACHE_MAX = 3;
const GRAPH_CACHE_TTL_MS = 5 * 60_000;

/** How many saved routes one hiker's index returns. */
const MAX_ROUTES_LISTED = 200;

// ---------------------------------------------------------------------------
// Ingest kick
// ---------------------------------------------------------------------------

/**
 * One inline drain at a time, process-wide.
 *
 * The same guard `trails.ts` keeps, and for the same reason: a map that pans across cold
 * ground fires a request per frame, and without this each one would start its own drain and
 * they would all hit Overpass together. A routing tile is the larger fetch of the two, so the
 * limit here is lower.
 */
let inlineDrain: Promise<unknown> | null = null;

function kickNetwork(ctx: Context, queued: readonly string[]): void {
  if (!ctx.waitUntil || queued.length === 0 || inlineDrain) return;
  const work = drainIngest({
    limit: Math.min(queued.length, MAX_INLINE_DRAIN),
    workerId: 'inline-network',
    dedupeKeys: queued.map(networkJobKey),
  })
    .catch(() => {
      /* Failures are recorded on the job row; see ingest_jobs.lastError. */
    })
    .finally(() => {
      inlineDrain = null;
    });
  inlineDrain = work;
  ctx.waitUntil(work);
}

// ---------------------------------------------------------------------------
// The graph
// ---------------------------------------------------------------------------

interface CachedGraph {
  key: string;
  graph: RouteGraph;
  builtAt: number;
}

const graphCache: CachedGraph[] = [];

/** The walkable graph over these tiles, built once and kept. Null when we hold nothing. */
async function graphFor(db: PrismaClient, quadkeys: readonly string[]): Promise<RouteGraph | null> {
  if (quadkeys.length === 0) return null;

  const key = [...quadkeys].sort().join(',');
  const now = Date.now();

  const hitAt = graphCache.findIndex((entry) => entry.key === key);
  if (hitAt >= 0) {
    const hit = graphCache[hitAt]!;
    graphCache.splice(hitAt, 1);
    if (now - hit.builtAt < GRAPH_CACHE_TTL_MS) {
      graphCache.unshift(hit);
      return hit.graph;
    }
  }

  const segments = await loadNetworkSegments(db, quadkeys);
  if (segments.length === 0) return null;

  const graph = buildGraph(segments);
  graphCache.unshift({ key, graph, builtAt: now });
  if (graphCache.length > GRAPH_CACHE_MAX) graphCache.length = GRAPH_CACHE_MAX;
  return graph;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

const EMPTY_STATS: TrailStats = {
  lengthM: 0,
  gainM: 0,
  lossM: 0,
  minEleM: 0,
  maxEleM: 0,
  maxSustainedGrade: null,
  estimatedTimeS: 0,
};

interface PlanOutcome {
  plan: RoutePlan;
  /**
   * The full-fidelity line, which never goes on the wire.
   *
   * `plan.geometry` is simplified to 5 m for drawing; the bbox and the centroid a save writes
   * are measured off this one, so a vertex the simplifier dropped cannot move either.
   */
  coords: LngLat[];
}

function emptyPlan(tooLarge: boolean, pendingTiles: number): PlanOutcome {
  return {
    plan: { geometry: null, profile: [], stats: EMPTY_STATS, legs: [], pendingTiles, tooLarge },
    coords: [],
  };
}

/** Profile spacing for a route of this length: 25 m until that would blow the point cap. */
function profileSpacingFor(lengthM: number): number {
  if (lengthM <= MAX_PROFILE_POINTS * PROFILE_SPACING_M) return PROFILE_SPACING_M;
  return Math.ceil(lengthM / MAX_PROFILE_POINTS / PROFILE_SPACING_M) * PROFILE_SPACING_M;
}

/** What one leg resolved to, before anchor positions are known. */
interface LegWork {
  snapped: boolean;
  reason: RouteLegReason | null;
  coords: LngLat[] | null;
  eleM: number[] | null;
}

/**
 * Ground elevation along a straight leg.
 *
 * Nulls rather than an exception on failure: terrain is a network call, and a leg the user
 * drew across country we have no path for is already an approximation. A plan that refuses to
 * return because a DEM tile timed out is a worse answer than one whose freehand stretch is
 * interpolated between the legs on either side, which is what `buildProfile` does with these.
 */
async function freehandElevations(coords: readonly LngLat[]): Promise<Array<number | null>> {
  if (coords.length === 0) return [];
  try {
    const elevated = await elevateLine(coords, getTerrain(), {
      spacingM: FREEHAND_SAMPLE_M,
      alongLengthM: lineLengthM(coords),
    });
    // Every sample fell in a tile we could not load, so the "filled" values are zeroes.
    // Sea level under an alpine traverse would wreck the gain figure; say nothing instead.
    if (elevated.gapCount >= elevated.points.length) return coords.map(() => null);
    return elevated.points.map((point) => point.eleM);
  } catch {
    return coords.map(() => null);
  }
}

/**
 * Elevation along the finished line, resampled to a fixed interval.
 *
 * Interpolated from the dense profile rather than re-read from terrain, which is free and
 * exact: the resampled points lie on the line by construction, so there is nothing a fresh
 * DEM read would tell us that the dense profile does not already hold.
 *
 * Distances come from `lengthM · i / (n−1)`, not from measuring the resampled line.
 * `resampleLine` drops its points at even intervals *along* the source, so the straight hops
 * between them cut every corner in between — measuring those instead is how a Mexico-to-Canada
 * thru-hike came to be published as a 3,214 km hike.
 */
function resampleProfile(
  dense: readonly ElevationPoint[],
  sampled: readonly LngLat[],
  lengthM: number,
): ElevationPoint[] {
  if (sampled.length === 0 || dense.length === 0) return [];
  if (sampled.length === 1 || lengthM <= 0) {
    const only = sampled[0]!;
    return [{ distM: 0, eleM: dense[0]!.eleM, lng: only[0], lat: only[1] }];
  }

  const out: ElevationPoint[] = [];
  let at = 0;
  for (let i = 0; i < sampled.length; i += 1) {
    const distM = (lengthM * i) / (sampled.length - 1);
    while (at < dense.length - 2 && dense[at + 1]!.distM < distM) at += 1;
    const a = dense[at]!;
    const b = dense[at + 1] ?? a;
    const span = b.distM - a.distM;
    const t = span > 0 ? Math.min(1, Math.max(0, (distM - a.distM) / span)) : 0;
    const point = sampled[i]!;
    out.push({
      distM: Math.round(distM * 10) / 10,
      eleM: Math.round((a.eleM + (b.eleM - a.eleM) * t) * 10) / 10,
      lng: point[0],
      lat: point[1],
    });
  }
  return out;
}

/**
 * Anchors in, route out.
 *
 * Three passes, because leg geometry and anchor positions each depend on the other and the
 * cycle has to be broken somewhere:
 *
 * 1. Resolve every leg — snapped and following the network, or a straight line and why. This
 *    is decided entirely from the snap results, so it needs no positions.
 * 2. Place every anchor. An anchor moves onto the network only if a leg touching it actually
 *    used the network; a route with no snapped legs keeps the user's exact points, which is
 *    what "freehand" has to mean or the word is a lie.
 * 3. Concatenate, sampling terrain along the straight legs as they are laid down.
 *
 * Each anchor is snapped once rather than once per leg. `snapToGraph` is deterministic, so
 * leg *i*'s start snap and leg *i−1*'s end snap are the same call — computing it twice halves
 * the throughput and opens the door to the two disagreeing.
 */
async function planRoute(ctx: Context, input: RoutePlanInput): Promise<PlanOutcome> {
  const anchors = input.anchors;
  if (anchors.length < 2) return emptyPlan(false, 0);

  const raw: LngLat[] = anchors.map((anchor) => [anchor.lng, anchor.lat]);
  const legCount = anchors.length - 1;

  // A route drawn entirely by hand needs no network at all, so it should not be refused for
  // covering more ground than the router can cache.
  const needsNetwork = anchors.some((anchor, index) => index > 0 && !anchor.freehand);

  let graph: RouteGraph | null = null;
  let pendingTiles = 0;

  if (needsNetwork) {
    const coverage = await ensureNetworkCoverage(padBBox(bboxOf(raw), PLAN_PAD_M), { db: ctx.db });
    if (coverage.tooLarge) return emptyPlan(true, 0);
    kickNetwork(ctx, coverage.queued);
    pendingTiles = coverage.pending.length;
    graph = await graphFor(ctx.db, coverage.ready);
  }

  const g = graph;
  const snapAt: Array<SnapResult | null> = g
    ? raw.map((point) => snapToGraph(g, point))
    : raw.map(() => null);

  // --- Pass 1: what each leg is ---------------------------------------------
  const work: LegWork[] = [];
  for (let to = 1; to <= legCount; to += 1) {
    if (anchors[to]!.freehand) {
      work.push({ snapped: false, reason: 'freehand', coords: null, eleM: null });
      continue;
    }

    const from = snapAt[to - 1];
    const arrive = snapAt[to];
    if (!g || !from || !arrive) {
      // A tile still downloading is the likelier explanation than genuinely open country,
      // and it is the one the user can do something about by waiting.
      work.push({
        snapped: false,
        reason: pendingTiles > 0 ? 'network_pending' : 'off_network',
        coords: null,
        eleM: null,
      });
      continue;
    }

    if (from.node === arrive.node) {
      // Two clicks on the same junction. A real leg of zero length, not a failure.
      work.push({
        snapped: true,
        reason: null,
        coords: [from.point, arrive.point],
        eleM: [g.eleM[from.node]!, g.eleM[arrive.node]!],
      });
      continue;
    }

    const path = findPath(g, from.node, arrive.node, { preferPaths: input.preferPaths });
    if (!path) {
      work.push({
        snapped: false,
        reason: pendingTiles > 0 ? 'network_pending' : 'no_path',
        coords: null,
        eleM: null,
      });
      continue;
    }

    const geometry = pathGeometry(g, path);
    work.push({ snapped: true, reason: null, coords: geometry.coords, eleM: geometry.eleM });
  }

  // --- Pass 2: where each anchor ends up ------------------------------------
  const posAt: LngLat[] = raw.map((point, index) => {
    const arriving = index > 0 ? work[index - 1]!.snapped : false;
    const departing = index < legCount ? work[index]!.snapped : false;
    const snap = snapAt[index];
    return (arriving || departing) && snap ? snap.point : point;
  });

  // --- Pass 3: lay the line down --------------------------------------------
  const coords: LngLat[] = [];
  const ele: Array<number | null> = [];
  const legs: RouteLeg[] = [];

  const push = (point: LngLat, eleM: number | null): void => {
    const last = coords[coords.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) {
      // The same ground twice, where one leg ends and the next begins. Keep whichever
      // elevation we actually know rather than letting a null overwrite a reading.
      if (ele[ele.length - 1] === null) ele[ele.length - 1] = eleM;
      return;
    }
    coords.push(point);
    ele.push(eleM);
  };

  push(posAt[0]!, null);

  for (let index = 0; index < legCount; index += 1) {
    const leg = work[index]!;
    const to = index + 1;

    let legCoords: LngLat[];
    let legEle: Array<number | null>;
    if (leg.snapped && leg.coords && leg.eleM) {
      legCoords = leg.coords;
      legEle = leg.eleM;
    } else {
      legCoords = resampleLine([posAt[index]!, posAt[to]!], FREEHAND_SAMPLE_M);
      legEle = await freehandElevations(legCoords);
    }

    // The joining point was pushed by the previous leg with whatever it knew, which for the
    // very first point of the route is nothing.
    if (ele.length > 0 && ele[ele.length - 1] === null) ele[ele.length - 1] = legEle[0] ?? null;
    for (let k = 1; k < legCoords.length; k += 1) push(legCoords[k]!, legEle[k] ?? null);

    legs.push({
      to,
      snapped: leg.snapped,
      reason: leg.reason,
      lengthM: Math.round(lineLengthM(legCoords)),
      start: legCoords[0] ?? posAt[index]!,
      end: legCoords[legCoords.length - 1] ?? posAt[to]!,
    });
  }

  if (coords.length < 2) return emptyPlan(false, pendingTiles);

  const lengthM = lineLengthM(coords);
  const dense = buildProfile(coords, ele);
  const sampled = resampleLine(coords, profileSpacingFor(lengthM));
  const profile = resampleProfile(dense, sampled, lengthM);

  return {
    plan: {
      geometry: { type: 'LineString', coordinates: simplifyLine(coords, RENDER_SIMPLIFY_M) },
      profile,
      stats: computeTrailStats(profile),
      legs,
      pendingTiles,
      tooLarge: false,
    },
    coords,
  };
}

/** A plan good enough to store, or the reason it is not — in words a user can act on. */
function plannable(outcome: PlanOutcome): LineString {
  if (outcome.plan.tooLarge) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That covers more ground than one route can be planned over. Split it in two.',
    });
  }
  if (!outcome.plan.geometry) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'A route needs at least two points.' });
  }
  return outcome.plan.geometry;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

const summarySelect = {
  id: true,
  userId: true,
  slug: true,
  name: true,
  description: true,
  activityType: true,
  visibility: true,
  anchors: true,
  lengthM: true,
  gainM: true,
  lossM: true,
  minEleM: true,
  maxEleM: true,
  maxSustainedGrade: true,
  estimatedTimeS: true,
  centroidLng: true,
  centroidLat: true,
  bboxW: true,
  bboxS: true,
  bboxE: true,
  bboxN: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, name: true, image: true } },
} satisfies Prisma.PlannedRouteSelect;

const detailSelect = {
  ...summarySelect,
  geometryJson: true,
  profile: true,
} satisfies Prisma.PlannedRouteSelect;

type SummaryRow = Prisma.PlannedRouteGetPayload<{ select: typeof summarySelect }>;
type DetailRow = Prisma.PlannedRouteGetPayload<{ select: typeof detailSelect }>;

/**
 * Parse the JSON columns rather than casting them.
 *
 * A cast asserts something about a column that a migration, a bad write, or a schema change
 * three months from now can quietly make false, and the failure then surfaces as an
 * unreadable client crash. Parsing turns the same fault into an empty array on a page that
 * still renders. Same treatment `trails.ts` gives `geometryJson`.
 */
const anchorsSchema = z.array(routeAnchorSchema);
const profileSchema = z.array(elevationPointSchema);

function readAnchors(value: Prisma.JsonValue): RouteAnchor[] {
  const parsed = anchorsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function readProfile(value: Prisma.JsonValue): ElevationPoint[] {
  const parsed = profileSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function readGeometry(value: Prisma.JsonValue): LineString {
  const parsed = lineStringSchema.safeParse(value);
  return parsed.success ? parsed.data : { type: 'LineString', coordinates: [] };
}

/**
 * The line an export should carry: the stored profile, or the drawn geometry if it is gone.
 *
 * The profile is the 25 m resample with ground under every point, which is what a device
 * needs — handed a 5 m-simplified line with no elevation, a watch guesses the ascent from
 * whatever DEM it ships with and shows a climb graph that is not this route's.
 *
 * The fallback matters more than it looks: a profile that failed to parse would otherwise
 * export as an empty file, which loads on a watch as a course with no course in it. A flat
 * line is a worse export and a much better failure. Shared by both exporters so the two
 * cannot disagree about what a route is.
 */
function exportPoints(row: {
  profile: Prisma.JsonValue;
  geometryJson: Prisma.JsonValue;
}): Array<{ lng: number; lat: number; eleM: number }> {
  const profile = readProfile(row.profile);
  if (profile.length >= 2) return profile;
  return readGeometry(row.geometryJson).coordinates.map(([lng, lat]) => ({ lng, lat, eleM: 0 }));
}

function toSummary(row: SummaryRow): PlannedRouteSummary {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    activityType: row.activityType,
    visibility: row.visibility,
    stats: {
      lengthM: row.lengthM,
      gainM: row.gainM,
      lossM: row.lossM,
      minEleM: row.minEleM,
      maxEleM: row.maxEleM,
      maxSustainedGrade: row.maxSustainedGrade,
      estimatedTimeS: row.estimatedTimeS,
    },
    centroid: [row.centroidLng, row.centroidLat],
    bbox: [row.bboxW, row.bboxS, row.bboxE, row.bboxN],
    anchorCount: readAnchors(row.anchors).length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    owner: { id: row.user.id, name: row.user.name, image: row.user.image },
  };
}

function toDetail(row: DetailRow, viewer: User | null): PlannedRouteDetail {
  return {
    ...toSummary(row),
    geometry: readGeometry(row.geometryJson),
    profile: readProfile(row.profile),
    anchors: readAnchors(row.anchors),
    editable: viewer?.id === row.userId,
  };
}

/**
 * A stranger sees a route only if it is public.
 *
 * `followers` resolves as private for everyone but the owner, exactly as it does for
 * activities — there is no follow graph yet, and the safe direction to be wrong in is the one
 * that does not hand a stranger a map of where somebody hikes.
 */
function canView(row: { userId: string; visibility: string }, viewer: User | null): boolean {
  return viewer?.id === row.userId || row.visibility === 'public';
}

/** Someone else's route answers 404, not 403 — the same reticence `lists.ts` keeps. */
async function ownRouteOrThrow(
  db: PrismaClient,
  id: string,
  userId: string,
): Promise<{ id: string }> {
  const row = await db.plannedRoute.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!row || row.userId !== userId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No such route.' });
  }
  return { id: row.id };
}

/** A free segment under `@@unique([userId, slug])`, so two "Ridge loop"s can coexist. */
async function uniqueSlug(
  db: PrismaClient,
  userId: string,
  name: string,
  exceptId?: string,
): Promise<string> {
  const base = routeSlug(name);
  const taken = new Set(
    (
      await db.plannedRoute.findMany({
        where: {
          userId,
          slug: { startsWith: base },
          ...(exceptId ? { id: { not: exceptId } } : {}),
        },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** The stat columns a write sets, from a freshly computed plan. */
function statColumns(outcome: PlanOutcome): {
  lengthM: number;
  gainM: number;
  lossM: number;
  minEleM: number;
  maxEleM: number;
  maxSustainedGrade: number;
  estimatedTimeS: number;
  centroidLng: number;
  centroidLat: number;
  bboxW: number;
  bboxS: number;
  bboxE: number;
  bboxN: number;
} {
  const stats = outcome.plan.stats;
  const bbox = bboxOf(outcome.coords);
  const centroid = centroidOf(outcome.plan.profile, outcome.coords);
  return {
    lengthM: stats.lengthM,
    gainM: stats.gainM,
    lossM: stats.lossM,
    minEleM: stats.minEleM,
    maxEleM: stats.maxEleM,
    // The column is non-null; the stat is null for a line too short to hold a 100 m window.
    maxSustainedGrade: stats.maxSustainedGrade ?? 0,
    estimatedTimeS: stats.estimatedTimeS,
    centroidLng: centroid[0],
    centroidLat: centroid[1],
    bboxW: bbox[0],
    bboxS: bbox[1],
    bboxE: bbox[2],
    bboxN: bbox[3],
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const routesRouter = router({
  /**
   * What the router can plan on, for this viewport.
   *
   * Called as the planner's map settles, before the user has clicked anything, so the first
   * tile fetch is already running by the time they place their second point. Returns counts
   * rather than quadkeys — the client has no use for the keys themselves, and a progress
   * line reading "2 of 4 areas ready" is the whole of what it needs to say.
   */
  coverage: publicProcedure.input(z.object({ bbox: bboxSchema })).query(async ({ ctx, input }) => {
    const coverage = await ensureNetworkCoverage(input.bbox, { db: ctx.db });
    kickNetwork(ctx, coverage.queued);
    return {
      ready: coverage.ready.length,
      pending: coverage.pending.length,
      // True when backpressure refused the fetch, so `pending` is zero for a reason other
      // than "we hold it all". See `backpressure.ts` in @switchback/ingest.
      busy: coverage.busy,
      tooLarge: coverage.tooLarge,
      requiredTiles: coverage.requiredTiles,
      maxTiles: coverage.maxTiles,
    };
  }),

  /** Plan a line through these points. See the module doc for why this is a mutation. */
  plan: publicProcedure
    .input(routePlanInputSchema)
    .mutation(async ({ ctx, input }): Promise<RoutePlan> => {
      const outcome = await planRoute(ctx, input);
      return outcome.plan;
    }),

  /** Every route the caller has saved, most recently touched first. */
  mine: protectedProcedure.query(async ({ ctx }): Promise<PlannedRouteSummary[]> => {
    const rows = await ctx.db.plannedRoute.findMany({
      where: { userId: ctx.user.id },
      select: summarySelect,
      orderBy: { updatedAt: 'desc' },
      take: MAX_ROUTES_LISTED,
    });
    return rows.map(toSummary);
  }),

  /**
   * One route, with the line and the anchors that made it.
   *
   * Public, because a public route is meant to open for someone without an account. The
   * anchors ride along so the viewer can take it into the planner and change it — saving
   * their own copy, since `editable` is false for anyone but the owner.
   */
  detail: publicProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }): Promise<PlannedRouteDetail> => {
      const row = await ctx.db.plannedRoute.findUnique({
        where: { id: input.id },
        select: detailSelect,
      });
      if (!row || !canView(row, ctx.user)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such route.' });
      }
      return toDetail(row, ctx.user);
    }),

  /** Keep a plan. The line is recomputed here from the anchors — the client's is not read. */
  save: protectedProcedure
    .input(routeSaveSchema)
    .mutation(async ({ ctx, input }): Promise<PlannedRouteDetail> => {
      const outcome = await planRoute(ctx, input);
      const geometry = plannable(outcome);

      const row = await ctx.db.plannedRoute.create({
        data: {
          userId: ctx.user.id,
          slug: await uniqueSlug(ctx.db, ctx.user.id, input.name),
          name: input.name,
          description: input.description?.trim() || null,
          activityType: input.activityType,
          visibility: input.visibility,
          geometryJson: geometry,
          anchors: input.anchors,
          profile: outcome.plan.profile,
          ...statColumns(outcome),
        },
        select: detailSelect,
      });
      return toDetail(row, ctx.user);
    }),

  /**
   * Change a saved route.
   *
   * Anchors present means replan and rewrite the line; anchors absent means leave it exactly
   * as it is. Renaming re-slugs, matching lists — a route whose URL still says
   * `/mountain-loop` after being renamed to "Coast path" is a worse kind of stale than a link
   * that has moved.
   */
  update: protectedProcedure
    .input(routeUpdateSchema)
    .mutation(async ({ ctx, input }): Promise<PlannedRouteDetail> => {
      const existing = await ownRouteOrThrow(ctx.db, input.id, ctx.user.id);

      const data: Prisma.PlannedRouteUpdateInput = {};
      if (input.name !== undefined) {
        data.name = input.name;
        data.slug = await uniqueSlug(ctx.db, ctx.user.id, input.name, existing.id);
      }
      if (input.description !== undefined) data.description = input.description?.trim() || null;
      if (input.activityType !== undefined) data.activityType = input.activityType;
      if (input.visibility !== undefined) data.visibility = input.visibility;

      if (input.anchors !== undefined) {
        const outcome = await planRoute(ctx, {
          anchors: input.anchors,
          preferPaths: input.preferPaths ?? true,
        });
        const geometry = plannable(outcome);
        const columns = statColumns(outcome);
        data.geometryJson = geometry;
        data.anchors = input.anchors;
        data.profile = outcome.plan.profile;
        data.lengthM = columns.lengthM;
        data.gainM = columns.gainM;
        data.lossM = columns.lossM;
        data.minEleM = columns.minEleM;
        data.maxEleM = columns.maxEleM;
        data.maxSustainedGrade = columns.maxSustainedGrade;
        data.estimatedTimeS = columns.estimatedTimeS;
        data.centroidLng = columns.centroidLng;
        data.centroidLat = columns.centroidLat;
        data.bboxW = columns.bboxW;
        data.bboxS = columns.bboxS;
        data.bboxE = columns.bboxE;
        data.bboxN = columns.bboxN;
      }

      const row = await ctx.db.plannedRoute.update({
        where: { id: existing.id },
        data,
        select: detailSelect,
      });
      return toDetail(row, ctx.user);
    }),

  remove: protectedProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ownRouteOrThrow(ctx.db, input.id, ctx.user.id);
      await ctx.db.plannedRoute.delete({ where: { id: existing.id } });
      return { removed: true };
    }),

  /**
   * The route as GPX, for a watch or a handheld.
   *
   * Built from the stored profile rather than the drawing geometry: the profile is the
   * 25 m line with ground under every point, and a device handed a 5 m-simplified line with
   * no elevation has to guess the ascent from whatever DEM it ships with.
   *
   * A query returning the document rather than a REST route serving it, matching
   * `activities.gpx` — the iOS app has no download folder to point a browser at and wants
   * the text to hand to the share sheet.
   */
  gpx: publicProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.plannedRoute.findUnique({
        where: { id: input.id },
        select: {
          userId: true,
          name: true,
          slug: true,
          description: true,
          activityType: true,
          visibility: true,
          profile: true,
          geometryJson: true,
        },
      });
      if (!row || !canView(row, ctx.user)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such route.' });
      }

      return {
        filename: `${row.slug}.gpx`,
        xml: toRouteGpx(exportPoints(row), {
          name: row.name,
          description: row.description,
          activityType: row.activityType,
        }),
      };
    }),

  /**
   * The same route as a FIT course — the format that actually loads onto a watch.
   *
   * This is where the difference between the two exports shows. A GPX route sideloaded to a
   * Fenix is a bare line: no climb graph before you start, no virtual partner, no summit
   * marked. The course file carries all three, built from data the planner already computed
   * — the 25 m profile for the ascent, and the Tobler estimate for the pace band.
   *
   * Returns base64 because FIT is binary and this is a JSON transport. `expo-file-system`
   * writes base64 directly; the web costs one `atob`.
   */
  fit: publicProcedure
    .input(z.object({ id: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const row = await ctx.db.plannedRoute.findUnique({
        where: { id: input.id },
        select: {
          userId: true,
          name: true,
          slug: true,
          activityType: true,
          visibility: true,
          profile: true,
          geometryJson: true,
          estimatedTimeS: true,
          createdAt: true,
        },
      });
      if (!row || !canView(row, ctx.user)) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such route.' });
      }

      return {
        filename: `${row.slug}.fit`,
        base64: encodeBase64(
          toFitCourse(exportPoints(row), {
            name: row.name,
            activityType: row.activityType,
            // A course has no real start time, so the file is stamped with the route's own
            // creation date. Deterministic on purpose: two downloads of an unchanged route
            // produce identical bytes, which is what stops a watch treating the second one as
            // a different course and stacking a duplicate beside the first.
            createdAt: row.createdAt,
            estimatedTimeS: row.estimatedTimeS,
          }),
        ),
      };
    }),
});
