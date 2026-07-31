import { z } from 'zod';
import { DIFFICULTIES, SAC_SCALES } from './difficulty';

/**
 * Activities a trail supports. Mirrors OSM route/access tagging where possible.
 *
 * There is deliberately no separate "walking" type beside `hiking`. The two were separate
 * for a while and the separation never paid: every path that admitted one admitted the
 * other, so the pair arrived together on nearly every trail, took two lines in every filter,
 * and asked the reader to decide which word described the same afternoon. It is `hiking`.
 */
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

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

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

/**
 * One sample along the elevation profile. `distM` is cumulative distance from the
 * start, which is what both the chart x-axis and the ETA calculation key off.
 */
export const elevationPointSchema = z.object({
  distM: z.number().nonnegative(),
  eleM: z.number(),
  lng: z.number(),
  lat: z.number(),
});
export type ElevationPoint = z.infer<typeof elevationPointSchema>;

// ---------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------

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
  name: z.string(),
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

/**
 * A summary plus the simplified line.
 *
 * The map needs geometry for every result, not just the selected one — a viewport of
 * sixty trails draws sixty polylines. This is the shape `trails.browse` returns, and the
 * reason `Trail.geometryJson` is stored pre-simplified: at 5 m tolerance sixty lines are
 * a few hundred kilobytes, and at full resolution they are tens of megabytes.
 */
export const trailMapItemSchema = trailSummarySchema.extend({
  geometry: lineStringSchema,
});
export type TrailMapItem = z.infer<typeof trailMapItemSchema>;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

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

/**
 * How much of what the caller asked for we actually hold.
 *
 * Every viewport-shaped response carries this. It is the visible half of the on-demand
 * design: the client renders `trails` immediately, shows that `pendingTiles` are still
 * arriving, and re-asks as they land.
 */
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
   *
   * Not the same as "nothing outstanding". The refused tiles are kept out of `pendingTiles`,
   * because a non-empty `pendingTiles` makes the client poll and there would be nothing to
   * poll for — but the reader is owed the difference between a view we hold entirely and one
   * whose fetch was turned down, so the note says which. Tiles this viewport already had a
   * job for are unaffected: they stay in `pendingTiles`, they are still coming, and the poll
   * that watches them keeps running. Defaulted, so a cached response from before this field
   * existed still parses.
   */
  busy: z.boolean().default(false),
  /**
   * Which refusal, when `busy`. Null otherwise.
   *
   * The two do not share a sentence. A deep queue drains and "try again in a few minutes" is
   * a real instruction; a full database does not drain, an operator has to decide what to
   * delete, and telling the reader to wait for it is prescribing something that cannot work.
   */
  busyReason: z.enum(['queue-depth', 'storage']).nullable().default(null),
  /** How many tiles the viewport spans, and the most we will cover at once. */
  requiredTiles: z.number().int().nonnegative().default(0),
  maxTiles: z.number().int().positive().default(12),
});
export type TileCoverage = z.infer<typeof tileCoverageSchema>;

/**
 * What a deliberate "fetch this area" would cost, and how far along one is.
 *
 * Counts rather than quadkey lists, and that is not laziness about the schema. Ninety-six
 * quadkeys is about 1.5 KB of strings on a response the client polls every 2.5 seconds, and
 * nothing in the UI can do anything with an individual key — it draws a number and a
 * progress bar. `TileCoverage` sends lists because the map genuinely needs them: it shades
 * pending tiles on the canvas. This does not.
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

/**
 * Search results carry the ingest state alongside the rows. When a viewport covers
 * tiles we have never fetched, the client gets whatever we already hold plus the
 * list of pending tiles, and streams in the rest as those tiles land.
 */
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
  /**
   * Present only when the viewport is wider than the automatic ingest ceiling — the one
   * case where the map cannot fill itself and the user has to ask. Null at every ordinary
   * zoom, where coverage above already says everything there is to say.
   */
  area: areaSummarySchema.nullable().default(null),
});
export type TrailBrowseResult = z.infer<typeof trailBrowseResultSchema>;
