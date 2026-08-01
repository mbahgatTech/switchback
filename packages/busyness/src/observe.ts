/**
 * Pulling the curve toward what actually happened, by empirical-Bayes shrinkage per bucket:
 *
 *     w = n / (n + K)
 *     value = w·observed + (1−w)·prior
 *
 * Recorded starts arrive unevenly — four hundred Saturday mornings and no Tuesdays — so
 * replacing the prior outright would publish that Tuesday as a measured zero. An hour nobody
 * has recorded keeps the prior exactly.
 *
 * Both sides are normalised to their own weekly peak before blending: the prior is in arbitrary
 * demand units and the observations in recorded hikes, so mixing directly would let a unit
 * change silently reweight the model.
 */

import { DAYS_PER_WEEK, HOURS_PER_DAY, maxOf } from './prior';

/** Sample count at which observation and prior carry equal weight. */
export const SHRINKAGE_K = 25;

export interface ObservationBucket {
  /** 0 = Sunday. */
  dayOfWeek: number;
  hour: number;
  /** EWMA of recorded starts in this bucket. */
  observed: number;
  /** How many recordings back it. Drives the shrinkage, not the value. */
  sampleCount: number;
}

export interface BlendResult {
  /** `[dayOfWeek][hour]`, same units as the prior it was blended with. */
  surface: number[][];
  /** Sum of `sampleCount` across every bucket. Feeds `confidenceFromObservations`. */
  observationCount: number;
}

/**
 * Grid of `[day][hour]` filled from a sparse bucket list. Out-of-range indices are dropped, not
 * trusted: a `dayOfWeek` of 7 from a Monday-first caller would otherwise land on Sunday's row.
 */
export function toGrid(
  buckets: readonly ObservationBucket[],
  pick: (bucket: ObservationBucket) => number,
): number[][] {
  const grid = emptyGrid();
  for (const bucket of buckets) {
    const day = grid[bucket.dayOfWeek];
    if (!day) continue;
    if (bucket.hour < 0 || bucket.hour >= HOURS_PER_DAY || !Number.isInteger(bucket.hour)) continue;
    day[bucket.hour] = Math.max(0, pick(bucket));
  }
  return grid;
}

export function blendObservations(
  prior: readonly (readonly number[])[],
  buckets: readonly ObservationBucket[],
  k: number = SHRINKAGE_K,
): BlendResult {
  const counts = toGrid(buckets, (b) => b.sampleCount);
  const observationCount = counts.reduce((sum, day) => sum + day.reduce((a, b) => a + b, 0), 0);

  const observed = toGrid(buckets, (b) => b.observed);
  const observedPeak = maxOf(observed);
  const priorPeak = maxOf(prior);

  // Nothing to blend toward; the prior stands as it is.
  if (observedPeak <= 0 || priorPeak <= 0) {
    return { surface: prior.map((day) => [...day]), observationCount };
  }

  // Put the observations in the prior's units before mixing, so one shared normalisation step
  // downstream serves both.
  const scale = priorPeak / observedPeak;

  const surface = emptyGrid();
  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      const priorValue = prior[day]?.[hour] ?? 0;
      const n = counts[day]?.[hour] ?? 0;
      const weight = n > 0 ? n / (n + k) : 0;
      const observedValue = (observed[day]?.[hour] ?? 0) * scale;
      surface[day]![hour] = weight * observedValue + (1 - weight) * priorValue;
    }
  }

  return { surface, observationCount };
}

function emptyGrid(): number[][] {
  return Array.from({ length: DAYS_PER_WEEK }, () => new Array<number>(HOURS_PER_DAY).fill(0));
}
