import type { ElevationPoint, LngLat, RouteType, TrailStats } from '@switchback/core';
import { cumulativeDistancesM } from './distance';
import { estimateMovingTimeS } from './tobler';

/**
 * Elevation-gain threshold, in metres.
 *
 * This constant is the single most consequential number in the whole stats pipeline.
 * DEM sampling noise is roughly ±3 m; summing every positive delta between adjacent
 * samples therefore accumulates hundreds of metres of gain that do not exist — the
 * classic reason a flat lakeside path reports 400 m of climb. A hysteresis threshold
 * suppresses it: elevation must move `GAIN_THRESHOLD_M` away from the running
 * reference before any of it counts, and then the whole excursion counts at once.
 *
 * 10 m matches the convention used by Garmin and Strava for barometric-free tracks,
 * which is what makes our numbers comparable to the ones users already know.
 */
export const GAIN_THRESHOLD_M = 10;

/** Window for sustained-grade measurement. Shorter windows just measure DEM noise. */
export const GRADE_WINDOW_M = 100;

export interface GainLoss {
  gainM: number;
  lossM: number;
}

/**
 * Total ascent and descent, using a hysteresis filter (see `GAIN_THRESHOLD_M`).
 *
 * The reference elevation tracks the last confirmed turning point. Movement away
 * from it only registers once it exceeds the threshold, at which point the entire
 * excursion is credited and the reference resets.
 */
export function computeGainLoss(
  elevations: readonly number[],
  thresholdM = GAIN_THRESHOLD_M,
): GainLoss {
  if (elevations.length < 2) return { gainM: 0, lossM: 0 };

  let gainM = 0;
  let lossM = 0;
  let reference = elevations[0]!;
  // Tracks the furthest point reached in the current direction, so a climb that
  // pauses and resumes is credited in full rather than being split and re-thresholded.
  let extreme = reference;
  let direction: 0 | 1 | -1 = 0;

  for (let i = 1; i < elevations.length; i++) {
    const ele = elevations[i]!;
    if (!Number.isFinite(ele)) continue;

    if (direction === 0) {
      if (ele - reference >= thresholdM) {
        direction = 1;
        extreme = ele;
      } else if (reference - ele >= thresholdM) {
        direction = -1;
        extreme = ele;
      }
      continue;
    }

    if (direction === 1) {
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
  }

  // Bank whatever the final leg accumulated.
  if (direction === 1) gainM += extreme - reference;
  else if (direction === -1) lossM += reference - extreme;

  return { gainM: round1(gainM), lossM: round1(lossM) };
}

/**
 * Steepest grade sustained over `windowM`, as a fraction (0.25 = 25%).
 *
 * Measured over a window rather than between adjacent samples, because a single
 * noisy 25 m step can imply a 40% grade that nobody would recognise on the ground.
 * Returns null for lines too short to contain a full window.
 *
 * The tail advances to whichever sample puts the run *closest* to `windowM`, from either
 * side. Reaching for the longest run that still fits underneath it — the obvious reading,
 * and what this did — silently returned 0 for one climbing trail in eight. Profiles are
 * resampled to a nominal 25 m, but `resampleLine` spreads the remainder along the line, so
 * the real step lands a hair either side of it. At 25.2 m four steps measure 100.8 m, the
 * tail moved up to keep the run under 100, and the remaining 75.6 m fell below the tolerance
 * below — for that head and, since the tail never moves back, for every head after it. No
 * window ever qualified and the initial `max` of 0 came out the far end, under a stat block
 * reporting 748 m of climb. At 24.998 m the same four steps measure 99.99 m, nothing
 * advanced, and the trail reported 35% all along.
 *
 * Choosing by distance from the target rather than by fitting under it is what makes those
 * two spacings behave the same. It matters in the other direction too: at 24.9 m the sixth
 * sample is 124.5 m out and the fifth is 99.6 m, and only one of those is a 100 m window.
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
    // The run shrinks as the tail advances, so the distance from `windowM` falls and then
    // rises exactly once — this stops at the bottom of it. The best tail for a given head is
    // never behind the best tail for the head before, so this stays one pass over the line.
    while (tail < head - 1 && miss(head, tail + 1) <= miss(head, tail)) tail++;
    const run = profile[head]!.distM - profile[tail]!.distM;
    // Only the first few heads can fall short now, before the line is a window long. The
    // tolerance keeps a profile whose spacing does not divide the window from losing its
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
 * How far a sample may stand off the ground its neighbours agree about, as a grade, before it
 * is considered unwalkable.
 *
 * Expressed as a grade rather than as metres so it means the same thing at every sampling
 * density: profiles are resampled to 25 m on a normal trail but to several hundred on one
 * long enough to hit `MAX_PROFILE_POINTS`, and a fixed metre threshold would be paranoid at
 * one end and useless at the other.
 *
 * 2.0 is 63°. This is the physics half of the test and it is not a tuned number — ground that
 * departs from its own neighbourhood at 63° and returns is not ground anyone walks over.
 */
export const SPIKE_GRADE = 2;

/**
 * How far out of character the excursion must be, against the slope the neighbourhood is
 * already running at.
 *
 * `SPIKE_GRADE` alone cannot finish the job, because a 63° departure means something quite
 * different on a valley floor than on a cliff face. Every genuine bad pixel in the corpus sits
 * on ground running flatter than 15%; the real terrain that clears 2.0 sits on ground running
 * 27% to 149%.
 *
 * **8 is the tight number in this file, and pretending otherwise would be the mistake.** Twenty
 * six samples across all 53,987 stored profiles clear the deviation bar. Sorted by ratio they
 * run 1.5, 1.5, 2.8, 4.5, 4.6, 6.7 — all real ground, four of them on the col Citadel Peak
 * Route crosses — then 10.4, and then nothing at all until 71. The wide gap is the second one,
 * and putting the threshold in it would be the comfortable choice; it would also leave Isabelle
 * Peak Route publishing 192 m of ascent that is not there, from a single sample sitting
 * 148 m below a ridge it returns to 22 m later.
 *
 * What settles it is that the two errors do not cost the same. This rule does not flatten what
 * it rejects — `fillGaps` bridges the sample from its own neighbours, and on the steep ground
 * that is the only place a false positive can occur, those neighbours are close by in height.
 * Dropping Citadel's 2,378.8 m in error would move it to 2,397 m: 18 m, on a route that climbs
 * 595. Missing Isabelle's costs 300. So the threshold goes in the narrow gap, on the side that
 * is cheap to be wrong on, and if a future trail lands between 6.7 and 10.4 the damage is a
 * couple of dozen metres on one cliff rather than a hole in a beach.
 */
const SPIKE_TREND_RATIO = 8;

/**
 * How many samples on each side establish where the ground is.
 *
 * The reference is a *median*, so the window tolerates almost half of itself being wrong:
 * seven per side survives a run of three bad samples intact. That matters — Ball Creek Road
 * drops from 1,371 m to 101 m to 0 m to 0 m and back to 1,371 m, three bad samples in a row,
 * and a three-sample window centred on the middle one would take its reference from the hole.
 *
 * Seven rather than five, and the two extra are load-bearing. Kalaloch Beaches holds runs of
 * *six*, where the sample in the middle has three bad readings on one side of it; a median
 * over five is outvoted there and reports the hole as the ground, which sends the trend past
 * `SPIKE_GRADE` and the cliff gate then waves the whole run through. Seven puts the median
 * back on the beach, `SPIKE_PASSES` erodes what is left, and the run comes out. Nothing else
 * in the corpus moves — the ratio ordering the threshold was read off is the same at seven as
 * at five, because a wider window only pushes the references further apart, and the span
 * between them is the denominator of both numbers being compared.
 */
const SPIKE_WINDOW = 7;

/**
 * How many times the scan runs before it gives up.
 *
 * A median over five survives a run of two, and past that the reference on the inner side is
 * itself inside the hole — so a long run hides its own ends. Kalaloch Beaches has two runs of
 * six consecutive bad samples, and a single pass rejects only the middle of each, leaving the
 * shoulders to be interpolated *from each other* and the beach still publishing kilometres of
 * ascent.
 *
 * Rescanning fixes it, because each pass makes the next one's job easier: the samples it drops
 * are skipped by `reference`, which then reaches past them to real ground, and the run erodes
 * from the middle outwards. Six clears in three passes. Six is the cap because it covers a run
 * of about twelve — twice the worst the corpus holds — and because a rule that will not settle
 * by then is not converging and should stop rather than keep eating the profile.
 */
const SPIKE_PASSES = 6;

/**
 * Drop samples that stand off ground their own neighbourhood agrees about, so `fillGaps` can
 * bridge them.
 *
 * Terrarium tiles carry bathymetry, and `NO_DATA_ELEVATION` only catches the RGB(0,0,0)
 * sentinel — a pixel holding real ocean floor decodes to a real, and completely wrong,
 * number. North Kalaloch Beach is a beach walk whose line strays a few metres over water at
 * one sample, and that sample came back **-958.7 m** in a profile otherwise between -5 m and
 * +14 m. Nothing downstream questioned it: the hysteresis filter dutifully credited the climb
 * back out of the hole, so a walk along the sand published 975 m of ascent, a low point of
 * -959 m, an elevation graph that is one spike and a flat line, and a steepest grade of 964%.
 * One bad pixel, four wrong numbers on the page.
 *
 * **The test is a spike, not a slope, and the distinction is the whole design.** The tempting
 * rule — reject any step steeper than some grade — cannot tell a bad pixel from a cliff the
 * trail genuinely descends, and quietly flattening real terrain is a worse failure than the
 * one being fixed, because nothing on the page would look wrong afterwards. Citadel Peak
 * Route is the case that keeps this honest: it drops 120 m in 25 m, a 480% step that any
 * step-based rule rejects on sight, and then it *stays down* — 2,556 m, 2,542 m, 2,422 m,
 * 2,393 m. That is a cliff the route goes over, and the profile is right about it.
 *
 * So each sample is asked two questions, and has to fail both to be dropped.
 *
 * 1. **Is the excursion walkable?** Two medians, one per side, say where the ground is; the
 *    chord between them predicts this sample. A miss of more than `SPIKE_GRADE` — measured
 *    over half the span the chord itself is drawn across, because the excursion has to depart
 *    and return within it — is not terrain.
 * 2. **Is it out of character?** The same miss, against the slope the two medians already run
 *    between themselves. Steep ground is allowed to be surprising in proportion to how steep
 *    it is; flat ground is not.
 *
 * One question is not enough, and the corpus is unambiguous about which cases need the other.
 * Kalaloch fails both by three orders of magnitude — the ground either side agrees to within
 * centimetres and the sample is 1,635 m below what it jointly predicts. Citadel fails the
 * first four times over and passes the second every time, because a route across a col is
 * entitled to a rough profile. Half of the second test's work is on ground like Sentiero
 * Cengia Paolina, where the median straddles a knoll and the deviation is real relief rather
 * than a bad pixel.
 *
 * What comes out of the whole corpus is nineteen samples across five trails: thirteen in
 * Kalaloch Beaches, three consecutive in Ball Creek Road, and one each in North Kalaloch
 * Beach, Tramp Harbor Dock and Hoh River to Third Beach. Every one of them is a beach or a
 * river walk whose line crosses water, and every one reads between -78 m and -2,448 m.
 *
 * **The two ends are not judged, and that is a measured decision rather than an oversight.**
 * A first or last sample has a neighbourhood on one side only, so nothing can distinguish a
 * bad reading there from a trailhead on a cliff edge — and in this corpus it is always the
 * latter: the steepest end samples are Right Face Arrow Face Traverse and 7 Buttresses
 * Traverse, both real ground on Table Mountain, while every bathymetry hole (Kalaloch at 280
 * of 569, North Kalaloch at 90 of 96, Tramp Harbor at 5 of 11, Hoh River at 146 of 1,007) is
 * interior. Guessing at the ends would cost real trailheads to defend against a failure that
 * has not once occurred there. It costs nothing to leave them, either: a bad end cannot
 * mislead its neighbours, because one sample never moves a median.
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
   * The median of the samples on one side of a reading — where that side says the ground is.
   *
   * Counts samples it can actually read, not positions it steps over, so a reference beside a
   * hole reaches past it to real ground instead of averaging the hole. That cannot make the
   * rule more eager: the further away the reference, the larger `span`, and `span` is the
   * denominator of the deviation.
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
      // Past this the references describe a cliff rather than a neighbourhood, and a chord drawn
      // across it predicts nothing. A step that persists is exactly what this rule must not touch.
      if (trend > maxGrade) continue;

      // Where the sample would sit if the ground ran straight between the two references, and
      // how far it misses by. The run is half the chord's own span: an excursion has to leave
      // the chord and come back, so each leg gets half the baseline the chord was drawn over.
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
 * Linearly interpolate across missing elevations, extending the nearest known value
 * at the ends. A tile that failed to fetch should leave a smooth line rather than a
 * hole that later reads as a cliff and inflates gain.
 *
 * Exported for the sake of `scripts/repair-dem-spikes.ts`, which has to run this and
 * `despike` over profiles already in the database without going back through
 * `buildProfile`. Rebuilding is not the same operation on a stored row: it resamples
 * distances and rounds, so it would rewrite every profile in the corpus to fix five.
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
 * The same samples again, in reverse, with distance continuing past the turnaround.
 *
 * The return leg is built as real geometry rather than by doubling the numbers, because
 * doubling is wrong in every statistic except length. A doubled `gainM` counts the outward
 * leg's descents as climbs — the return climbs back up whatever you came down — and a
 * doubled `estimatedTimeS` charges Tobler's uphill price for ground that is now downhill.
 * Mirroring gets all seven statistics right for the cost of one array copy.
 *
 * The turnaround is not repeated. It is already the last forward sample, and a second copy
 * would put a zero-length segment in the middle of the profile and a duplicate label in
 * every axis drawn from it.
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
 * The profile as it is actually hiked, which is not always the profile we stored.
 *
 * OSM maps the ground, not the day out. The Llanberis Path is drawn once, uphill, and
 * stored that way — 5,987 m of geometry under a hike whose every published figure, ours
 * included, calls 11,974 m. Ingest already knows this: it mirrors the profile to compute
 * the statistics and then deliberately stores the un-mirrored line, because that line is
 * the geometry we actually have and writing the other half into the database would be a
 * fabrication made once and read forever. The reconciliation therefore belongs at the
 * boundary where something is *drawn*, and this is it. Without it the section chart draws
 * the outward leg under a stat block describing the round trip, and the axis stops at 6.0
 * beneath a table that says 12.0.
 *
 * **Why the route type is not enough on its own.** Ingest mirrors when the return leg is
 * *implied*, which is not the same as whenever the trail is an out-and-back. A trail whose
 * geometry genuinely retraces itself was classified *from* that retracing, so both legs are
 * already in the stored line — 132 of our out-and-backs are that kind, against 3,096 of the
 * other — and mirroring one of those would advertise a 40 km day for a 20 km walk. The
 * route type cannot tell the two apart. The stored line's own length can.
 *
 * So the test is which reading of the geometry the published length agrees with: mirror
 * only when the round trip lands nearer `lengthM` than the stored line does. That is
 * `|2·stored − lengthM| < |stored − lengthM|` and nothing else — no threshold anyone has to
 * defend, no behaviour when the two already agree, and a safe refusal for a missing or
 * nonsensical length, since a comparison against `NaN` is false and doing nothing is the
 * conservative answer.
 *
 * `lengthM` is required rather than defaulted, for the reason recorded on `elevationTicks`:
 * an invisible default is how a chart came to disagree with the table above it at every
 * call site at once.
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
