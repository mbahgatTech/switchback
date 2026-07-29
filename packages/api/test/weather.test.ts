/**
 * The weather router: the seam between a trail row and a forecast.
 *
 * `@switchback/weather` is tested on its own and thoroughly. What is only testable here is
 * whether the *right* trail reaches it — the stored profile rather than an empty array, the
 * terrain factor its OSM tags imply, the signed-in user's units — and whether a failure
 * upstream is reported as something a client can act on. Those are the joins, and joins are
 * where this kind of feature actually breaks.
 */

import { TRPCError } from '@trpc/server';
import { describe, expect, it } from 'vitest';
import { OpenMeteoClient, OpenMeteoError, ForecastCache } from '@switchback/weather';
import type { AlongRouteRequest } from '@switchback/core';
import {
  alongRouteFor,
  asTrpcError,
  cacheKey,
  unitsFor,
  type WeatherDeps,
} from '../src/routers/weather';
import type { Context } from '../src/context';
import { NOW_MS, fakeUpstream, makeProfile, paramsOf } from '../../weather/test/fixtures';

type TrailRow = {
  id: string;
  routeType: 'loop' | 'out_and_back' | 'point_to_point';
  lengthM: number;
  surface: string | null;
  sacScale: string | null;
  profile: { points: unknown } | null;
};

/**
 * Just enough Prisma.
 *
 * The router calls exactly one method, so a stub is honest here in a way a full mock would
 * not be — and it lets a test say "this trail has no profile row" without a database.
 */
function stubCtx(trail: TrailRow | null, units?: 'metric' | 'imperial') {
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
    user: units ? { units } : null,
  } as unknown as Pick<Context, 'db' | 'user'>;
  return { ctx, calls };
}

const TRAIL: TrailRow = {
  id: 'trail-1',
  routeType: 'point_to_point',
  // The stored line is 2 km, and for a point-to-point that is also the published figure —
  // the two only diverge on an out-and-back mapped in one direction.
  lengthM: 2000,
  surface: null,
  sacScale: null,
  profile: { points: makeProfile() },
};

const REQUEST: AlongRouteRequest = { trailId: 'trail-1', paceFactor: 1, includeReturn: true };

/** A router run against a fake Open-Meteo and a cache of its own, so tests do not share one. */
function run(
  trail: TrailRow | null,
  overrides: Partial<AlongRouteRequest> = {},
  units?: 'metric' | 'imperial',
) {
  const upstream = fakeUpstream();
  const deps: WeatherDeps = {
    client: new OpenMeteoClient({
      fetchImpl: upstream.fetchImpl,
      sleepImpl: async () => {},
      maxAttempts: 1,
    }),
    now: () => NOW_MS,
    cache: new ForecastCache(),
  };
  const { ctx, calls } = stubCtx(trail, units);
  return {
    upstream,
    calls,
    deps,
    ctx,
    promise: alongRouteFor(ctx, { ...REQUEST, ...overrides }, deps),
  };
}

describe('alongRouteFor', () => {
  it('forecasts the trail’s own stored profile', async () => {
    const { upstream, promise } = run(TRAIL);
    const forecast = await promise;

    expect(forecast.trailId).toBe('trail-1');
    expect(forecast.samples).toHaveLength(8);
    // The profile spans 100–900 m, so these are our elevations rather than a model cell's.
    const elevations = paramsOf(upstream.forecastCalls[0]!)
      .get('elevation')!
      .split(',')
      .map(Number);
    expect(Math.min(...elevations)).toBe(100);
    expect(Math.max(...elevations)).toBe(900);
  });

  it('reads the trail by id and asks for nothing it does not use', async () => {
    const { calls, promise } = run(TRAIL);
    await promise;

    const args = calls[0] as { where: { id: string }; select: Record<string, unknown> };
    expect(args.where).toEqual({ id: 'trail-1' });
    // No `geom`, no `description`, no `searchVector` — the profile column is already the
    // largest thing this query moves.
    expect(Object.keys(args.select).sort()).toEqual([
      'id',
      'lengthM',
      'profile',
      'routeType',
      'sacScale',
      'surface',
    ]);
  });

  it('lets terrain slow the hike down, which moves every arrival hour', async () => {
    const fast = await run(TRAIL).promise;
    const slow = await run({ ...TRAIL, sacScale: 'difficult_alpine_hiking', surface: 'scree' })
      .promise;

    const lastOf = (f: Awaited<typeof fast>) => f.samples[f.samples.length - 1]!;
    expect(lastOf(slow).elapsedS).toBeGreaterThan(lastOf(fast).elapsedS);
    // Not merely a different number: a different hour, which is a different forecast row.
    expect(lastOf(slow).arrivalAt).not.toBe(lastOf(fast).arrivalAt);
  });

  it('hikes an out-and-back back to the car', async () => {
    // 2 km of stored line under a published 4 km — a spur mapped once, uphill, which is
    // what ingest writes for most out-and-backs. The forecast has to cover the walk down.
    const forecast = await run({ ...TRAIL, routeType: 'out_and_back', lengthM: 4000 }).promise;
    expect(forecast.samples[7]!.label).toBe('Back at the start');
    expect(forecast.samples[7]!.distM).toBeCloseTo(4000, 0);
  });

  it('leaves an out-and-back whose stored line already retraces itself', async () => {
    // Same route type, but the published length agrees with the geometry: both legs are
    // already in the profile, and mirroring would forecast a walk twice as long as the one
    // the reader is doing.
    const forecast = await run({ ...TRAIL, routeType: 'out_and_back', lengthM: 2000 }).promise;
    expect(forecast.samples[7]!.distM).toBeCloseTo(2000, 0);
  });

  it('honours includeReturn: false on an out-and-back', async () => {
    const forecast = await run(
      { ...TRAIL, routeType: 'out_and_back', lengthM: 4000 },
      { includeReturn: false },
    ).promise;
    expect(forecast.samples[7]!.distM).toBeCloseTo(2000, 0);
  });

  it('writes the flags in the signed-in user’s units', async () => {
    const gusty = fakeUpstream({ gustsKmh: 90 });
    const deps: WeatherDeps = {
      client: new OpenMeteoClient({
        fetchImpl: gusty.fetchImpl,
        sleepImpl: async () => {},
        maxAttempts: 1,
      }),
      now: () => NOW_MS,
      cache: new ForecastCache(),
    };
    const { ctx } = stubCtx(TRAIL, 'imperial');
    const forecast = await alongRouteFor(ctx, REQUEST, deps);

    const wind = forecast.flags.find((f) => f.kind === 'severe_wind')!;
    expect(wind.message).toContain('mph');
    expect(wind.message).not.toContain('km/h');
  });

  it('serves a second identical request from the cache', async () => {
    const upstream = fakeUpstream();
    const deps: WeatherDeps = {
      client: new OpenMeteoClient({
        fetchImpl: upstream.fetchImpl,
        sleepImpl: async () => {},
        maxAttempts: 1,
      }),
      now: () => NOW_MS,
      cache: new ForecastCache(),
    };
    const { ctx } = stubCtx(TRAIL);

    const first = await alongRouteFor(ctx, REQUEST, deps);
    const second = await alongRouteFor(ctx, REQUEST, deps);

    expect(second).toBe(first);
    expect(upstream.forecastCalls).toHaveLength(1);
  });

  it('does not serve one user’s units to another', async () => {
    // Same trail, same hour, different reader. The flags are prose, so this is a different
    // answer and must not be a cache hit.
    const upstream = fakeUpstream({ gustsKmh: 90 });
    const cache = new ForecastCache();
    const deps: WeatherDeps = {
      client: new OpenMeteoClient({
        fetchImpl: upstream.fetchImpl,
        sleepImpl: async () => {},
        maxAttempts: 1,
      }),
      now: () => NOW_MS,
      cache,
    };

    const metric = await alongRouteFor(stubCtx(TRAIL, 'metric').ctx, REQUEST, deps);
    const imperial = await alongRouteFor(stubCtx(TRAIL, 'imperial').ctx, REQUEST, deps);

    expect(metric.flags[0]!.message).toContain('km/h');
    expect(imperial.flags[0]!.message).toContain('mph');
  });

  it('404s an unknown trail', async () => {
    await expect(run(null).promise).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('404s a trail whose profile has not been derived yet', async () => {
    // A real state, not a hypothetical: ingest commits the trail before it elevates it.
    await expect(run({ ...TRAIL, profile: null }).promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(run({ ...TRAIL, profile: { points: [] } }).promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      run({ ...TRAIL, profile: { points: 'not a profile' } }).promise,
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports an upstream outage as an outage', async () => {
    const down = (async () =>
      new Response('{"reason":"busy"}', { status: 503 })) as unknown as typeof fetch;
    const { ctx } = stubCtx(TRAIL);
    const promise = alongRouteFor(ctx, REQUEST, {
      client: new OpenMeteoClient({ fetchImpl: down, sleepImpl: async () => {}, maxAttempts: 1 }),
      now: () => NOW_MS,
      cache: new ForecastCache(),
    });

    await expect(promise).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });
});

describe('cacheKey', () => {
  const request = { trailId: 't1', profile: [], routeType: 'loop', lengthM: 0 } as const;

  it('expires an unspecified start when the hour it defaulted to has passed', () => {
    // The bug this exists to prevent: a forecast computed at 06:50 for "today at 07:00",
    // still being served at 07:30 — an hour inside the TTL, and describing a start that has
    // already gone.
    const at = (hour: number) => cacheKey({ ...request }, Date.UTC(2026, 6, 21, hour, 50));
    expect(at(6)).toBe(cacheKey({ ...request }, Date.UTC(2026, 6, 21, 6, 10)));
    expect(at(6)).not.toBe(at(7));
  });

  it('leaves an explicit start alone — it means the same thing at any hour', () => {
    const startAt = '2026-07-21T07:00:00+01:00';
    const a = cacheKey({ ...request, startAt }, Date.UTC(2026, 6, 20, 6, 0));
    const b = cacheKey({ ...request, startAt }, Date.UTC(2026, 6, 20, 19, 0));
    expect(a).toBe(b);
  });
});

describe('unitsFor', () => {
  it('defaults to metric for a signed-out reader', () => {
    expect(unitsFor(undefined)).toBe('metric');
    expect(unitsFor(null)).toBe('metric');
    expect(unitsFor('metric')).toBe('metric');
    expect(unitsFor('imperial')).toBe('imperial');
  });
});

describe('asTrpcError', () => {
  it('passes our own errors through untouched', () => {
    const original = new TRPCError({ code: 'NOT_FOUND' });
    expect(asTrpcError(original)).toBe(original);
  });

  it('names an upstream failure retryable, and an unknown one not', () => {
    expect(asTrpcError(new OpenMeteoError('429', 429)).code).toBe('SERVICE_UNAVAILABLE');

    const timeout = new Error('the operation was aborted');
    timeout.name = 'TimeoutError';
    expect(asTrpcError(timeout).code).toBe('TIMEOUT');

    expect(asTrpcError(new Error('cannot read properties of undefined')).code).toBe(
      'INTERNAL_SERVER_ERROR',
    );
  });

  it('keeps the original error as the cause, so it reaches the logs', () => {
    const upstream = new OpenMeteoError('Open-Meteo 503: busy', 503);
    expect(asTrpcError(upstream).cause).toBe(upstream);
  });
});
