/**
 * Pulling the curve toward what actually happened.
 *
 * Every activity our users record contributes a start time to one `(day, hour)` bucket.
 * Those counts are the only ground truth this model will ever have, and the whole problem
 * is that they arrive unevenly: a trail can have four hundred recorded Saturday mornings
 * and not one recorded Tuesday. Replacing the prior with the observations outright would
 * turn that trail's Tuesday into a flat zero and claim it as measurement.
 *
 * So the blend is per bucket and shrunk by that bucket's own sample count:
 *
 *     w = n / (n + K)          weight given to observation
 *     value = w·observed + (1−w)·prior
 *
 * Ten recordings in an hour move it a third of the way; a hundred move it four fifths;
 * an hour nobody has ever recorded keeps the prior exactly. This is the standard
 * empirical-Bayes shrinkage, and it is the difference between a model that improves with
 * data and one that lurches.
 *
 * Both sides are normalised to their own weekly peak before blending. They have to be:
 * the prior is in arbitrary demand units and the observations are in recorded hikes, and
 * mixing those directly would let a unit change silently reweight the model.
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
 * Grid of `[day][hour]` filled from a sparse bucket list.
 *
 * Rows arrive from Postgres as whatever subset has been written, in whatever order, and
 * out-of-range indices are dropped rather than trusted — a `dayOfWeek` of 7 from a caller
 * that counted Monday-first would otherwise land on Sunday's row and be wrong quietly.
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

  // No observations, or every one of them is zero. Either way there is nothing to blend
  // toward, and the prior stands as it is.
  if (observedPeak <= 0 || priorPeak <= 0) {
    return { surface: prior.map((day) => [...day]), observationCount };
  }

  // Put the observations in the prior's units before mixing, so the result is comparable
  // to a pure prior and one shared normalisation step downstream serves both.
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
