/**
 * The busyness router: the seam between a trail row and a weekly curve.
 *
 * The model itself is tested exhaustively in `@switchback/busyness` and needs no database
 * or network to do it. What is only testable here is the gathering — that the trail's own
 * signals and its recorded starts actually reach the model, that the week's weather is
 * folded in when asked for and *not* when it is not, and that a weather service having a
 * bad afternoon costs the response its adjustment rather than its existence.
 *
 * That last one is the reason this file exists. Busyness is not a weather feature, and the
 * failure mode worth guarding is a trail page returning 503 because a secondary call to
 * Open-Meteo timed out.
 */

import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import {
  busynessForecastSchema,
  type BusynessForecast,
  type BusynessRequest,
} from '@switchback/core';
import { ForecastCache, OpenMeteoClient } from '@switchback/weather';
import type { DailyOutlook } from '@switchback/weather';
import {
  busynessFor,
  cacheKey,
  guessOffsetS,
  offsetLabel,
  weatherByDay,
  type BusynessDeps,
} from '../src/routers/busyness';
import type { Context } from '../src/context';
import { NOW_MS, TZ, fakeUpstream, paramsOf } from '../../weather/test/fixtures';

interface Bucket {
  dayOfWeek: number;
  hour: number;
  observed: number;
  sampleCount: number;
}

interface TrailRow {
  id: string;
  centroidLat: number;
  centroidLng: number;
  minEleM: number;
  estimatedTimeS: number;
  parkingCapacity: number | null;
  popularity: number;
  reviewCount: number;
  photoCount: number;
  busyness: Bucket[];
}

const TRAIL: TrailRow = {
  id: 'trail-1',
  centroidLat: 56.7969,
  centroidLng: -5.0036,
  minEleM: 20,
  estimatedTimeS: 6 * 3600,
  parkingCapacity: null,
  popularity: 900,
  reviewCount: 40,
  photoCount: 25,
  busyness: [],
};

const REQUEST: BusynessRequest = { trailId: 'trail-1', includeWeather: true };

function stubCtx(trail: TrailRow | null) {
  const calls: unknown[] = [];
  const ctx = {
    db: {
      trail: {
        findUnique: async (args: unknown) => {
          calls.push(args);
          return trail;
        },
      },
    },
  } as unknown as Pick<Context, 'db'>;
  return { ctx, calls };
}

interface RunOptions {
  soakedDayOfWeek?: number;
  /** Make every upstream call fail, as a rate limit or an outage would. */
  breakUpstream?: boolean;
}

function run(
  trail: TrailRow | null,
  overrides: Partial<BusynessRequest> = {},
  options: RunOptions = {},
) {
  const upstream = fakeUpstream(
    options.soakedDayOfWeek === undefined ? {} : { soakedDayOfWeek: options.soakedDayOfWeek },
  );
  const fetchImpl = options.breakUpstream
    ? ((async () => {
        throw new Error('upstream is down');
      }) as unknown as typeof fetch)
    : upstream.fetchImpl;

  const deps: BusynessDeps = {
    client: new OpenMeteoClient({ fetchImpl, sleepImpl: async () => {}, maxAttempts: 1 }),
    now: () => NOW_MS,
    cache: new ForecastCache<BusynessForecast>(),
  };
  const { ctx, calls } = stubCtx(trail);
  const request = { ...REQUEST, ...overrides };

  return {
    upstream,
    calls,
    deps,
    ctx,
    promise: busynessFor(ctx, request, deps),
    again: () => busynessFor(ctx, request, deps),
  };
}

function peakOf(forecast: BusynessForecast, dayOfWeek: number): number {
  return Math.max(...forecast.week[dayOfWeek]!.hours.map((h) => h.score));
}

describe('busynessFor', () => {
  it('returns a forecast that satisfies the published contract', async () => {
    const forecast = await run(TRAIL).promise;
    expect(() => busynessForecastSchema.parse(forecast)).not.toThrow();
    expect(forecast.trailId).toBe('trail-1');
    expect(forecast.week).toHaveLength(7);
  });

  it('reads the trail by id and asks for nothing it does not use', async () => {
    const { calls, promise } = run(TRAIL);
    await promise;

    const args = calls[0] as { where: { id: string }; select: Record<string, unknown> };
    expect(args.where).toEqual({ id: 'trail-1' });
    // No geometry, no description, no elevation profile. This query runs on a trail page
    // that has already loaded all of that once.
    expect(Object.keys(args.select).sort()).toEqual([
      'busyness',
      'centroidLat',
      'centroidLng',
      'estimatedTimeS',
      'id',
      'minEleM',
      'parkingCapacity',
      'photoCount',
      'popularity',
      'reviewCount',
    ]);
  });

  it('asks upstream about the trailhead, at the trailhead’s own elevation', async () => {
    const { upstream, promise } = run(TRAIL);
    await promise;

    const params = paramsOf(upstream.forecastCalls[0]!);
    expect(params.get('latitude')).toBe('56.7969');
    expect(params.get('elevation')).toBe('20');
    // One coordinate, and daily aggregates only: busyness is a property of the trail, not
    // of a point on it, and an hourly series here would be seven times the payload unused.
    expect(params.get('hourly')).toBeNull();
    expect(params.get('daily')).toContain('precipitation_probability_max');
  });

  it('folds the week’s weather in, and says that it did', async () => {
    const forecast = await run(TRAIL, {}, { soakedDayOfWeek: 6 }).promise;
    expect(forecast.weatherAdjusted).toBe(true);
    expect(forecast.timezone).toBe(TZ);
  });

  it('lets a washed-out Saturday hand the week to Sunday', async () => {
    // The proof that the outlook actually reaches the model rather than merely being
    // fetched: Saturday outscores Sunday on every dry week this trail will ever have.
    const dry = await run(TRAIL).promise;
    const wet = await run(TRAIL, {}, { soakedDayOfWeek: 6 }).promise;

    expect(peakOf(dry, 6)).toBeGreaterThan(peakOf(dry, 0));
    expect(peakOf(wet, 6)).toBeLessThan(peakOf(wet, 0));
    expect(wet.recommendation!.dayOfWeek).not.toBe(6);
  });

  it('skips the call entirely when the caller does not want weather', async () => {
    const { upstream, promise } = run(TRAIL, { includeWeather: false });
    const forecast = await promise;

    expect(upstream.calls).toHaveLength(0);
    expect(forecast.weatherAdjusted).toBe(false);
    // No upstream means no timezone database, and saying `Europe/London` would be a guess
    // dressed as a lookup. An offset is what we actually know.
    expect(forecast.timezone).toBe('UTC');
  });

  it('degrades to a modelled curve when the forecast service is down', async () => {
    const forecast = await run(TRAIL, {}, { breakUpstream: true }).promise;

    expect(() => busynessForecastSchema.parse(forecast)).not.toThrow();
    expect(forecast.weatherAdjusted).toBe(false);
    expect(forecast.week[6]!.hours.some((h) => h.score > 0)).toBe(true);
  });

  it('carries recorded starts through to the confidence the UI shows', async () => {
    const busyness: Bucket[] = [
      { dayOfWeek: 6, hour: 9, observed: 30, sampleCount: 150 },
      { dayOfWeek: 0, hour: 10, observed: 20, sampleCount: 95 },
    ];
    const forecast = await run({ ...TRAIL, busyness }).promise;

    expect(forecast.observationCount).toBe(245);
    expect(forecast.confidence).toBe('high');
  });

  it('says modelled when nobody has recorded anything', async () => {
    const forecast = await run(TRAIL).promise;
    expect(forecast.observationCount).toBe(0);
    expect(forecast.confidence).toBe('modeled');
  });

  it('makes an absolute crowding claim only when there is evidence for one', async () => {
    const known = await run(TRAIL).promise;
    const unknown = await run({
      ...TRAIL,
      popularity: 0,
      reviewCount: 0,
      photoCount: 0,
    }).promise;

    expect(known.peakLevel).not.toBeNull();
    expect(unknown.peakLevel).toBeNull();
  });

  it('serves a second reader from cache rather than upstream', async () => {
    const { upstream, again, promise } = run(TRAIL);
    await promise;
    await again();
    expect(upstream.forecastCalls).toHaveLength(1);
  });

  it('is a 404, not a 500, for a trail that does not exist', async () => {
    await expect(run(null).promise).rejects.toBeInstanceOf(TRPCError);
    await expect(run(null).promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('cacheKey', () => {
  it('separates the weather-adjusted curve from the bare one', () => {
    const withWeather = cacheKey({ trailId: 't', includeWeather: true }, NOW_MS);
    const without = cacheKey({ trailId: 't', includeWeather: false }, NOW_MS);
    expect(withWeather).not.toBe(without);
  });

  it('retires an entry when the hour it was computed in ends', () => {
    const now = cacheKey(REQUEST, NOW_MS);
    expect(cacheKey(REQUEST, NOW_MS + 59 * 60_000)).toBe(now);
    expect(cacheKey(REQUEST, NOW_MS + 61 * 60_000)).not.toBe(now);
  });
});

describe('weatherByDay', () => {
  const outlook = (days: DailyOutlook['days']): DailyOutlook => ({
    timezone: TZ,
    utcOffsetS: 3600,
    days,
  });

  it('maps the fields the model asks for and drops the ones it does not', () => {
    const byDay = weatherByDay(
      outlook([
        {
          timeS: 0,
          dayOfWeek: 3,
          weatherCode: 61,
          temperatureMaxC: 14,
          temperatureMinC: 6,
          precipitationMm: 3,
          precipitationProbability: 70,
          windGustsMaxKmh: 44,
        },
      ]),
    );

    expect(byDay.get(3)).toEqual({
      precipitationProbability: 70,
      precipitationMm: 3,
      temperatureMaxC: 14,
      windGustsMaxKmh: 44,
    });
    expect(byDay.size).toBe(1);
  });

  it('keeps the nearer day when a horizon ever covers a weekday twice', () => {
    const day = (dayOfWeek: number, probability: number) => ({
      timeS: 0,
      dayOfWeek,
      weatherCode: null,
      temperatureMaxC: null,
      temperatureMinC: null,
      precipitationMm: null,
      precipitationProbability: probability,
      windGustsMaxKmh: null,
    });
    const byDay = weatherByDay(outlook([day(2, 10), day(2, 90)]));
    expect(byDay.get(2)!.precipitationProbability).toBe(10);
  });
});

describe('offsetLabel', () => {
  it('names an offset without pretending to name a zone', () => {
    expect(offsetLabel(0)).toBe('UTC');
    expect(offsetLabel(3600)).toBe('UTC+01:00');
    expect(offsetLabel(-8 * 3600)).toBe('UTC-08:00');
    // Nepal, Chatham Islands, and the reason this is not integer hours.
    expect(offsetLabel(5.75 * 3600)).toBe('UTC+05:45');
  });

  it('guesses a longitude’s offset to the nearest hour', () => {
    expect(guessOffsetS(-5.0036)).toBe(0);
    expect(guessOffsetS(-120)).toBe(-8 * 3600);
    expect(guessOffsetS(151.2)).toBe(10 * 3600);
  });
});
