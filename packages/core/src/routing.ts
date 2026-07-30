import { z } from 'zod';
import { SAC_SCALES } from './difficulty';
import { VISIBILITIES } from './profile';
import type { Visibility } from './profile';
import { slugify } from './text';
import {
  ACTIVITY_TYPES,
  bboxSchema,
  elevationPointSchema,
  lineStringSchema,
  lngLatSchema,
  trailStatsSchema,
} from './types';

/**
 * Planning a route of your own.
 *
 * The catalogue answers "where shall I hike"; this answers "I want to hike *here*, and
 * here, and then back to the car". They need different data. A trail is one assembled,
 * named, curated line — `assembleTrails` keeps the primary line of a route relation and
 * drops everything under 200 m. That is exactly right for a catalogue and exactly wrong
 * for routing: the 150 m unnamed connector between two trails is the piece that makes a
 * loop possible, and it is the first thing the catalogue throws away.
 *
 * So planning runs on its own cache of the walkable network — every foot-legal way in an
 * area, named or not — fetched lazily per routing tile, the same on-demand pattern the
 * trail ingest uses. See `@switchback/geo`'s `graph` module for what is built from it.
 */

/**
 * The kinds of way a hiker can legally and sensibly use.
 *
 * Narrower than "everything OSM tags as `highway`" and wider than "trails". A route that
 * refuses to touch a road cannot leave most car parks; a route that treats a dual
 * carriageway as walkable will get someone killed. The list is the middle: dedicated
 * hiking infrastructure, the tracks and lanes that connect it, and the quiet roads that
 * are often the only link between two path networks.
 *
 * `road` collapses OSM's residential / unclassified / service / living_street into one
 * bucket, because for a hiker the distinction between them is not worth carrying — they
 * are all "tarmac you hike along to reach the path", and they all get the same penalty.
 */
export const PATH_KINDS = [
  'path',
  'footway',
  'track',
  'bridleway',
  'steps',
  'cycleway',
  'pedestrian',
  'road',
] as const;
export type PathKind = (typeof PATH_KINDS)[number];

/**
 * One run of walkable geometry, as cached and as shipped to a client.
 *
 * A *run*, not a way: a way arriving from Overpass with nodes missing (they sat outside
 * the query box) is split at the holes rather than dropped, so the neighbouring tile can
 * contribute the middle. The graph builder rejoins them, because both runs carry the real
 * OSM node coordinates and those match exactly.
 */
export const pathSegmentSchema = z.object({
  /** OSM way id. Not unique across segments — one way can yield several runs. */
  wayId: z.number().int(),
  kind: z.enum(PATH_KINDS),
  name: z.string().nullable().default(null),
  surface: z.string().nullable().default(null),
  sacScale: z.enum(SAC_SCALES).nullable().default(null),
  /** `[lng, lat, lng, lat, …]`, flattened. Halves the JSON of an array of pairs. */
  coords: z.array(z.number()),
  /** Ground elevation in metres, one per coordinate pair. */
  eleM: z.array(z.number()),
});
export type PathSegment = z.infer<typeof pathSegmentSchema>;

/**
 * A point the planner was told to pass through.
 *
 * `freehand` describes the leg *arriving* at this anchor, not the anchor itself. It rides
 * here rather than on a separate leg array because anchors and legs are off by one and
 * keeping them in one list is what makes "delete anchor 3" a single splice instead of two
 * correlated ones. The first anchor's flag is meaningless and ignored.
 */
export const routeAnchorSchema = z.object({
  lng: z.number(),
  lat: z.number(),
  freehand: z.boolean().default(false),
});
export type RouteAnchor = z.infer<typeof routeAnchorSchema>;

/**
 * Who can see a saved route.
 *
 * The app-wide ladder from `profile.ts`, not one of its own. A product that gives routes a
 * private/unlisted/public scale and activities a private/followers/public one has two
 * privacy models, and the person choosing between them has to learn which page they are on
 * before they can predict what "public" does. One ladder, one meaning, everywhere.
 */
export const PLANNED_ROUTE_VISIBILITIES = VISIBILITIES;
export type PlannedRouteVisibility = Visibility;

/**
 * Why a leg came back as a straight line instead of following the network.
 *
 * Every one of these is shown to the user, so they are reasons rather than error codes. A
 * planner that silently draws a straight line across a lake because the path graph had a
 * hole is worse than one that says it could not find a path — the first produces a route
 * somebody might actually try to hike.
 */
export const ROUTE_LEG_REASONS = [
  /** The user asked for a straight line. Not a failure. */
  'freehand',
  /** One end of the leg was too far from any known way to snap to it. */
  'off_network',
  /** Both ends snapped, but no walkable connection exists between them in what we hold. */
  'no_path',
  /** The network for this ground has not finished downloading. Retrying will likely work. */
  'network_pending',
  /**
   * The server declined to fetch the network for this ground, so nothing is downloading.
   *
   * Distinct from `network_pending`, and the distinction is the whole point of the reason
   * existing: waiting fixes a pending tile and does nothing for a refused one. Distinct from
   * `off_network`/`no_path` for a much sharper reason — those two are claims about the
   * terrain, and a leg over ground we chose not to fetch supports no claim about the terrain
   * at all. Before this existed, backpressure made the planner tell people that stretches of
   * their route had no path under them, as a safety warning, about ground it had never
   * looked at.
   */
  'network_paused',
] as const;
export type RouteLegReason = (typeof ROUTE_LEG_REASONS)[number];

/**
 * One leg of a plan: the stretch arriving at anchor `to`, from anchor `to - 1`.
 *
 * Reported per leg rather than per route because the answer genuinely varies along one
 * line. A five-anchor route can have four legs on good path and one crossing a valley the
 * network does not cover, and rolling that up into a single "partially snapped" flag would
 * hide *which* part the user needs to look at.
 */
export const routeLegSchema = z.object({
  to: z.number().int().positive(),
  /** False when this leg is a straight line — by request, or because nothing else was possible. */
  snapped: z.boolean(),
  reason: z.enum(ROUTE_LEG_REASONS).nullable(),
  lengthM: z.number().nonnegative(),
  /**
   * Where this leg begins and ends *on the drawn line*, which is not always where the user
   * put the anchor — a snapped anchor sits on the nearest way, up to 120 m from the click.
   *
   * Both endpoints ride along because a client cannot derive them. The route arrives as one
   * geometry simplified to 5 m, so slicing it back into legs by cumulative length drifts, and
   * an anchor between one snapped leg and one freehand leg is at a position only the server
   * ever computed. Four numbers per leg is what lets a straight-line stretch be drawn as a
   * straight-line stretch rather than described in a caption beside a solid line.
   */
  start: lngLatSchema,
  end: lngLatSchema,
});
export type RouteLeg = z.infer<typeof routeLegSchema>;

/** What the planner returns for a set of anchors. Recomputed on every edit. */
export const routePlanSchema = z.object({
  geometry: lineStringSchema.nullable(),
  profile: z.array(elevationPointSchema),
  stats: trailStatsSchema,
  legs: z.array(routeLegSchema),
  /** Routing tiles still downloading under these anchors. The planner says so rather than pretending. */
  pendingTiles: z.number().int().nonnegative(),
  /**
   * True when the server refused to fetch the network under these anchors.
   *
   * Separate from `pendingTiles` because zero pending means two opposite things: we hold
   * everything, or we declined to go and get it. The planner needs to tell them apart —
   * `pendingTiles` drives both the "fetching" line and the retry loop, and a refusal that
   * arrives as a zero switches the retry off while the legs quietly turn into terrain
   * claims. Defaulted, so a response from before this field existed still parses.
   */
  busy: z.boolean().default(false),
  /** True when the anchors span more ground than one plan may cover. */
  tooLarge: z.boolean(),
});
export type RoutePlan = z.infer<typeof routePlanSchema>;

/** The shape a saved-route card needs. No geometry — a list of twenty draws no lines. */
export const plannedRouteSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  activityType: z.enum(ACTIVITY_TYPES),
  visibility: z.enum(PLANNED_ROUTE_VISIBILITIES),
  stats: trailStatsSchema,
  centroid: z.tuple([z.number(), z.number()]),
  bbox: bboxSchema,
  anchorCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  owner: z.object({ id: z.string(), name: z.string().nullable(), image: z.string().nullable() }),
});
export type PlannedRouteSummary = z.infer<typeof plannedRouteSummarySchema>;

export const plannedRouteDetailSchema = plannedRouteSummarySchema.extend({
  geometry: lineStringSchema,
  profile: z.array(elevationPointSchema),
  /** Kept so the route can be reopened in the planner and edited, not just viewed. */
  anchors: z.array(routeAnchorSchema),
  /** True when the viewer owns this route and may edit or delete it. */
  editable: z.boolean(),
});
export type PlannedRouteDetail = z.infer<typeof plannedRouteDetailSchema>;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * How many points one route may be built from.
 *
 * Not a technical limit — A* over a viewport graph would happily take a thousand. It is the
 * point past which the thing being described stops being a route and starts being a traced
 * line, and every leg is a search, so the cost of an accidental double-click storm is
 * bounded rather than open-ended.
 */
export const MAX_ROUTE_ANCHORS = 60;

export const ROUTE_NAME_MAX = 80;
export const ROUTE_DESCRIPTION_MAX = 2_000;

export const routePlanInputSchema = z.object({
  anchors: z.array(routeAnchorSchema).max(MAX_ROUTE_ANCHORS),
  /** See `RouteCostOptions.preferPaths` — off means "fastest", on means "nicest". */
  preferPaths: z.boolean().default(true),
});
export type RoutePlanInput = z.infer<typeof routePlanInputSchema>;

/**
 * What gets saved: the anchors, never the line.
 *
 * The server replans from these before writing, so the stored geometry is always something
 * this codebase produced. That removes a trust surface — no client can post a route through
 * a cliff and have it served back as ours — and it removes a payload, since the anchors of
 * a 30 km route are a few hundred bytes against a few hundred kilobytes of geometry.
 */
export const routeSaveSchema = routePlanInputSchema.extend({
  name: z.string().trim().min(1).max(ROUTE_NAME_MAX),
  description: z.string().trim().max(ROUTE_DESCRIPTION_MAX).nullish(),
  activityType: z.enum(ACTIVITY_TYPES).default('hiking'),
  visibility: z.enum(PLANNED_ROUTE_VISIBILITIES).default('private'),
});
export type RouteSaveInput = z.infer<typeof routeSaveSchema>;

/**
 * An edit to a saved route.
 *
 * Every field optional, including the anchors: renaming a route should not require sending
 * its geometry back, and moving one waypoint should not require restating its name. Anchors
 * present means replan; anchors absent means leave the line exactly as it was.
 */
export const routeUpdateSchema = z.object({
  id: z.string().min(1).max(64),
  anchors: z.array(routeAnchorSchema).max(MAX_ROUTE_ANCHORS).optional(),
  preferPaths: z.boolean().optional(),
  name: z.string().trim().min(1).max(ROUTE_NAME_MAX).optional(),
  description: z.string().trim().max(ROUTE_DESCRIPTION_MAX).nullish(),
  activityType: z.enum(ACTIVITY_TYPES).optional(),
  visibility: z.enum(PLANNED_ROUTE_VISIBILITIES).optional(),
});
export type RouteUpdateInput = z.infer<typeof routeUpdateSchema>;

/** A saved route's URL segment. See `slugify` for why the fallback is a parameter. */
export function routeSlug(name: string): string {
  return slugify(name, 'route');
}
