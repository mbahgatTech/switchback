import { z } from 'zod';

/**
 * The activity heatmap — where people hike, aggregated across every hiker rather than per trail.
 *
 * Five privacy controls, all enforced server-side in the query and not in the renderer, because
 * a control the client applies is one an attacker can decline. Removing any of them re-opens the
 * 2018 Strava deanonymisation failure, where a rendering fine enough to be interesting was also
 * fine enough to be one person's track:
 *
 * 1. Aggregate to a fixed lattice; raw points are never returned. See `heatmapStepDeg`.
 * 2. k-anonymity on distinct *people*, k = {@link HEATMAP_MIN_HIKERS}. Counting activities
 *    instead would let one person's daily commute paint their own street.
 * 3. Public activities only, and only ones with a non-null `syncedAt`.
 * 4. Endpoint clipping, {@link HEATMAP_CLIP_M} each end — endpoints are homes and parked cars.
 * 5. Count distinct activities, not samples, or the brightest pixel is a lunch stop.
 *
 * Known gap: k-anonymity without noise is open to differencing across snapshots. Differential
 * privacy was rejected because noise enough to defeat it invents traffic on unhiked ground.
 */

/** Distinct people required before a cell is drawn. Three: at five a young corpus shows nothing. */
export const HEATMAP_MIN_HIKERS = 3;

/** Metres trimmed from each end of every track before it is counted. */
export const HEATMAP_CLIP_M = 250;

/** Most tracks read for one viewport, newest first. The query clips before it densifies. */
export const HEATMAP_MAX_TRACKS = 2_000;

/** Most cells returned for one viewport, busiest first. */
export const HEATMAP_MAX_CELLS = 6_000;

/** Coarsest lattice, about 39 km a side. Below this a cell is a country. */
export const HEATMAP_MIN_LEVEL = 10;

/** Finest lattice, about 38 m a side. Below this a cell starts to be a path. */
export const HEATMAP_MAX_LEVEL = 20;

/** Target cell size on screen: the size at which a cell reads as texture rather than a tile. */
export const HEATMAP_CELL_PX = 8;

/**
 * Which lattice a zoom uses. At Web Mercator zoom `z` one pixel is `360 / (256 · 2^z)` degrees,
 * so an {@link HEATMAP_CELL_PX}-pixel cell is `360 / 2^(z+5)`. The clamp stops a whole-world view
 * asking for four billion cells and a street view asking for one metre of privacy.
 */
export function heatmapLevel(zoom: number): number {
  if (!Number.isFinite(zoom)) return HEATMAP_MIN_LEVEL;
  const level = Math.round(zoom) + 5;
  return Math.min(HEATMAP_MAX_LEVEL, Math.max(HEATMAP_MIN_LEVEL, level));
}

/**
 * The lattice spacing in degrees — always `360 / 2^n`. That form is exact in binary floating
 * point, so cell boundaries agree on server, browser and cache key, every level nests inside the
 * one above, and the lattice does not depend on where the viewport starts.
 */
export function heatmapStepDeg(zoom: number): number {
  return 360 / 2 ** heatmapLevel(zoom);
}

/** Cell size in metres at the equator, for the key. Latitude shrinks it; the key says so. */
export function heatmapCellMetres(stepDeg: number): number {
  return stepDeg * 111_320;
}

/**
 * The five bands, in recorded visits, roughly logarithmic because trail traffic is. The first
 * opens at {@link HEATMAP_MIN_HIKERS} because fewer visits are unreachable by construction.
 * Deliberately not `BUSYNESS_LEVELS`: that is crowding at an hour, this is traffic ever.
 */
export const HEATMAP_BANDS = [
  { from: 3, to: 10, label: 'Lightly hiked' },
  { from: 10, to: 30, label: 'Regularly hiked' },
  { from: 30, to: 100, label: 'Well hiked' },
  { from: 100, to: 300, label: 'Heavily hiked' },
  { from: 300, to: null, label: 'Constantly hiked' },
] as const;

export type HeatmapBand = (typeof HEATMAP_BANDS)[number];

/** Which band a visit count falls in, or `null` when it is below the drawable floor. */
export function heatmapBand(visits: number | null | undefined): HeatmapBand | null {
  if (visits === null || visits === undefined || !Number.isFinite(visits)) return null;
  // From the top, so the open-ended band needs no special case and a count on a boundary
  // reads as the band it opens.
  for (let i = HEATMAP_BANDS.length - 1; i >= 0; i--) {
    const band = HEATMAP_BANDS[i]!;
    if (visits >= band.from) return band;
  }
  return null;
}

export const heatmapCellSchema = z.object({
  /** The cell's footprint on the lattice, `[w, s, e, n]`. Derived, never stored. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Distinct activities that passed through, after endpoint clipping. */
  visits: z.number().int().nonnegative(),
  /** Distinct people behind those activities. Never below {@link HEATMAP_MIN_HIKERS}. */
  hikers: z.number().int().nonnegative(),
});
export type HeatmapCell = z.infer<typeof heatmapCellSchema>;

export const heatmapSchema = z.object({
  cells: z.array(heatmapCellSchema),
  /** The lattice this grid was built on, in degrees. Cells are exactly this wide. */
  stepDeg: z.number().positive(),
  /** The k that was applied, published so the key can state the floor rather than imply it. */
  minHikers: z.number().int().positive(),
  /** Tracks that touched the viewport and were read. */
  tracks: z.number().int().nonnegative(),
  /** Cells with traffic but too few hikers to publish. A viewport-wide count says how much was
   * withheld without saying where. */
  suppressed: z.number().int().nonnegative(),
  /** True when more cells passed k than the cap returns, so the faintest are missing. */
  truncated: z.boolean(),
});
export type Heatmap = z.infer<typeof heatmapSchema>;

export const heatmapRequestSchema = z.object({
  /** Viewport, `[w, s, e, n]`. Unbounded here; the server normalises before it queries. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  /** Map zoom, which picks the lattice. Not a cell size — the client never names one. */
  zoom: z.number().min(0).max(24),
});
export type HeatmapRequest = z.infer<typeof heatmapRequestSchema>;
