import type { ElevationPoint, LngLat, RouteType, TrailStats } from '@switchback/core';
import { cumulativeDistancesM } from './distance';
import { estimateMovingTimeS } from './tobler';

/**
 * Hysteresis threshold for elevation gain, metres. DEM noise is ~±3 m, so summing every positive
 * delta invents hundreds of metres of climb; elevation must move this far from the running
 * reference before any of it counts. 10 m matches Garmin's and Strava's barometric-free
 * convention, which is what makes our numbers comparable to the ones readers already know.
 */
export const GAIN_THRESHOLD_M = 10;

/** Window for sustained-grade measurement. Shorter windows just measure DEM noise. */
export const GRADE_WINDOW_M = 100;

export interface GainLoss {
  gainM: number;
  lossM: number;
}

/** Ascent and descent accrued from the first sample to each sample, as two parallel arrays. */
export interface GainLossCurve {
  gainM: number[];
  lossM: number[];
}

/**
 * The hysteresis filter read at every sample rather than only at the end, so a caller can ask
 * what has been climbed by a point partway along. Both arrays are non-decreasing, and their
 * last values are what `computeGainLoss` returns for the whole line.
 */
export function gainLossCurve(
  elevations: readonly number[],
  thresholdM = GAIN_THRESHOLD_M,
): GainLossCurve {
  const gain = new Array<number>(elevations.length).fill(0);
  const loss = new Array<number>(elevations.length).fill(0);
  if (elevations.length < 2) return { gainM: gain, lossM: loss };

  let gainM = 0;
  let lossM = 0;
  let reference = elevations[0]!;
  // Furthest point reached in the current direction, so a climb that pauses and resumes is
  // credited in full rather than split and re-thresholded.
  let extreme = reference;
  let direction: 0 | 1 | -1 = 0;

  for (let i = 1; i < elevations.length; i++) {
    const ele = elevations[i]!;
    if (!Number.isFinite(ele)) {
      // Nothing is known about this sample, so nothing has been climbed at it either.
      gain[i] = gain[i - 1]!;
      loss[i] = loss[i - 1]!;
      continue;
    }

    if (direction === 0) {
      if (ele - reference >= thresholdM) {
        direction = 1;
        extreme = ele;
      } else if (reference - ele >= thresholdM) {
        direction = -1;
        extreme = ele;
      }
    } else if (direction === 1) {
      if (ele > extreme) {
        extreme = ele;
      } else if (extreme - ele >= thresholdM) {
        // Confirmed reversal: bank the climb and start tracking the descent.
        gainM += extreme - reference;
        reference = extreme;
        direction = -1;
        extreme = ele;
      }
    } else {
      if (ele < extreme) {
        extreme = ele;
      } else if (ele - extreme >= thresholdM) {
        lossM += reference - extreme;
        reference = extreme;
        direction = 1;
        extreme = ele;
      }
    }

    // The leg in progress counts towards the reading at this sample, exactly as the final leg
    // is banked below — otherwise a single unreversed climb would read as zero all the way up.
    gain[i] = round1(gainM + (direction === 1 ? extreme - reference : 0));
    loss[i] = round1(lossM + (direction === -1 ? reference - extreme : 0));
  }

  return { gainM: gain, lossM: loss };
}

/** Total ascent and descent under the `GAIN_THRESHOLD_M` hysteresis filter. */
export function computeGainLoss(
  elevations: readonly number[],
  thresholdM = GAIN_THRESHOLD_M,
): GainLoss {
  const curve = gainLossCurve(elevations, thresholdM);
  const last = elevations.length - 1;
  if (last < 1) return { gainM: 0, lossM: 0 };
  return { gainM: curve.gainM[last]!, lossM: curve.lossM[last]! };
}

/**
 * Steepest grade sustained over `windowM`, as a fraction (0.25 = 25%). Measured over a window,
 * not between adjacent samples, so one noisy 25 m step cannot imply a 40% grade. Null for lines
 * shorter than a window.
 *
 * The tail advances to whichever sample puts the run *closest* to `windowM`, from either side.
 * Taking the longest run that fits underneath instead returned 0 for one climbing trail in
 * eight: `resampleLine` spreads its remainder, so a nominal 25 m step lands either side of it,
 * and at 25.2 m no window ever qualified while at 24.998 m every one did.
 */
export function maxSustainedGrade(
  profile: readonly ElevationPoint[],
  windowM = GRADE_WINDOW_M,
): number | null {
  if (profile.length < 2) return null;
  const total = profile[profile.length - 1]!.distM;
  if (total < windowM) return null;

  let max = 0;
  let tail = 0;
  const miss = (head: number, at: number) =>
    Math.abs(profile[head]!.distM - profile[at]!.distM - windowM);

  for (let head = 1; head < profile.length; head++) {
    // The miss falls then rises exactly once as the tail advances, and the best tail for a head
    // is never behind the best tail for the head before — so this stays one pass over the line.
    while (tail < head - 1 && miss(head, tail + 1) <= miss(head, tail)) tail++;
    const run = profile[head]!.distM - profile[tail]!.distM;
    // Tolerance keeps a profile whose spacing does not divide the window from losing its
    // opening climb to a run of 99.6 m.
    if (run < windowM * 0.9) continue;
    const rise = Math.abs(profile[head]!.eleM - profile[tail]!.eleM);
    const grade = rise / run;
    if (grade > max) max = grade;
  }

  return max > 0 ? Math.round(max * 1000) / 1000 : 0;
}

/**
 * Build the elevation profile from resampled geometry and matching elevations.
 * Coordinates and elevations must be index-aligned; `resampleLine` then
 * `sampleElevations` produces exactly that.
 */
export function buildProfile(
  coords: readonly LngLat[],
  elevations: ReadonlyArray<number | null>,
): ElevationPoint[] {
  if (coords.length !== elevations.length) {
    throw new Error(
      `buildProfile: length mismatch (${coords.length} coords vs ${elevations.length} elevations)`,
    );
  }

  const cum = cumulativeDistancesM(coords);
  const filled = fillGaps(despike(elevations, cum));

  return coords.map((c, i) => ({
    distM: Math.round(cum[i]! * 10) / 10,
    eleM: Math.round(filled[i]! * 10) / 10,
    lng: c[0],
    lat: c[1],
  }));
}

/**
 * How far a sample may stand off the ground its neighbours agree about, as a grade. Expressed
 * as a grade, not metres, so it means the same at 25 m spacing and at several hundred. 2.0 is
 * 63°: ground that departs from its own neighbourhood that steeply and returns is not ground.
 */
export const SPIKE_GRADE = 2;

/**
 * How far out of character the excursion must be against the neighbourhood's own slope, since a
 * 63° departure means something different on a valley floor than on a cliff. Tight by design:
 * the corpus's ratios run …4.6, 6.7, then 10.4, then nothing until 71, and 8 sits in the narrow
 * gap deliberately — a false positive is bridged from close neighbours and costs ~18 m, while a
 * miss leaves a route publishing 192 m of ascent that is not there.
 */
const SPIKE_TREND_RATIO = 8;

/**
 * Samples per side establishing where the ground is. The reference is a median, so the window
 * tolerates nearly half of itself being wrong; seven rather than five because Kalaloch Beaches
 * holds runs of six bad samples, where a median over five is outvoted and reports the hole.
 */
const SPIKE_WINDOW = 7;

/**
 * Passes before the scan gives up. A long run hides its own ends — the inner reference is itself
 * inside the hole — so each pass lets the next reach past what it dropped and the run erodes
 * from the middle out. Six covers a run of about twelve, twice the worst the corpus holds.
 */
const SPIKE_PASSES = 6;

/**
 * Drop samples standing off ground their own neighbourhood agrees about, so `fillGaps` can
 * bridge them. Terrarium tiles carry bathymetry and `NO_DATA_ELEVATION` only catches the
 * RGB(0,0,0) sentinel, so a line straying over water decodes a real and completely wrong number.
 *
 * The test is a spike, not a slope, and that is the whole design: rejecting any step steeper
 * than a grade cannot tell a bad pixel from a cliff the trail genuinely descends. A sample must
 * fail both questions to be dropped — is the excursion walkable (miss against the chord between
 * two medians, over half its span, versus `SPIKE_GRADE`), and is it out of character (the same
 * miss versus the slope the medians already run at, times `SPIKE_TREND_RATIO`).
 *
 * The two ends are deliberately not judged: with a neighbourhood on one side only, nothing
 * distinguishes a bad reading from a trailhead on a cliff edge, and every hole in the corpus is
 * interior. A bad end cannot mislead its neighbours, because one sample never moves a median.
 */
export function despike(
  elevations: ReadonlyArray<number | null>,
  distances: readonly number[],
  maxGrade = SPIKE_GRADE,
): Array<number | null> {
  const out = elevations.slice();
  if (out.length < 3) return out;

  const at = (i: number) => {
    const e = out[i];
    return e !== null && e !== undefined && Number.isFinite(e) ? e : null;
  };

  /**
   * Median of the samples on one side — where that side says the ground is. Counts samples it
   * can read, not positions it steps over, so a reference beside a hole reaches past it.
   */
  const reference = (from: number, step: -1 | 1) => {
    const win: { e: number; d: number }[] = [];
    for (let k = from; k >= 0 && k < out.length && win.length < SPIKE_WINDOW; k += step) {
      const e = at(k);
      if (e !== null) win.push({ e, d: distances[k]! });
    }
    if (win.length === 0) return null;
    win.sort((a, b) => a.e - b.e);
    return win[Math.floor(win.length / 2)]!;
  };

  /** Every index this pass would reject, judged against the samples still standing. */
  const scan = () => {
    const drop: number[] = [];

    for (let i = 1; i < out.length - 1; i++) {
      const here = at(i);
      if (here === null) continue;

      const left = reference(i - 1, -1);
      const right = reference(i + 1, 1);
      if (left === null || right === null) continue;

      const span = right.d - left.d;
      if (!(span > 0)) continue;

      // How fast the ground is already moving between the two references.
      const trend = Math.abs(right.e - left.e) / span;
      // Past this the references describe a cliff, not a neighbourhood, and a chord across it
      // predicts nothing. A step that persists is exactly what this rule must not touch.
      if (trend > maxGrade) continue;

      // The run is half the chord's span: an excursion has to leave the chord and come back,
      // so each leg gets half the baseline the chord was drawn over.
      const chord = left.e + ((right.e - left.e) * (distances[i]! - left.d)) / span;
      const deviation = Math.abs(here - chord) / (span / 2);

      if (deviation > maxGrade && deviation > SPIKE_TREND_RATIO * trend) drop.push(i);
    }

    return drop;
  };

  for (let pass = 0; pass < SPIKE_PASSES; pass++) {
    const drop = scan();
    if (drop.length === 0) break;
    for (const i of drop) out[i] = null;
  }

  return out;
}

/**
 * Linearly interpolate across missing elevations, extending the nearest known value at the ends,
 * so a failed tile leaves a smooth line rather than a hole that later reads as a cliff.
 *
 * Exported for `scripts/repair-dem-spikes.ts`, which reruns this and `despike` over stored
 * profiles: `buildProfile` resamples and rounds, so rebuilding would rewrite every row to fix five.
 */
export function fillGaps(values: ReadonlyArray<number | null>): number[] {
  const out = values.map((v) => (v === null || !Number.isFinite(v) ? null : v));
  const known = out.reduce<number[]>((acc, v, i) => (v !== null ? (acc.push(i), acc) : acc), []);

  if (known.length === 0) return new Array<number>(out.length).fill(0);

  const first = known[0]!;
  const last = known[known.length - 1]!;
  for (let i = 0; i < first; i++) out[i] = out[first]!;
  for (let i = last + 1; i < out.length; i++) out[i] = out[last]!;

  for (let k = 1; k < known.length; k++) {
    const a = known[k - 1]!;
    const b = known[k]!;
    if (b - a <= 1) continue;
    const va = out[a]!;
    const vb = out[b]!;
    for (let i = a + 1; i < b; i++) out[i] = va + ((vb - va) * (i - a)) / (b - a);
  }

  return out as number[];
}

/**
 * The same samples again, in reverse, with distance continuing past the turnaround. Built as
 * real geometry rather than by doubling, because doubling is wrong in every statistic except
 * length — a doubled `gainM` counts the outward descents as climbs, and a doubled
 * `estimatedTimeS` charges Tobler's uphill price for ground that is now downhill. The
 * turnaround is not repeated: a second copy is a zero-length segment and a duplicate axis label.
 */
export function mirrorProfile(profile: readonly ElevationPoint[]): ElevationPoint[] {
  const forward = profile.map((p) => ({ ...p }));
  if (forward.length < 2) return forward;

  const totalM = forward[forward.length - 1]!.distM;
  const back: ElevationPoint[] = [];
  for (let i = forward.length - 2; i >= 0; i--) {
    const point = forward[i]!;
    back.push({ ...point, distM: 2 * totalM - point.distM });
  }
  return [...forward, ...back];
}

/**
 * The profile as it is actually hiked. Ingest mirrors to compute statistics but deliberately
 * stores the un-mirrored line, so the reconciliation belongs at every boundary that *draws* a
 * profile — otherwise the section chart plots the outward leg under round-trip stats.
 *
 * The route type alone is not enough: 132 out-and-backs were classified *from* retracing and
 * already hold both legs, so mirroring one would advertise a 40 km day for a 20 km walk. The
 * test is which reading the published length agrees with — mirror only when the round trip
 * lands nearer `lengthM` than the stored line does. A comparison against NaN is false, which
 * makes a missing length a safe refusal. `lengthM` is required, not defaulted: an invisible
 * default is how a chart came to disagree with the table above it at every call site at once.
 */
export function hikedProfile(
  profile: readonly ElevationPoint[],
  opts: { routeType: RouteType; lengthM: number },
): ElevationPoint[] {
  const storedM = profile.length > 0 ? profile[profile.length - 1]!.distM : 0;
  const mirrorFits =
    opts.routeType === 'out_and_back' &&
    profile.length >= 2 &&
    Math.abs(2 * storedM - opts.lengthM) < Math.abs(storedM - opts.lengthM);

  return mirrorFits ? mirrorProfile(profile) : profile.map((p) => ({ ...p }));
}

/** Every derived statistic a trail card and detail page needs, in one pass. */
export function computeTrailStats(
  profile: readonly ElevationPoint[],
  opts: { paceFactor?: number; terrainFactor?: number } = {},
): TrailStats {
  if (profile.length === 0) {
    return {
      lengthM: 0,
      gainM: 0,
      lossM: 0,
      minEleM: 0,
      maxEleM: 0,
      maxSustainedGrade: null,
      estimatedTimeS: 0,
    };
  }

  const elevations = profile.map((p) => p.eleM);
  const { gainM, lossM } = computeGainLoss(elevations);

  let minEleM = Infinity;
  let maxEleM = -Infinity;
  for (const e of elevations) {
    if (e < minEleM) minEleM = e;
    if (e > maxEleM) maxEleM = e;
  }

  return {
    lengthM: Math.round(profile[profile.length - 1]!.distM),
    gainM,
    lossM,
    minEleM: Math.round(minEleM),
    maxEleM: Math.round(maxEleM),
    maxSustainedGrade: maxSustainedGrade(profile),
    estimatedTimeS: Math.round(estimateMovingTimeS(profile, opts)),
  };
}

/** Index of the profile's high point — always included as a weather sample. */
export function highPointIndex(profile: readonly ElevationPoint[]): number {
  let best = 0;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i]!.eleM > profile[best]!.eleM) best = i;
  }
  return best;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
