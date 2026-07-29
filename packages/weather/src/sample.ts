/**
 * Choosing where along a trail to ask about the weather, and when you will be there.
 *
 * Two decisions live here, and both are what separate this from a trailhead forecast.
 *
 * **Where.** Evenly spaced points are not enough on their own. The high point is always
 * sampled, because it is the place where a forecast changes a decision — it is coldest,
 * windiest, most exposed, and the first to be above the freezing level. Losing it to an
 * unlucky spacing would defeat the feature on exactly the trails that need it.
 *
 * **When.** An out-and-back is not "the trail, twice". Descending the climb you just made
 * is materially faster, so the return leg is built as real geometry — the profile mirrored
 * back — and run through Tobler in its own right rather than having the outbound time
 * doubled. A five-hour ascent and a three-hour descent is the difference between finishing
 * comfortably before sunset and finishing in the dark, which is a flag this product raises.
 */

import type { ElevationPoint, RouteType, UnitSystem } from '@switchback/core';
import { formatDistance } from '@switchback/core';
import { cumulativeTimeS, highPointIndex, hikedProfile } from '@switchback/geo';

/** How many points a forecast samples. Eight is the shape of the strip in the UI. */
export const DEFAULT_SAMPLE_COUNT = 8;

export interface SamplePlan {
  /** Index into the journey this plan was built from. */
  index: number;
  distM: number;
  lng: number;
  lat: number;
  eleM: number;
  label: string;
  /** Cumulative moving seconds from the start. */
  elapsedS: number;
  /** Absolute arrival instant, epoch seconds. */
  arrivalS: number;
}

/**
 * The route as actually hiked, when the hiker asked for the return leg.
 *
 * The mirroring itself, and the question of whether the stored geometry is one leg or two,
 * both live in `hikedProfile` — the same function the section chart draws from, so a strip
 * that says "back at the car 14:05" and an axis that ends at 12.0 km are reading one
 * definition of the hike rather than two that agree by luck. All this adds is the hiker's
 * own choice: someone being collected at the far end is not walking back, whatever the
 * geometry says.
 */
export function buildJourney(
  profile: readonly ElevationPoint[],
  opts: { routeType: RouteType; includeReturn: boolean; lengthM: number },
): ElevationPoint[] {
  if (!opts.includeReturn) return profile.map((p) => ({ ...p }));
  return hikedProfile(profile, { routeType: opts.routeType, lengthM: opts.lengthM });
}

export interface SampleOptions {
  count?: number;
  unitSystem?: UnitSystem;
  paceFactor?: number;
  terrainFactor?: number;
  routeType?: RouteType;
}

/**
 * Pick the sample points and compute an arrival time for each.
 *
 * Returned sorted by position along the journey, which for a time-shifted forecast is also
 * chronological order — the strip reads left to right as the day does.
 */
export function planSamples(
  journey: readonly ElevationPoint[],
  startAtS: number,
  options: SampleOptions = {},
): SamplePlan[] {
  if (journey.length === 0) return [];

  const count = Math.max(2, options.count ?? DEFAULT_SAMPLE_COUNT);
  const unitSystem = options.unitSystem ?? 'metric';
  const routeType = options.routeType ?? 'point_to_point';

  const cumS = cumulativeTimeS(journey, {
    paceFactor: options.paceFactor ?? 1,
    terrainFactor: options.terrainFactor ?? 1,
  });

  const last = journey.length - 1;
  const high = highPointIndex(journey);

  // Start, finish and high point are non-negotiable; the rest fill in around them.
  const chosen = new Set<number>([0, last, high]);
  const totalM = journey[last]!.distM;
  for (let k = 1; k < count - 1 && chosen.size < count; k++) {
    chosen.add(nearestIndexAtDistance(journey, (k * totalM) / (count - 1)));
  }

  return [...chosen]
    .sort((a, b) => a - b)
    .map((index) => {
      const point = journey[index]!;
      const elapsedS = cumS[index]!;
      return {
        index,
        distM: point.distM,
        lng: point.lng,
        lat: point.lat,
        eleM: point.eleM,
        label: labelFor({ index, last, high, distM: point.distM, routeType, unitSystem }),
        elapsedS,
        arrivalS: Math.round(startAtS + elapsedS),
      };
    });
}

/**
 * Names, not coordinates.
 *
 * "Summit" is avoided in favour of "High point": we know the maximum of the elevation
 * profile, which on a valley hike is a slight rise beside a river. Calling that a summit
 * would be the interface overstating what it knows, and this is a product people make
 * safety decisions with.
 */
function labelFor(args: {
  index: number;
  last: number;
  high: number;
  distM: number;
  routeType: RouteType;
  unitSystem: UnitSystem;
}): string {
  if (args.index === 0) return 'Trailhead';
  if (args.index === args.last) {
    return args.routeType === 'point_to_point' ? 'Finish' : 'Back at the start';
  }
  if (args.index === args.high) return 'High point';
  return formatDistance(args.distM, args.unitSystem);
}

/** Nearest journey index to a target distance. Binary search; the profile is sorted. */
function nearestIndexAtDistance(journey: readonly ElevationPoint[], targetM: number): number {
  let lo = 0;
  let hi = journey.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (journey[mid]!.distM <= targetM) lo = mid;
    else hi = mid;
  }
  const loGap = Math.abs(journey[lo]!.distM - targetM);
  const hiGap = Math.abs(journey[hi]!.distM - targetM);
  return hiGap < loGap ? hi : lo;
}
