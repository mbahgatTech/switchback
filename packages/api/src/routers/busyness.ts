/**
 * Busy times. The model in `@switchback/busyness` is a pure function; this gathers its three
 * inputs — the trail's own signals, the starts our users recorded, and the week's weather.
 *
 * **Weather is allowed to fail**: a busyness curve without it is still a curve, so the outlook
 * is fetched inside a `try` and `weatherAdjusted: false` tells the client what it got.
 *
 * **The timezone is not hand-waved.** Hours in the response are local to the trail. When the
 * outlook answers it carries `utc_offset_seconds` from a proper timezone database, DST
 * included; when it does not, the offset is guessed from longitude and the `timezone` field
 * says `UTC+01:00` rather than naming a zone we did not look up.
 */

import { TRPCError } from '@trpc/server';
import { busynessForecast, type BusynessInput, type DayWeather } from '@switchback/busyness';
import { busynessRequestSchema } from '@switchback/core';
import type { BusynessForecast, BusynessRequest } from '@switchback/core';
import { ForecastCache, HOUR_S, OpenMeteoClient } from '@switchback/weather';
import type { DailyOutlook } from '@switchback/weather';
import { publicProcedure, router } from '../trpc';
import type { Context } from '../context';

/**
 * Module-level, so it survives between requests on a warm instance. An hour matches the
 * outlook's publishing cadence, and the observation buckets move far slower than that.
 */
const defaultCache = new ForecastCache<BusynessForecast>();

const trailSelect = {
  id: true,
  centroidLat: true,
  centroidLng: true,
  // The low point stands in for the trailhead: busyness is decided in a car park at breakfast,
  // so `maxEleM` would forecast the weather for a place nobody is standing.
  minEleM: true,
  estimatedTimeS: true,
  parkingCapacity: true,
  popularity: true,
  reviewCount: true,
  photoCount: true,
  busyness: {
    select: { dayOfWeek: true, hour: true, observed: true, sampleCount: true },
  },
} as const;

export interface BusynessDeps {
  cache?: ForecastCache<BusynessForecast>;
  client?: OpenMeteoClient;
  now?: () => number;
}

/**
 * The resolver, as a function — split out from the procedure so a test can hand it a stub
 * database and a stub Open-Meteo client, as the weather one is.
 */
export async function busynessFor(
  ctx: Pick<Context, 'db'>,
  input: BusynessRequest,
  deps: BusynessDeps = {},
): Promise<BusynessForecast> {
  const trail = await ctx.db.trail.findUnique({
    where: { id: input.trailId },
    select: trailSelect,
  });
  if (!trail) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such trail.' });

  const nowMs = deps.now?.() ?? Date.now();
  const cache = deps.cache ?? defaultCache;

  return cache.fetch(cacheKey(input, nowMs), async () => {
    const outlook = input.includeWeather
      ? await outlookFor(trail.centroidLat, trail.centroidLng, trail.minEleM, deps.client)
      : null;

    const request: BusynessInput = {
      trailId: trail.id,
      timezone: outlook?.timezone ?? offsetLabel(guessOffsetS(trail.centroidLng)),
      latDeg: trail.centroidLat,
      lngDeg: trail.centroidLng,
      utcOffsetS: outlook?.utcOffsetS ?? guessOffsetS(trail.centroidLng),
      nowMs,
      signals: {
        popularity: trail.popularity,
        reviewCount: trail.reviewCount,
        photoCount: trail.photoCount,
        parkingCapacity: trail.parkingCapacity,
      },
      // `modeled` is deliberately not read back: it is a cache of this same model from
      // whenever it last ran, and preferring it would pin every trail to whichever version of
      // the prior wrote that row.
      buckets: trail.busyness.map((bucket) => ({
        dayOfWeek: bucket.dayOfWeek,
        hour: bucket.hour,
        observed: bucket.observed,
        sampleCount: bucket.sampleCount,
      })),
      estimatedTimeS: trail.estimatedTimeS,
      weather: outlook ? weatherByDay(outlook) : null,
    };

    return busynessForecast(request);
  });
}

export const busynessRouter = router({
  /**
   * When to go, and how much of that is an estimate: a full week of hourly scores normalised
   * to this trail's own peak, one recommended slot with its reasoning, plus `confidence` and
   * `observationCount` so the interface can say what is measured and what is modelled.
   */
  forWeek: publicProcedure
    .input(busynessRequestSchema)
    .query(({ ctx, input }) => busynessFor(ctx, input)),
});

/**
 * The week's weather, folded down to one entry per weekday. A seven-day outlook covers each
 * weekday once, but the map is built forwards so the nearer day wins if the horizon ever grows.
 */
export function weatherByDay(outlook: DailyOutlook): Map<number, DayWeather> {
  const byDay = new Map<number, DayWeather>();
  for (const day of outlook.days) {
    if (byDay.has(day.dayOfWeek)) continue;
    byDay.set(day.dayOfWeek, {
      precipitationProbability: day.precipitationProbability,
      precipitationMm: day.precipitationMm,
      temperatureMaxC: day.temperatureMaxC,
      windGustsMaxKmh: day.windGustsMaxKmh,
    });
  }
  return byDay;
}

/**
 * The outlook, or nothing. Swallowing the error is the point: every failure mode here costs the
 * curve its weather adjustment and nothing else, and the response says so in `weatherAdjusted`.
 */
async function outlookFor(
  lat: number,
  lng: number,
  eleM: number,
  client: OpenMeteoClient | undefined,
): Promise<DailyOutlook | null> {
  try {
    return await (client ?? new OpenMeteoClient()).dailyOutlook({ lat, lng, eleM });
  } catch {
    return null;
  }
}

/**
 * Cache key, bucketed by wall-clock hour because the answer depends on the current hour even
 * though the request does not. `includeWeather` is in the key because it produces a materially
 * different curve, not just a different flag.
 */
export function cacheKey(input: BusynessRequest, nowMs: number): string {
  const hour = Math.floor(nowMs / 1000 / HOUR_S);
  return `${input.trailId}|${input.includeWeather ? 'weather' : 'bare'}|${hour}`;
}

/** Good to within an hour nearly everywhere, and never claimed to be more than that. */
export function guessOffsetS(lngDeg: number): number {
  const offsetS = Math.round(lngDeg / 15) * 3600;
  // A trail just west of Greenwich rounds to -0: equal to 0 everywhere it is compared, and
  // `-0` everywhere it is printed. Normalised once here rather than in every reader.
  return offsetS === 0 ? 0 : offsetS;
}

/** `UTC+01:00`. Truthful about being an offset rather than naming a zone we did not look up. */
export function offsetLabel(offsetS: number): string {
  if (offsetS === 0) return 'UTC';
  const sign = offsetS < 0 ? '-' : '+';
  const total = Math.abs(Math.round(offsetS / 60));
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const minutes = String(total % 60).padStart(2, '0');
  return `UTC${sign}${hours}:${minutes}`;
}
