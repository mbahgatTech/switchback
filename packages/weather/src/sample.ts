/**
 * Choosing where along a trail to ask about the weather, and when you will be there.
 *
 * The high point is always sampled, whatever the spacing: it is the coldest, windiest, most
 * exposed place and the first above the freezing level. An out-and-back's return leg is built
 * as real geometry (the profile mirrored) and run through Tobler in its own right, because
 * descending a climb is materially faster than making it — doubling the outbound time is the
 * difference between finishing before sunset and finishing in the dark.
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
 * The route as actually hiked, when the hiker asked for the return leg. The mirroring and the
 * question of whether stored geometry is one leg or two both live in `hikedProfile` — the same
 * function the section chart draws from, so the strip and the axis share one definition of the
 * hike. All this adds is the hiker's own choice.
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
 * Pick the sample points and compute an arrival time for each. Sorted by position along the
 * journey, which for a time-shifted forecast is also chronological order.
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
 * Names, not coordinates. "High point" rather than "Summit": we know the maximum of the
 * elevation profile, which on a valley hike is a rise beside a river, and this is a product
 * people make safety decisions with.
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
