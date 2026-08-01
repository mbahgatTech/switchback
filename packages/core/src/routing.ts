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
 * Planning a route of your own: anchors, legs, and the saved-route shapes. Planning runs on its
 * own lazily-cached network, not the trail catalogue, which drops the short unnamed connectors a
 * loop depends on — see `docs/architecture.md`.
 */

/** Ways a hiker may legally use. `road` collapses OSM's residential/unclassified/service. */
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
 * One run of walkable geometry. A *run*, not a way: a way whose nodes fall outside the query box
 * is split at the holes, and the graph builder rejoins the pieces on their OSM node coordinates.
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
 * A point the planner was told to pass through. `freehand` describes the leg *arriving* at this
 * anchor, and rides here so "delete anchor 3" stays one splice. The first anchor's is ignored.
 */
export const routeAnchorSchema = z.object({
  lng: z.number(),
  lat: z.number(),
  freehand: z.boolean().default(false),
});
export type RouteAnchor = z.infer<typeof routeAnchorSchema>;

/** Who can see a saved route. The app-wide ladder from `profile.ts`, not one of its own. */
export const PLANNED_ROUTE_VISIBILITIES = VISIBILITIES;
export type PlannedRouteVisibility = Visibility;

/** Why a leg came back as a straight line. Every one of these is shown to the user. */
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
   * The server declined to fetch the network here, so nothing is downloading. Waiting fixes a
   * pending tile and not a refused one, and unlike `off_network`/`no_path` this makes no claim
   * about terrain that was never read.
   */
  'network_paused',
] as const;
export type RouteLegReason = (typeof ROUTE_LEG_REASONS)[number];

/** One leg: the stretch arriving at anchor `to`. Per leg, so the user sees *which* stretch. */
export const routeLegSchema = z.object({
  to: z.number().int().positive(),
  /** False when this leg is a straight line — by request, or because nothing else was possible. */
  snapped: z.boolean(),
  reason: z.enum(ROUTE_LEG_REASONS).nullable(),
  lengthM: z.number().nonnegative(),
  /**
   * Where this leg begins and ends *on the drawn line* — a snapped anchor sits on the nearest
   * way, up to 120 m from the click. A client cannot derive these: the geometry arrives
   * simplified to 5 m, so slicing it into legs by cumulative length drifts.
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
   * True when the server refused to fetch the network here. Separate from `pendingTiles`, whose
   * zero means either "we hold everything" or "we declined to fetch" — and a refusal arriving as
   * a zero switches the retry loop off while the legs turn into terrain claims. Defaulted.
   */
  busy: z.boolean().default(false),
  /**
   * Which refusal, when `busy`. A deep queue can be waited out and a full database cannot, so
   * they must not share one "try again later". Defaulted, as `busy` is.
   */
  busyReason: z.enum(['queue-depth', 'storage']).nullable().default(null),
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

/** How many points one route may be built from. Bounds an accidental double-click storm. */
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
 * What gets saved: the anchors, never the line. The server replans from these before writing, so
 * no client can post a route through a cliff and have it served back as ours.
 */
export const routeSaveSchema = routePlanInputSchema.extend({
  name: z.string().trim().min(1).max(ROUTE_NAME_MAX),
  description: z.string().trim().max(ROUTE_DESCRIPTION_MAX).nullish(),
  activityType: z.enum(ACTIVITY_TYPES).default('hiking'),
  visibility: z.enum(PLANNED_ROUTE_VISIBILITIES).default('private'),
});
export type RouteSaveInput = z.infer<typeof routeSaveSchema>;

/** An edit. All optional: anchors present means replan, anchors absent leaves the line alone. */
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
