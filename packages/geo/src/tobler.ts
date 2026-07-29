import type { ElevationPoint } from '@switchback/core';
import { SAC_SCALES, type SacScale } from '@switchback/core';

/**
 * Hiking pace, via Tobler's hiking function.
 *
 *     W = 6 · exp(−3.5 · |S + 0.05|)   km/h,  where S = rise/run
 *
 * The +0.05 offset encodes the real observation that people hike fastest on a gentle
 * *downhill* (about −5% grade, 6 km/h) rather than on the flat (5.04 km/h), and that
 * steep descents are slow again because they are braked.
 *
 * This matters here for one reason: it is what turns a static forecast into a useful
 * one. Knowing the summit will be −1 °C with 60 km/h gusts is only actionable
 * alongside knowing you will be standing on it at 11:20 rather than at 09:00.
 *
 * @see Tobler, W. (1993). Three Presentations on Geographical Analysis and Modeling.
 */

/** Tobler's flat-ground speed, km/h. Retained as a named constant for tests. */
export const TOBLER_BASE_KMH = 6;
export const TOBLER_DECAY = 3.5;
export const TOBLER_OFFSET = 0.05;

/**
 * Speed floor. Tobler decays smoothly toward zero on extreme slopes, which would make
 * a single bad DEM sample on a cliff face contribute hours to an estimate. Nobody
 * moves slower than this on ground they can still hike.
 */
const MIN_SPEED_KMH = 0.6;

/** Tobler's own multiplier for travel that is not on a path. */
export const OFF_PATH_FACTOR = 0.6;

/**
 * Terrain multipliers by OSM `sac_scale`. Tobler models hiking, not scrambling; on
 * alpine ground the limiting factor stops being aerobic and starts being route-finding
 * and hand-over-hand movement, which the slope term alone will not capture.
 */
export const SAC_TERRAIN_FACTOR: Record<SacScale, number> = {
  hiking: 1.0,
  mountain_hiking: 0.92,
  demanding_mountain_hiking: 0.8,
  alpine_hiking: 0.65,
  demanding_alpine_hiking: 0.5,
  difficult_alpine_hiking: 0.4,
};

/** Rougher surfaces cost time even where the grade is flat. */
export const SURFACE_TERRAIN_FACTOR: Record<string, number> = {
  paved: 1.05,
  asphalt: 1.05,
  concrete: 1.05,
  compacted: 1.0,
  fine_gravel: 1.0,
  gravel: 0.95,
  dirt: 0.95,
  ground: 0.95,
  grass: 0.9,
  sand: 0.75,
  rock: 0.75,
  scree: 0.65,
  mud: 0.7,
  snow: 0.7,
};

export interface PaceOptions {
  /**
   * User fitness multiplier on time (not speed): 0.8 is 20% faster than the model,
   * 1.3 is 30% slower. Surfaced in the UI as Fast / Average / Relaxed.
   */
  paceFactor?: number;
  /** Terrain speed multiplier, from `terrainFactorFor`. */
  terrainFactor?: number;
}

/** Tobler speed in km/h for a signed slope (rise/run). */
export function toblerSpeedKmh(slope: number): number {
  if (!Number.isFinite(slope)) return TOBLER_BASE_KMH * Math.exp(-TOBLER_DECAY * TOBLER_OFFSET);
  const speed = TOBLER_BASE_KMH * Math.exp(-TOBLER_DECAY * Math.abs(slope + TOBLER_OFFSET));
  return Math.max(MIN_SPEED_KMH, speed);
}

/** Combined terrain multiplier from the OSM tags we have for a trail. */
export function terrainFactorFor(opts: {
  sacScale?: SacScale | null;
  surface?: string | null;
  onPath?: boolean;
}): number {
  let factor = 1;
  if (opts.sacScale && SAC_SCALES.includes(opts.sacScale)) {
    factor *= SAC_TERRAIN_FACTOR[opts.sacScale];
  }
  const surface = opts.surface?.toLowerCase();
  if (surface && surface in SURFACE_TERRAIN_FACTOR) {
    factor *= SURFACE_TERRAIN_FACTOR[surface]!;
  }
  if (opts.onPath === false) factor *= OFF_PATH_FACTOR;
  return factor;
}

/**
 * Cumulative moving time at each profile point, in seconds.
 *
 * Returned per-point rather than as a single total because the weather feature needs
 * arrival time at arbitrary positions along the trail, and recomputing the integral
 * per sample would be wasteful and inconsistent.
 *
 * Moving time only — no rest stops, no lunch, no photographs. Real elapsed time runs
 * longer, and the UI says so rather than quietly padding the number.
 */
export function cumulativeTimeS(
  profile: readonly ElevationPoint[],
  opts: PaceOptions = {},
): number[] {
  const paceFactor = opts.paceFactor ?? 1;
  const terrainFactor = opts.terrainFactor ?? 1;

  const out = new Array<number>(profile.length);
  out[0] = 0;

  for (let i = 1; i < profile.length; i++) {
    const run = profile[i]!.distM - profile[i - 1]!.distM;
    if (run <= 0) {
      out[i] = out[i - 1]!;
      continue;
    }
    const rise = profile[i]!.eleM - profile[i - 1]!.eleM;
    const speedKmh = toblerSpeedKmh(rise / run) * terrainFactor;
    const seconds = (run / 1000 / speedKmh) * 3600 * paceFactor;
    out[i] = out[i - 1]! + seconds;
  }

  return out;
}

export function estimateMovingTimeS(
  profile: readonly ElevationPoint[],
  opts: PaceOptions = {},
): number {
  if (profile.length < 2) return 0;
  const cum = cumulativeTimeS(profile, opts);
  return cum[cum.length - 1]!;
}

/**
 * Elapsed seconds at a given distance along the trail, interpolating between profile
 * points. This is the lookup the weather sampler uses.
 */
export function timeAtDistanceS(
  profile: readonly ElevationPoint[],
  cumTimeS: readonly number[],
  distM: number,
): number {
  if (profile.length === 0) return 0;
  if (distM <= 0) return 0;
  const last = profile.length - 1;
  if (distM >= profile[last]!.distM) return cumTimeS[last]!;

  // Binary search for the bracketing segment.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (profile[mid]!.distM <= distM) lo = mid;
    else hi = mid;
  }

  const span = profile[hi]!.distM - profile[lo]!.distM;
  const t = span === 0 ? 0 : (distM - profile[lo]!.distM) / span;
  return cumTimeS[lo]! + (cumTimeS[hi]! - cumTimeS[lo]!) * t;
}
