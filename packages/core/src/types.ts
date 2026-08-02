import { z } from 'zod';
import { DIFFICULTIES, SAC_SCALES } from './difficulty';

/** Activities a trail supports. Mirrors OSM route/access tagging where possible. There is
 * deliberately no "walking" beside `hiking` — the pair arrived together on nearly every trail. */
export const ACTIVITY_TYPES = [
  'hiking',
  'trail_running',
  'backpacking',
  'mountain_biking',
  'road_biking',
  'horseback_riding',
  'snowshoeing',
  'skiing',
  'via_ferrata',
  'scrambling',
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const ROUTE_TYPES = ['loop', 'out_and_back', 'point_to_point'] as const;
export type RouteType = (typeof ROUTE_TYPES)[number];

export const WAYPOINT_KINDS = [
  'trailhead',
  'summit',
  'viewpoint',
  'water',
  'waterfall',
  'lake',
  'parking',
  'toilets',
  'shelter',
  'campsite',
  'junction',
  'gate',
  'ford',
  'hazard',
  /** A col or mountain pass — the low point of a ridge, and often a hike's destination. */
  'pass',
  'glacier',
] as const;
export type WaypointKind = (typeof WAYPOINT_KINDS)[number];

/** Conditions a reviewer can tag, mirroring what AllTrails surfaces on reviews. */
export const TRAIL_CONDITIONS = [
  'dry',
  'muddy',
  'snow',
  'icy',
  'flooded',
  'overgrown',
  'blowdown',
  'washed_out',
  'closed',
  'bugs',
  'crowded',
  'well_marked',
  'poorly_marked',
] as const;
export type TrailCondition = (typeof TRAIL_CONDITIONS)[number];

export const lngLatSchema = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
/** GeoJSON axis order: [longitude, latitude]. */
export type LngLat = z.infer<typeof lngLatSchema>;

export const bboxSchema = z.tuple([
  z.number().min(-180).max(180), // west
  z.number().min(-90).max(90), // south
  z.number().min(-180).max(180), // east
  z.number().min(-90).max(90), // north
]);
export type BBox = z.infer<typeof bboxSchema>;

export const lineStringSchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(lngLatSchema).min(2),
});
export type LineString = z.infer<typeof lineStringSchema>;

/** One sample along the elevation profile. `distM` is cumulative distance from the start. */
export const elevationPointSchema = z.object({
  distM: z.number().nonnegative(),
  eleM: z.number(),
  lng: z.number(),
  lat: z.number(),
});
export type ElevationPoint = z.infer<typeof elevationPointSchema>;

export const trailStatsSchema = z.object({
  lengthM: z.number().nonnegative(),
  gainM: z.number().nonnegative(),
  lossM: z.number().nonnegative(),
  minEleM: z.number(),
  maxEleM: z.number(),
  /** Steepest sustained grade as a fraction; 0.25 = 25%. */
  maxSustainedGrade: z.number().nullable(),
  /** Tobler-derived moving time in seconds, before rest stops. */
  estimatedTimeS: z.number().nonnegative(),
});
export type TrailStats = z.infer<typeof trailStatsSchema>;

/** The shape a search result / map pin / list card needs — deliberately small. */
export const trailSummarySchema = z.object({
  id: z.string(),
  slug: z.string(),
  /** The OSM name. Immutable, and what `slug` was cut from. */
  name: z.string(),
  /**
   * Where the trail goes — "Vesper Peak via Headlee Pass Trail" — or null where the waypoints do
   * not support one. Null on most trails, so title through `trailTitle` rather than reading it.
   */
  displayName: z.string().nullable(),
  difficulty: z.enum(DIFFICULTIES),
  routeType: z.enum(ROUTE_TYPES),
  activityTypes: z.array(z.enum(ACTIVITY_TYPES)),
  stats: trailStatsSchema,
  centroid: lngLatSchema,
  bbox: bboxSchema,
  rating: z.number().min(0).max(5).nullable(),
  reviewCount: z.number().int().nonnegative(),
  photoCount: z.number().int().nonnegative(),
  primaryPhotoUrl: z.string().url().nullable(),
  regionName: z.string().nullable(),
});
export type TrailSummary = z.infer<typeof trailSummarySchema>;

export const waypointSchema = z.object({
  id: z.string(),
  kind: z.enum(WAYPOINT_KINDS),
  name: z.string().nullable(),
  lng: z.number(),
  lat: z.number(),
  eleM: z.number().nullable(),
  /** Distance along the trail, null for off-route features like parking. */
  distM: z.number().nonnegative().nullable(),
});
export type Waypoint = z.infer<typeof waypointSchema>;

export const trailDetailSchema = trailSummarySchema.extend({
  description: z.string().nullable(),
  geometry: lineStringSchema,
  profile: z.array(elevationPointSchema),
  waypoints: z.array(waypointSchema),
  surface: z.string().nullable(),
  sacScale: z.enum(SAC_SCALES).nullable(),
  dogsAllowed: z.boolean().nullable(),
  wheelchairAccessible: z.boolean().nullable(),
  feeRequired: z.boolean().nullable(),
  osmType: z.enum(['relation', 'way']).nullable(),
  osmId: z.number().int().nullable(),
  /** When our cache last reconciled this trail against OSM. */
  sourceUpdatedAt: z.string().datetime().nullable(),
});
export type TrailDetail = z.infer<typeof trailDetailSchema>;

/** A summary plus the simplified line — what `trails.browse` returns, because the map draws every
 * result. `Trail.geometryJson` is stored pre-simplified at 5 m; full resolution is megabytes. */
export const trailMapItemSchema = trailSummarySchema.extend({
  geometry: lineStringSchema,
});
export type TrailMapItem = z.infer<typeof trailMapItemSchema>;

export const TRAIL_SORTS = [
  'relevance',
  'distance_from_me',
  'rating',
  'length_asc',
  'length_desc',
  'gain_asc',
  'gain_desc',
  'popularity',
] as const;
export type TrailSort = (typeof TRAIL_SORTS)[number];

export const trailSearchSchema = z.object({
  q: z.string().trim().max(200).optional(),
  bbox: bboxSchema.optional(),
  near: lngLatSchema.optional(),
  radiusM: z.number().positive().max(200_000).optional(),
  difficulty: z.array(z.enum(DIFFICULTIES)).optional(),
  activityTypes: z.array(z.enum(ACTIVITY_TYPES)).optional(),
  routeType: z.array(z.enum(ROUTE_TYPES)).optional(),
  minLengthM: z.number().nonnegative().optional(),
  maxLengthM: z.number().nonnegative().optional(),
  minGainM: z.number().nonnegative().optional(),
  maxGainM: z.number().nonnegative().optional(),
  minRating: z.number().min(0).max(5).optional(),
  dogsAllowed: z.boolean().optional(),
  wheelchairAccessible: z.boolean().optional(),
  sort: z.enum(TRAIL_SORTS).default('relevance'),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(24),
});
export type TrailSearch = z.infer<typeof trailSearchSchema>;

/** How much of what the caller asked for we hold. The client renders `trails` now, shows
 * `pendingTiles` arriving, and re-asks as they land. */
export const tileCoverageSchema = z.object({
  /** Tiles already ingested and fresh. */
  readyTiles: z.array(z.string()),
  /** Tiles being fetched from OSM right now; results will grow. */
  pendingTiles: z.array(z.string()),
  /** Ready, serving cached trails, and being refreshed behind the response. */
  refreshingTiles: z.array(z.string()).default([]),
  /** True when the viewport is too large to cover; the client should zoom in. */
  tooLarge: z.boolean(),
  /**
   * True when ingest was refused, so the *new* ground this view is missing is not coming.
   * Refused tiles are deliberately kept out of `pendingTiles`, which would make the client poll
   * for something that never arrives; tiles that already had a job stay there. Defaulted.
   */
  busy: z.boolean().default(false),
  /** Which refusal, when `busy`. A deep queue drains and "try again in a few minutes" is a real
   * instruction; a full database needs an operator, so it must not say that. */
  busyReason: z.enum(['queue-depth', 'storage']).nullable().default(null),
  /** How many tiles the viewport spans, and the most we will cover at once. */
  requiredTiles: z.number().int().nonnegative().default(0),
  maxTiles: z.number().int().positive().default(12),
});
export type TileCoverage = z.infer<typeof tileCoverageSchema>;

/**
 * What a deliberate "fetch this area" would cost, and how far along one is. Counts rather than
 * quadkey lists: the UI draws a number and a progress bar, and this is polled every 2.5 s.
 * `TileCoverage` sends lists because the map shades pending tiles; this does not.
 */
export const areaSummarySchema = z.object({
  /** Tiles this area covers — the capped set, not necessarily the whole box. */
  tiles: z.number().int().nonnegative(),
  /** Of those, how many hold data inside the TTL. */
  fresh: z.number().int().nonnegative(),
  /** How many still need fetching. Zero means the area is fully covered. */
  outstanding: z.number().int().nonnegative(),
  /** How many have a job queued or running right now. Non-zero means keep polling. */
  working: z.number().int().nonnegative(),
  /** How many tiles the box actually spans, before the cap. */
  requiredTiles: z.number().int().nonnegative(),
  /** True when the box is wider than one fetch covers, so this is the middle of it. */
  capped: z.boolean(),
});
export type AreaSummary = z.infer<typeof areaSummarySchema>;

/** Search results carry the ingest state alongside the rows, so the client can stream in more. */
export const trailSearchResultSchema = z.object({
  trails: z.array(trailSummarySchema),
  nextCursor: z.string().nullable(),
  total: z.number().int().nonnegative(),
  coverage: tileCoverageSchema,
});
export type TrailSearchResult = z.infer<typeof trailSearchResultSchema>;

/** What the map asks for: everything in view, with lines, plus what is still coming. */
export const trailBrowseResultSchema = z.object({
  trails: z.array(trailMapItemSchema),
  /** Trails matching the filters in view, before the `limit` was applied. */
  total: z.number().int().nonnegative(),
  coverage: tileCoverageSchema,
  /** Present only when the viewport is wider than the automatic ingest ceiling — the one case
   * where the map cannot fill itself and the user has to ask. Null at every ordinary zoom. */
  area: areaSummarySchema.nullable().default(null),
});
export type TrailBrowseResult = z.infer<typeof trailBrowseResultSchema>;
