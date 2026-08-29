import type { ElevationPoint, LngLat, RouteType } from '@switchback/core';
import type { NearestOnLine } from './distance';
import { gainLossCurve, hikedProfile } from './profile';
import { SECTION_DISPLAY_POINTS, sectionSampleIndices } from './section';

/**
 * Where a hiker is on the trail they are following, and what is left of it.
 *
 * Built once per fix and read by everything that draws progress, so the mark on the map and
 * the marker on the section are one value rather than two computations that can disagree.
 */

/**
 * The hike a recording is measured against: the section as it will be drawn, and the ascent
 * accrued by each of its samples.
 *
 * The ascent curve is computed *before* thinning and carried alongside it. Ascent under the
 * hysteresis filter is sampling-dependent — measured on 220 samples it lands a few per cent
 * under the figure the trail publishes, and one screen would then report two climbs.
 */
export interface HikePlan {
  /** Empty when the trail's elevation pass has not run; the distance readings still work. */
  profile: readonly ElevationPoint[];
  /** Ascent from the trailhead to each sample of `profile`, metres. Same length. */
  gainToM: readonly number[];
  /** The line as mapped, which is the axis `alongM` is measured on. */
  storedLengthM: number;
  /** The hike, which is twice `storedLengthM` on a trail whose line is retraced. */
  hikedLengthM: number;
}

export interface RouteProgress {
  /** Along the line as mapped. */
  alongM: number;
  /** Along the hike, which past an out-and-back's turnaround runs on where `alongM` falls back. */
  hikedM: number;
  /** The fix projected onto the line — the mark on the map, and the marker on the section. */
  at: LngLat;
  remainingM: number;
  remainingGainM: number;
}

/**
 * How near the far end of the line counts as having turned around. A fraction rather than a
 * fixed distance so it means the same thing on a 900 m spur and a 40 km ridge.
 */
const TURNAROUND_FRACTION = 0.02;

/**
 * Assemble the plan from a stored profile. `lengthM` carries the reading when there is no
 * profile to build one from, so a trail awaiting its elevation pass still reports a distance.
 */
export function buildHikePlan(
  profile: readonly ElevationPoint[],
  opts: { routeType: RouteType; lengthM: number; maxPoints?: number },
): HikePlan | null {
  const hiked = hikedProfile(profile, opts);
  const storedLengthM = profile[profile.length - 1]?.distM ?? 0;
  const hikedLengthM = hiked[hiked.length - 1]?.distM ?? 0;

  if (hiked.length < 2 || storedLengthM <= 0) {
    if (opts.lengthM <= 0) return null;
    return { profile: [], gainToM: [], storedLengthM: opts.lengthM, hikedLengthM: opts.lengthM };
  }

  const curve = gainLossCurve(hiked.map((point) => point.eleM)).gainM;
  const keep = sectionSampleIndices(hiked, opts.maxPoints ?? SECTION_DISPLAY_POINTS);

  return {
    profile: keep.map((i) => hiked[i]!),
    gainToM: keep.map((i) => curve[i]!),
    storedLengthM,
    hikedLengthM,
  };
}

/**
 * Fold one projected fix into the reading. `previous` carries the turnaround: a hiked distance
 * already past the end of the mapped line is the only way to know an out-and-back is on its
 * way home, since a single fix on a retraced line cannot say which leg it belongs to.
 */
export function advanceProgress(
  plan: HikePlan,
  previous: RouteProgress | null,
  nearest: Pick<NearestOnLine, 'alongM' | 'closest'>,
): RouteProgress {
  const hikedM = hikedDistanceM(plan, previous?.hikedM ?? 0, nearest.alongM);
  const total = plan.gainToM[plan.gainToM.length - 1] ?? 0;

  return {
    alongM: nearest.alongM,
    hikedM,
    at: nearest.closest,
    remainingM: Math.max(0, plan.hikedLengthM - hikedM),
    remainingGainM: Math.max(0, round1(total - gainAt(plan, hikedM))),
  };
}

/** Ascent from the trailhead to a point along the hike, interpolated between samples. */
export function gainAt(plan: HikePlan, hikedM: number): number {
  const { profile, gainToM } = plan;
  if (profile.length === 0) return 0;

  const last = profile.length - 1;
  if (hikedM <= profile[0]!.distM) return gainToM[0]!;
  if (hikedM >= profile[last]!.distM) return gainToM[last]!;

  let low = 0;
  let high = last;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (profile[mid]!.distM <= hikedM) low = mid;
    else high = mid;
  }

  const span = profile[high]!.distM - profile[low]!.distM;
  if (span <= 0) return gainToM[low]!;
  const t = (hikedM - profile[low]!.distM) / span;
  return gainToM[low]! + (gainToM[high]! - gainToM[low]!) * t;
}

function hikedDistanceM(plan: HikePlan, previousHikedM: number, alongM: number): number {
  if (plan.hikedLengthM <= plan.storedLengthM) return alongM;
  const turnaround = plan.storedLengthM * (1 - TURNAROUND_FRACTION);
  const turned = previousHikedM >= plan.storedLengthM || alongM >= turnaround;
  // Floored at the outward leg, which is both true — nobody on the way back has walked less
  // than the way out — and what keeps the latch from unlatching: `alongM` is measured by
  // haversine over the geometry and `storedLengthM` by arithmetic over the profile, so at the
  // turnaround the two disagree in the last few decimal places.
  return turned ? Math.max(plan.storedLengthM, plan.hikedLengthM - alongM) : alongM;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
