import {
  MAX_FIX_ACCURACY_M,
  TRACK_SIMPLIFY_M,
  type ActivityStats,
  type LngLat,
  type Split,
  type TrackFix,
} from '@switchback/core';
import { haversineM } from './distance';
import { computeGainLoss } from './profile';
import { simplifyIndices } from './polyline';

/**
 * Turning a bag of GPS fixes into the numbers a hike is remembered by.
 *
 * Everything here runs on the server against what was actually uploaded, never on the
 * client's own totals — `packages/core/activities.ts` explains why. It is also the reason
 * this file is in `geo` rather than `api`: the recorder needs the same distance and ascent
 * on screen while the hike is happening, and two implementations of "how far have I come"
 * that disagree by 4% is the kind of thing people notice and never trust again.
 *
 * **Three corrections separate a plausible number from a real one**, and all three exist
 * because a phone is not a survey instrument:
 *
 * 1. **Bad fixes are dropped, not averaged in.** A 300 m accuracy fix from a cold start is
 *    not a position. Averaging it moves the whole track; keeping it adds phantom distance
 *    twice, going and coming back.
 * 2. **Distance ignores movement below the noise floor.** Standing at a viewpoint for ten
 *    minutes at 1 Hz produces six hundred fixes scattered over a few metres, and summing
 *    them adds a kilometre to a hike where nobody moved. See `MIN_STEP_M`.
 * 3. **Ascent uses the same hysteresis filter as trail stats.** `computeGainLoss` with the
 *    standard 10 m threshold, so a recorded hike and the trail it followed report ascent
 *    on the same terms and can honestly be compared.
 */

/**
 * Movement between consecutive fixes below this is treated as jitter, not travel.
 *
 * Consumer GPS wanders by a couple of metres while stationary, and at 1 Hz that wander is
 * sampled thousands of times over a lunch stop. Four metres sits above the wander and below
 * a hiking pace's per-second step of roughly 1.4 m — which is why the threshold cannot
 * simply be applied per fix. It is applied against the *last accepted position*, so a slow
 * hiker's 1.4 m steps accumulate until they clear 4 m and then count in full. Nothing real
 * is lost; only the standing still is.
 */
export const MIN_STEP_M = 4;

/**
 * Below this speed the hiker is considered stopped, for moving-time purposes.
 *
 * Moving time is the statistic people compare against each other, and it is meaningless if
 * a two-hour lunch counts. 0.5 m/s is about 1.8 km/h — slower than anyone hikes and faster
 * than anyone stands.
 */
export const STOPPED_SPEED_MPS = 0.5;

/**
 * A speed above this, between two fixes, is a GPS jump rather than a person.
 *
 * Under canopy a fix can leap a hundred metres and come straight back. That is 100 m/s at
 * 1 Hz — beyond any activity we support, including the downhill ones — so it is rejected
 * outright, and the next fix is measured from the last position we believed.
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 30;

/** Metres in the split unit, by unit system. A mile, exactly. */
export const SPLIT_UNIT_M: Readonly<Record<'metric' | 'imperial', number>> = {
  metric: 1_000,
  imperial: 1_609.344,
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

// ---------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------

/**
 * Drop fixes that are not positions, and order what remains by time.
 *
 * Ordering matters more than it looks: batches arrive over the network and a retried batch
 * can land after the one that followed it, which would otherwise put a fix from minute
 * three between two fixes from minute nine and draw a spike across the map.
 */
export function cleanFixes(fixes: readonly TrackFix[]): TrackFix[] {
  const ordered = [...fixes]
    .filter(
      (fix) =>
        Number.isFinite(fix.lng) &&
        Number.isFinite(fix.lat) &&
        (fix.accuracyM == null || fix.accuracyM <= MAX_FIX_ACCURACY_M),
    )
    .sort((a, b) => a.t - b.t);

  // Two fixes with the same `t` is a duplicate upload, not a decision to make: keep the
  // first and let the second go, so a retried batch cannot double a hike's distance.
  const out: TrackFix[] = [];
  let lastT = -1;
  let lastKept: TrackFix | null = null;
  for (const fix of ordered) {
    if (fix.t === lastT) continue;
    if (lastKept) {
      const dt = fix.t - lastKept.t;
      const step = haversineM([lastKept.lng, lastKept.lat], [fix.lng, fix.lat]);
      // A teleport. Rejecting it rather than clamping keeps the *next* fix measured from
      // somewhere real, which is what stops one bad fix costing two spurious legs.
      if (dt > 0 && step / dt > MAX_PLAUSIBLE_SPEED_MPS) continue;
    }
    out.push(fix);
    lastT = fix.t;
    lastKept = fix;
  }
  return out;
}

/**
 * The longest a thinned track may go without a stored fix.
 *
 * Douglas–Peucker is a *geometric* filter and knows nothing about time, so a straight
 * kilometre of towpath reduces to its two endpoints — correct as a shape, and ruinous as a
 * recording. Everything a track carries besides its outline is sampled at those points:
 * heart rate, per-split gain, the elevation series, the pace curve. Two points for twenty
 * minutes of hiking means one leg, one heart rate, and a split table with nothing in it.
 *
 * So the thinned track is topped back up to at least one fix every half minute. It costs
 * 720 rows for a six-hour hike — nothing — and it is the difference between a recording
 * that can be redrawn and one that can only be outlined.
 */
export const MAX_SAMPLE_GAP_S = 30;

/**
 * Thin a track for storage, keeping the shape, the endpoints, and the time series.
 *
 * Run after `cleanFixes` and after `summariseTrack` — never before. Simplification removes
 * the fixes a stationary pause is made of, which is exactly the data moving time is
 * computed from; measure first, then thin.
 */
export function simplifyTrack(
  fixes: readonly TrackFix[],
  toleranceM = TRACK_SIMPLIFY_M,
  maxGapS = MAX_SAMPLE_GAP_S,
): TrackFix[] {
  if (fixes.length <= 2) return [...fixes];
  const coords: LngLat[] = fixes.map((fix) => [fix.lng, fix.lat]);
  const kept = simplifyIndices(coords, toleranceM);
  if (maxGapS <= 0) return kept.map((i) => fixes[i]!);

  // Hike the survivors and refill any stretch the geometry filter flattened. Evenly spaced
  // within the gap rather than "every maxGapS from the left", so a 70-second stretch keeps
  // two fixes at 23 s apart instead of one at 30 and a straggler at 10.
  const out: TrackFix[] = [];
  for (let k = 0; k < kept.length; k++) {
    const at = kept[k]!;
    out.push(fixes[at]!);
    const next = kept[k + 1];
    if (next === undefined) break;

    const span = fixes[next]!.t - fixes[at]!.t;
    const inserts = Math.ceil(span / maxGapS) - 1;
    if (inserts <= 0 || next - at <= 1) continue;

    let last = at;
    for (let n = 1; n <= inserts; n++) {
      // Nearest stored fix to the target time, taken by index within the flattened run.
      const target = fixes[at]!.t + (span * n) / (inserts + 1);
      let pick = last;
      for (let i = last + 1; i < next; i++) {
        if (Math.abs(fixes[i]!.t - target) < Math.abs(fixes[pick]!.t - target)) pick = i;
      }
      if (pick > last) {
        out.push(fixes[pick]!);
        last = pick;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

interface Leg {
  /** Distance credited for this leg, after the jitter floor. */
  distanceM: number;
  /** Seconds between the two fixes. */
  dtS: number;
  /** Whether the hiker counted as moving across it. */
  moving: boolean;
  /** Index of the fix this leg arrives at. */
  to: number;
}

/**
 * Hike the fixes once, producing the per-leg facts every statistic is built from.
 *
 * Both the totals and the splits need the same traversal, and doing it twice invites the
 * two to drift apart — a split table whose distances do not sum to the headline distance is
 * a bug report waiting to happen.
 */
function toLegs(fixes: readonly TrackFix[]): Leg[] {
  const legs: Leg[] = [];
  if (fixes.length < 2) return legs;

  let anchor = fixes[0]!;
  for (let i = 1; i < fixes.length; i++) {
    const fix = fixes[i]!;
    const step = haversineM([anchor.lng, anchor.lat], [fix.lng, fix.lat]);
    const dtS = Math.max(0, fix.t - anchor.t);

    if (step < MIN_STEP_M) {
      // Below the noise floor. The leg still happened in time — it is stopped time — but
      // it covered no ground, and the anchor deliberately does not advance, so a genuine
      // slow hike accumulates against a fixed point instead of being erased step by step.
      legs.push({ distanceM: 0, dtS, moving: false, to: i });
      continue;
    }

    const speed = dtS > 0 ? step / dtS : 0;
    legs.push({ distanceM: step, dtS, moving: speed >= STOPPED_SPEED_MPS, to: i });
    anchor = fix;
  }
  return legs;
}

/**
 * Cumulative distance at each fix, in metres, aligned index-for-index with the input.
 *
 * Named apart from `cumulativeDistancesM` in `distance.ts` because it is a different
 * measurement, not an overload: that one adds up raw haversine hops between coordinates,
 * this one runs the same `toLegs` traversal the totals and the splits use, so a fix that
 * moved less than the jitter floor contributes nothing here either.
 *
 * That is the whole point of it existing. A per-point series computed the naive way
 * disagrees with the headline figure at the last point by a few metres, and the one place
 * that shows is a FIT file, where a watch reads the series and the summary and displays
 * both.
 *
 * Expects fixes that have already been through `cleanFixes` — it does not clean them itself,
 * because the callers that want a per-point series have invariably just cleaned the track to
 * compute something else, and cleaning twice would produce a series that no longer lines up
 * with the array the caller is holding.
 */
export function fixDistancesM(fixes: readonly TrackFix[]): number[] {
  const out = Array.from({ length: fixes.length }, () => 0);
  let running = 0;
  for (const leg of toLegs(fixes)) {
    running += leg.distanceM;
    out[leg.to] = running;
  }
  return out;
}

/**
 * The headline numbers for a recording.
 *
 * `elapsedTimeS` is wall clock from first fix to last; `movingTimeS` excludes the stops.
 * Both are reported because they answer different questions — "how long were you out" and
 * "how fast were you going" — and a product that only shows one of them is answering the
 * question the user did not ask half the time.
 */
export function summariseTrack(fixes: readonly TrackFix[]): ActivityStats {
  const clean = cleanFixes(fixes);
  const empty: ActivityStats = {
    distanceM: 0,
    gainM: 0,
    lossM: 0,
    minEleM: null,
    maxEleM: null,
    movingTimeS: 0,
    elapsedTimeS: 0,
    avgSpeedMps: null,
    maxSpeedMps: null,
  };
  if (clean.length === 0) return empty;

  const elapsedTimeS = Math.max(0, clean[clean.length - 1]!.t - clean[0]!.t);
  if (clean.length === 1) return { ...empty, elapsedTimeS };

  let distanceM = 0;
  let movingTimeS = 0;
  let maxSpeedMps = 0;
  for (const leg of toLegs(clean)) {
    distanceM += leg.distanceM;
    if (leg.moving) {
      movingTimeS += leg.dtS;
      if (leg.dtS > 0) maxSpeedMps = Math.max(maxSpeedMps, leg.distanceM / leg.dtS);
    }
  }

  const elevations = clean
    .map((fix) => fix.eleM)
    .filter((ele): ele is number => ele != null && Number.isFinite(ele));
  const { gainM, lossM } = computeGainLoss(elevations);

  return {
    distanceM: Math.round(distanceM),
    gainM: Math.round(gainM),
    lossM: Math.round(lossM),
    minEleM: elevations.length > 0 ? Math.round(Math.min(...elevations)) : null,
    maxEleM: elevations.length > 0 ? Math.round(Math.max(...elevations)) : null,
    movingTimeS: Math.round(movingTimeS),
    elapsedTimeS,
    // Average against moving time, not elapsed. A pace that counts the summit lunch is not
    // a pace anybody recognises, and it is not what any other tracker reports either.
    avgSpeedMps: movingTimeS > 0 ? round1((distanceM / movingTimeS) * 100) / 100 : null,
    maxSpeedMps: maxSpeedMps > 0 ? round1(maxSpeedMps * 100) / 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Splits
// ---------------------------------------------------------------------------

/**
 * Per-unit splits, in the hiker's own unit system.
 *
 * A leg that straddles a boundary is divided in proportion to distance rather than being
 * assigned whole to one side. Legs are seconds long, so the error either way is tiny — but
 * assigning whole legs makes the split distances fail to sum to the total, and a table whose
 * column does not add up to the number above it reads as broken even when it is close.
 */
export function computeSplits(
  fixes: readonly TrackFix[],
  units: 'metric' | 'imperial' = 'metric',
): Split[] {
  const clean = cleanFixes(fixes);
  if (clean.length < 2) return [];
  const unitM = SPLIT_UNIT_M[units];

  const splits: Split[] = [];
  let bucketDist = 0;
  let bucketElapsed = 0;
  let bucketMoving = 0;
  let bucketStartIndex = 0;
  let index = 1;

  const bank = (endIndex: number, complete: boolean): void => {
    if (bucketDist <= 0 && !complete) return;
    const slice = clean
      .slice(bucketStartIndex, endIndex + 1)
      .map((fix) => fix.eleM)
      .filter((ele): ele is number => ele != null && Number.isFinite(ele));
    const { gainM, lossM } = computeGainLoss(slice);
    splits.push({
      index,
      distanceM: Math.round(bucketDist),
      elapsedS: Math.round(bucketElapsed),
      movingS: Math.round(bucketMoving),
      gainM: Math.round(gainM),
      lossM: Math.round(lossM),
      // Pace is quoted per whole unit even for the partial final split, which is what makes
      // that last row comparable to the ones above it rather than just shorter.
      paceSPerUnit: bucketDist > 0 ? Math.round((bucketMoving / bucketDist) * unitM) : 0,
      complete,
    });
    index += 1;
    bucketDist = 0;
    bucketElapsed = 0;
    bucketMoving = 0;
    bucketStartIndex = endIndex;
  };

  for (const leg of toLegs(clean)) {
    let remaining = leg.distanceM;
    let remainingTime = leg.dtS;

    // A single leg can in principle span a boundary (a long gap in the fixes), so this is
    // a loop rather than an if.
    while (bucketDist + remaining >= unitM && remaining > 0) {
      const need = unitM - bucketDist;
      const share = remaining > 0 ? need / remaining : 0;
      const timeShare = remainingTime * share;
      bucketDist += need;
      bucketElapsed += timeShare;
      if (leg.moving) bucketMoving += timeShare;
      remaining -= need;
      remainingTime -= timeShare;
      bank(leg.to, true);
    }

    bucketDist += remaining;
    bucketElapsed += remainingTime;
    if (leg.moving) bucketMoving += remainingTime;
  }

  // The tail, if the hike did not end on a boundary. A zero-distance tail is a pause at the
  // end of the last full unit and is not a split of its own.
  if (bucketDist >= 1) bank(clean.length - 1, false);

  return splits;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** `[lng, lat, eleM | null]` triples — the wire form of a track. */
export function toTrackTuples(fixes: readonly TrackFix[]): Array<[number, number, number | null]> {
  return fixes.map((fix) => [fix.lng, fix.lat, fix.eleM ?? null]);
}

export function toGeoJsonLine(fixes: readonly TrackFix[]): {
  type: 'LineString';
  coordinates: Array<[number, number]>;
} {
  return { type: 'LineString', coordinates: fixes.map((fix) => [fix.lng, fix.lat]) };
}

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => XML_ESCAPES[char] ?? char);
}

export interface GpxOptions {
  name: string;
  startedAt: Date;
  description?: string | null;
  /** Written into `<trk><type>`; Garmin and Strava both read it on import. */
  activityType?: string;
}

/**
 * GPX 1.1 for a recorded track.
 *
 * Hand-written rather than generated by a library because the output is forty lines of
 * well-specified XML and the dependency would be the larger thing to maintain. It is a
 * `<trk>` and not a `<rte>`: a route is a plan, a track is what happened, and importing a
 * recording as a route is what makes it show up in Garmin Connect as a course with no times.
 *
 * Every point carries an absolute `<time>`, reconstructed from `startedAt + t`. Without it
 * the file still draws, but every consumer computes zero for pace and moving time.
 */
export function toGpx(fixes: readonly TrackFix[], options: GpxOptions): string {
  const start = options.startedAt.getTime();
  const points = fixes
    .map((fix) => {
      const at = new Date(start + fix.t * 1000).toISOString();
      const ele = fix.eleM != null ? `<ele>${fix.eleM.toFixed(1)}</ele>` : '';
      const hr =
        fix.heartRate != null
          ? `<extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${fix.heartRate}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions>`
          : '';
      return `      <trkpt lat="${fix.lat.toFixed(7)}" lon="${fix.lng.toFixed(7)}">${ele}<time>${at}</time>${hr}</trkpt>`;
    })
    .join('\n');

  const description = options.description
    ? `\n    <desc>${xmlEscape(options.description)}</desc>`
    : '';
  const type = options.activityType ? `\n    <type>${xmlEscape(options.activityType)}</type>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Switchback"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:gpxtpx="http://www.garmin.com/xmlschemas/TrackPointExtension/v1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/11.xsd">
  <metadata>
    <name>${xmlEscape(options.name)}</name>
    <time>${options.startedAt.toISOString()}</time>
  </metadata>
  <trk>
    <name>${xmlEscape(options.name)}</name>${description}${type}
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`;
}

export interface RouteGpxOptions {
  name: string;
  description?: string | null;
  /** Written into `<rte><type>`; Garmin and Strava both read it on import. */
  activityType?: string;
}

/**
 * GPX 1.1 for a planned route.
 *
 * A second writer rather than a flag on `toGpx`, because the difference is `<rte>` against
 * `<trk>` and that is not a formatting detail — it is the whole meaning of the file. A track
 * is a record of a hike that happened, and every point on it carries the instant it was
 * reached. A route is a line somebody intends to hike, and it has no times at all, because
 * nobody has hiked it yet.
 *
 * Importing a plan as a track is how a route shows up in Garmin Connect as an activity you
 * are recorded as having completed at 00:00 on the first of January, at infinite pace. The
 * two documents are close enough in XML and far enough apart in consequence that keeping
 * them as separate functions is cheaper than keeping the distinction in a caller's head.
 *
 * `<ele>` is written for every point because the profile is the reason to plan on this
 * product rather than by dragging a line on a satellite photo, and a device that gets the
 * line without the ground recomputes ascent from its own coarser DEM.
 */
export function toRouteGpx(
  points: ReadonlyArray<{ lng: number; lat: number; eleM: number }>,
  options: RouteGpxOptions,
): string {
  const body = points
    .map(
      (point) =>
        `      <rtept lat="${point.lat.toFixed(7)}" lon="${point.lng.toFixed(7)}"><ele>${point.eleM.toFixed(1)}</ele></rtept>`,
    )
    .join('\n');

  const description = options.description
    ? `\n    <desc>${xmlEscape(options.description)}</desc>`
    : '';
  const type = options.activityType ? `\n    <type>${xmlEscape(options.activityType)}</type>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Switchback"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/11.xsd">
  <metadata>
    <name>${xmlEscape(options.name)}</name>
  </metadata>
  <rte>
    <name>${xmlEscape(options.name)}</name>${description}${type}
${body}
  </rte>
</gpx>
`;
}
