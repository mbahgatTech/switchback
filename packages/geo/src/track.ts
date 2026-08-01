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
 * Turning recorded GPS fixes into a hike's headline numbers. Lives in `geo` rather than `api` so
 * the recorder shows the same distance and ascent on screen as the server computes afterwards.
 */

/**
 * Movement between consecutive fixes below this is jitter, not travel. Applied against the last
 * *accepted* position, not per fix, so a slow hiker's 1.4 m steps accumulate and then count in
 * full — four metres sits above consumer GPS wander and below a hiking pace's per-second step.
 */
export const MIN_STEP_M = 4;

/** Below this speed the hiker is stopped, for moving-time purposes. 0.5 m/s is about 1.8 km/h. */
export const STOPPED_SPEED_MPS = 0.5;

/**
 * A speed above this between two fixes is a GPS jump, not a person — under canopy a fix can leap
 * 100 m and come straight back. Rejected outright; the next fix measures from the last believed.
 */
export const MAX_PLAUSIBLE_SPEED_MPS = 30;

/** Metres in the split unit, by unit system. A mile, exactly. */
export const SPLIT_UNIT_M: Readonly<Record<'metric' | 'imperial', number>> = {
  metric: 1_000,
  imperial: 1_609.344,
};

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Drop fixes that are not positions, and order what remains by time. Ordering matters: a retried
 * batch can land after the one that followed it and draw a spike across the map.
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

  // Two fixes with the same `t` is a duplicate upload: keep the first, so a retried batch
  // cannot double a hike's distance.
  const out: TrackFix[] = [];
  let lastT = -1;
  let lastKept: TrackFix | null = null;
  for (const fix of ordered) {
    if (fix.t === lastT) continue;
    if (lastKept) {
      const dt = fix.t - lastKept.t;
      const step = haversineM([lastKept.lng, lastKept.lat], [fix.lng, fix.lat]);
      // Rejecting a teleport rather than clamping keeps the *next* fix measured from somewhere
      // real, which is what stops one bad fix costing two spurious legs.
      if (dt > 0 && step / dt > MAX_PLAUSIBLE_SPEED_MPS) continue;
    }
    out.push(fix);
    lastT = fix.t;
    lastKept = fix;
  }
  return out;
}

/**
 * The longest a thinned track may go without a stored fix. Douglas–Peucker is geometric and knows
 * nothing about time, so a straight kilometre reduces to two endpoints — and heart rate, per-split
 * gain, elevation and pace are all sampled at the points that survive.
 */
export const MAX_SAMPLE_GAP_S = 30;

/**
 * Thin a track for storage, keeping the shape, the endpoints, and the time series. Run after
 * `cleanFixes` and after `summariseTrack`, never before: simplification removes the fixes a
 * stationary pause is made of, which is exactly what moving time is computed from.
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

  // Refill any stretch the geometry filter flattened, evenly spaced within the gap rather than
  // "every maxGapS from the left", so a 70-second stretch keeps two fixes 23 s apart.
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
 * Hike the fixes once, producing the per-leg facts every statistic is built from. Totals and
 * splits share this traversal so the split table always sums to the headline distance.
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
      // Below the noise floor: still stopped time, but no ground. The anchor deliberately does
      // not advance, so a genuine slow hike accumulates against a fixed point.
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
 * Cumulative distance at each fix, index-aligned with the input. Distinct from
 * `cumulativeDistancesM` in `distance.ts`: this runs the same `toLegs` traversal the totals use,
 * so the series and the summary agree — a FIT file shows a watch both at once.
 *
 * Expects fixes already through `cleanFixes`; cleaning again would misalign the returned array.
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
 * The headline numbers for a recording. `elapsedTimeS` is wall clock from first fix to last;
 * `movingTimeS` excludes the stops. Both are reported because they answer different questions.
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
    // Average against moving time, not elapsed — a pace counting the summit lunch is not one
    // anybody recognises, and not what any other tracker reports.
    avgSpeedMps: movingTimeS > 0 ? round1((distanceM / movingTimeS) * 100) / 100 : null,
    maxSpeedMps: maxSpeedMps > 0 ? round1(maxSpeedMps * 100) / 100 : null,
  };
}

/**
 * Per-unit splits, in the hiker's own unit system. A leg straddling a boundary is divided in
 * proportion to distance, so the split distances sum to the total shown above the table.
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
      // that last row comparable to the ones above it.
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

    // A single leg can span a boundary (a long gap in the fixes), hence a loop not an if.
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

  // A zero-distance tail is a pause at the end of the last full unit, not a split of its own.
  if (bucketDist >= 1) bank(clean.length - 1, false);

  return splits;
}

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
 * GPX 1.1 for a recorded track. A `<trk>`, not a `<rte>`: importing a recording as a route makes
 * it a course with no times. Every point carries an absolute `<time>` reconstructed from
 * `startedAt + t`, without which consumers compute zero for pace and moving time.
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
 * GPX 1.1 for a planned route. Separate from `toGpx` rather than a flag, because `<rte>` against
 * `<trk>` is the meaning of the file: importing a plan as a track records it in Garmin Connect as
 * an activity completed at 00:00 on 1 January at infinite pace. `<ele>` is written for every
 * point so a device does not recompute ascent from its own coarser DEM.
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
