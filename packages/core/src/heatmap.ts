import { z } from 'zod';

/**
 * The activity heatmap — where people actually hike, drawn from what people actually
 * recorded.
 *
 * This is the one overlay on the map that is not a model and not a forecast. Busy times
 * answers *when*; this answers *where*, from the same recorded activities, aggregated over
 * every hiker rather than per trail. It is the layer that shows a shortcut worn across a
 * meadow that OSM has never heard of, and equally shows that the "trail" on the north side
 * of the ridge has been hiked twice, ever.
 *
 * ## Privacy is the feature, not a compliance step
 *
 * In 2018 Strava published a global heatmap built from user activity and it deanonymised
 * military bases — patrol routes, perimeter roads, and, worse, the runs individual people
 * took from their own front doors. The failure was not that the data was published. It was
 * that a rendering fine enough to be interesting was also fine enough to be a track, and
 * that a track with one author is that author.
 *
 * Five controls, all of them enforced server-side in the query rather than in the renderer,
 * because a control the client applies is a control an attacker can decline:
 *
 * 1. **Aggregate to a fixed lattice.** Raw points are never returned; a cell is returned or
 *    it is not. See `heatmapStepDeg` for why the lattice is fixed rather than fitted.
 * 2. **k-anonymity on distinct *people*, k = {@link HEATMAP_MIN_HIKERS}.** This is the
 *    load-bearing one. A cell that fewer than three separate accounts have hiked through
 *    is not drawn at all, at any zoom, for anyone. Counting *activities* instead would let
 *    one person's daily commute paint their own street.
 * 3. **Public activities only**, and only ones the client finished uploading — an activity
 *    whose `syncedAt` is null is a partial track and is excluded from every aggregate.
 * 4. **Endpoint clipping**, {@link HEATMAP_CLIP_M} at each end of every track. Endpoints
 *    are disproportionately homes, hotel rooms and parked cars, and they are exactly the
 *    part of a track that identifies a person rather than a route.
 * 5. **Count distinct activities, not samples.** A one-hour lunch stop is one visit, not
 *    three thousand. Otherwise the brightest pixel on the map is wherever somebody had a
 *    sandwich.
 *
 * **What this does not defend against, stated plainly:** k-anonymity without added noise is
 * vulnerable to differencing across snapshots — an observer who captures the map before and
 * after a known hiker's activity is published can attribute the difference to them. The
 * honest fix is differential privacy, and it was considered and rejected: noise sufficient
 * to defeat differencing also invents traffic on ground nobody has hiked, and an overlay
 * that lies about where the trails are is not a worse version of this feature, it is the
 * opposite of it. The mitigation we do take is that nothing here is retroactive — a hiker
 * who makes an activity private removes it from the next aggregate.
 */

/**
 * How many distinct people must have hiked a cell before it is drawn. The k in
 * k-anonymity.
 *
 * Three rather than five: the aggregate is already coarse (a cell is tens of metres at best
 * and tens of kilometres at worst), the endpoints are already gone, and at five a young
 * corpus shows nothing anywhere, which teaches readers the layer is broken rather than
 * teaching them it is careful. Three is the smallest number for which "which of them was
 * it" has no answer.
 */
export const HEATMAP_MIN_HIKERS = 3;

/** Metres trimmed from each end of every track before it is counted. */
export const HEATMAP_CLIP_M = 250;

/**
 * Most tracks read for one viewport, newest first.
 *
 * A bound on work rather than on truth: the query clips to the viewport before it
 * densifies, so this only bites where thousands of tracks genuinely overlap, and there the
 * two-thousandth track changes no cell's band.
 */
export const HEATMAP_MAX_TRACKS = 2_000;

/** Most cells returned for one viewport, busiest first. */
export const HEATMAP_MAX_CELLS = 6_000;

/** Coarsest lattice, about 39 km a side. Below this a cell is a country. */
export const HEATMAP_MIN_LEVEL = 10;

/** Finest lattice, about 38 m a side. Below this a cell starts to be a path. */
export const HEATMAP_MAX_LEVEL = 20;

/**
 * Target cell size on screen, in CSS pixels.
 *
 * Eight is the size at which a cell reads as texture rather than as a tile — small enough
 * that a hiked valley looks like a stroke, large enough that a single track never resolves
 * into a line you could follow.
 */
export const HEATMAP_CELL_PX = 8;

/**
 * Which lattice a zoom uses.
 *
 * At Web Mercator zoom `z` the world is `256 · 2^z` pixels wide, so one pixel is
 * `360 / (256 · 2^z)` degrees and an {@link HEATMAP_CELL_PX}-pixel cell is `360 / 2^(z+5)`.
 * Rounding the zoom rather than flooring it keeps a half-zoom nearer the cell size it asked
 * for; clamping the result is what stops a whole-world view from asking for four billion
 * cells and a street-level view from asking for one metre of privacy.
 */
export function heatmapLevel(zoom: number): number {
  if (!Number.isFinite(zoom)) return HEATMAP_MIN_LEVEL;
  const level = Math.round(zoom) + 5;
  return Math.min(HEATMAP_MAX_LEVEL, Math.max(HEATMAP_MIN_LEVEL, level));
}

/**
 * The lattice spacing in degrees for a zoom — always `360 / 2^n`, never anything else.
 *
 * That form is the entire point. `360 / 2^n` is exact in binary floating point, so cell
 * boundaries are the same numbers on the server, in the browser and in a cache key; every
 * level nests perfectly inside the one above it; and, crucially, the lattice does not depend
 * on where the viewport happens to start. Pan half a screen and the same ground stays in the
 * same cell with the same colour. A lattice fitted to the viewport instead would shimmer
 * under a drag and would make the colour mean nothing fixed.
 */
export function heatmapStepDeg(zoom: number): number {
  return 360 / 2 ** heatmapLevel(zoom);
}

/** Cell size in metres at the equator, for the key. Latitude shrinks it; the key says so. */
export function heatmapCellMetres(stepDeg: number): number {
  return stepDeg * 111_320;
}

/**
 * The five bands, in recorded visits.
 *
 * The ladder is roughly logarithmic (3, 10, 30, 100, 300) because trail traffic is: the gap
 * between a path hiked three times and one hiked thirty is the interesting gap, and a
 * linear ramp spends four of its five colours on the difference between "very busy" and
 * "very busy".
 *
 * The first band opens at {@link HEATMAP_MIN_HIKERS} rather than at 1 because visits below
 * that are unreachable by construction — a cell with two visits cannot have three hikers.
 * Starting the scale where the data starts keeps the key from advertising a colour the map
 * can never show.
 *
 * The words are deliberately not `BUSYNESS_LEVELS`. That scale (quiet / moderate / busy /
 * packed) describes how crowded a trail is *at an hour you might go*. This one describes how
 * much traffic ground has *ever* accumulated. A remote pass can be constantly hiked over a
 * decade and completely quiet on a Tuesday, and one vocabulary for both facts would make the
 * two features contradict each other on the same screen.
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
  // Hiked from the top so the open-ended band catches anything above 300 without a special
  // case, and so a count sitting exactly on a boundary reads as the band it opens.
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
  /**
   * Cells that had traffic but too few hikers to publish.
   *
   * Surfaced on purpose, and it leaks nothing: a count over a whole viewport says how much
   * was withheld without saying where any of it was. Without it a young corpus renders as an
   * empty map, which reads as a broken feature rather than a careful one — and the honest
   * sentence ("41 cells hidden, fewer than three people each") is a better answer than
   * silence.
   */
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
