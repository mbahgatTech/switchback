/**
 * Weather along the trail.
 *
 * One procedure, and it is the one this product is built around. Everything hard about it
 * lives in `@switchback/weather`; what happens here is the part that needs the database:
 * find the trail, hand over its real elevation profile and its terrain tags, and put an
 * hour-long cache in front of the result.
 *
 * **Why the cache is here rather than inside the forecaster.** The forecaster is a pure
 * function of its input, which is what makes it testable. Caching is a deployment concern —
 * how many instances there are, how long a forecast stays true, what a cold trail costs.
 * That belongs at the edge of the system, where the request arrives.
 *
 * The economics matter and are the reason this is not naive. Open-Meteo's free tier allows
 * 10,000 calls a day; a trail page that fetched on every view would spend that on a few
 * hundred visitors. Between the one-hour TTL, the single flight that collapses a thundering
 * herd into one upstream call, and `dedupePoints` folding an out-and-back's retraced ground
 * back down to its distinct coordinates, a popular trail costs 24 calls a day no matter how
 * many people look at it.
 */

import { TRPCError } from '@trpc/server';
import {
  airQualityAtRequestSchema,
  airQualityGridRequestSchema,
  alongRouteRequestSchema,
} from '@switchback/core';
import type {
  AirQualityGrid,
  AirQualityReading,
  AlongRouteForecast,
  AlongRouteRequest,
  UnitSystem,
} from '@switchback/core';
import { terrainFactorFor } from '@switchback/geo';
import {
  ForecastCache,
  HOUR_S,
  OpenMeteoError,
  airQualityAt,
  airQualityGrid,
  airQualityGridKey,
  airQualityPointKey,
  alongRouteForecast,
  forecastCacheKey,
} from '@switchback/weather';
import type { AirQualityDeps, AlongRouteDeps, AlongRouteInput } from '@switchback/weather';
import { readProfile } from '../profiles';
import { deliberateServerError, publicProcedure, router } from '../trpc';
import type { Context } from '../context';

/**
 * Module-level on purpose, so it survives between requests on a warm instance.
 *
 * On Vercel each instance keeps its own copy and a cold start begins empty, which is the
 * right trade: a forecast is worthless after an hour, so a shared KV store would add a
 * dependency and a network hop to protect data with a sixty-minute shelf life.
 */
const defaultCache = new ForecastCache();

/**
 * Air quality gets its own two, sized for how they are asked.
 *
 * The grid is the expensive one and the one a panning map hammers, so it is given room for
 * a few hundred viewports — a reader sweeping a range and coming back should not pay twice
 * for the same ground. Point readings are cheap and heavily shared (every trail in a 0.1°
 * cell is one entry), so a smaller table covers a great many trails.
 */
const defaultGridCache = new ForecastCache<AirQualityGrid>({ maxEntries: 300 });
const defaultPointCache = new ForecastCache<AirQualityReading>({ maxEntries: 500 });

const trailSelect = {
  id: true,
  routeType: true,
  lengthM: true,
  surface: true,
  sacScale: true,
  profile: { select: { points: true } },
} as const;

export interface WeatherDeps extends AlongRouteDeps {
  cache?: ForecastCache;
}

/**
 * The resolver, as a function.
 *
 * Split out from the procedure so a test can hand it a stub database and a stubbed
 * Open-Meteo client. Going through `createCaller` instead would test tRPC's plumbing and
 * leave the only interesting part — that the right profile, terrain factor and units reach
 * the forecaster — reachable only over a real network.
 */
export async function alongRouteFor(
  ctx: Pick<Context, 'db' | 'user'>,
  input: AlongRouteRequest,
  deps: WeatherDeps = {},
): Promise<AlongRouteForecast> {
  const trail = await ctx.db.trail.findUnique({
    where: { id: input.trailId },
    select: trailSelect,
  });
  if (!trail) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such trail.' });

  const profile = readProfile(trail.profile?.points);
  if (profile.length < 2) {
    // Ingest writes the profile in a later step than the trail itself, so this is usually a
    // trail that has not finished being enriched rather than a broken one. The client shows
    // that as "no forecast yet" and asks again later, which a 500 would not let it do.
    throw new TRPCError({
      code: 'NOT_FOUND',
      message: 'That trail has no elevation profile yet, so there is nothing to time-shift.',
    });
  }

  const request: AlongRouteInput = {
    trailId: trail.id,
    profile,
    routeType: trail.routeType,
    lengthM: trail.lengthM,
    startAt: input.startAt,
    paceFactor: input.paceFactor,
    includeReturn: input.includeReturn,
    // Rock and scree are slower than a graded path, slower means later, and later is a
    // different hour of the forecast. The same tags that set the trail's headline time
    // estimate set its arrival times, so the two never disagree on the page.
    terrainFactor: terrainFactorFor({ sacScale: trail.sacScale, surface: trail.surface }),
    unitSystem: unitsFor(ctx.user?.units),
  };

  const cache = deps.cache ?? defaultCache;
  const nowMs = deps.now?.() ?? Date.now();

  try {
    return await cache.fetch(cacheKey(request, nowMs), () =>
      alongRouteForecast(request, { client: deps.client, now: deps.now }),
    );
  } catch (error) {
    throw asTrpcError(error);
  }
}

export interface AirQualityRouterDeps extends AirQualityDeps {
  gridCache?: ForecastCache<AirQualityGrid>;
  pointCache?: ForecastCache<AirQualityReading>;
}

/**
 * The air over a viewport, one cell per model cell.
 *
 * Needs no database at all — the bbox is the whole question — which is why it sits beside
 * the forecast rather than inside the trails router: what it shares with `alongRoute` is
 * the upstream service, the cache discipline and the error mapping, not a table.
 */
export async function airQualityGridFor(
  input: { bbox: [number, number, number, number] },
  deps: AirQualityRouterDeps = {},
): Promise<AirQualityGrid> {
  const cache = deps.gridCache ?? defaultGridCache;
  const nowMs = deps.now?.() ?? Date.now();
  try {
    return await cache.fetch(airQualityGridKey(input.bbox, nowMs), () =>
      airQualityGrid(input.bbox, { client: deps.client, now: deps.now }),
    );
  } catch (error) {
    throw asAirQualityError(error);
  }
}

/** One point's air, with the pollutant driving it named. */
export async function airQualityAtFor(
  input: { lng: number; lat: number },
  deps: AirQualityRouterDeps = {},
): Promise<AirQualityReading> {
  const cache = deps.pointCache ?? defaultPointCache;
  const nowMs = deps.now?.() ?? Date.now();
  try {
    return await cache.fetch(airQualityPointKey(input.lng, input.lat, nowMs), () =>
      airQualityAt(input.lng, input.lat, { client: deps.client, now: deps.now }),
    );
  } catch (error) {
    throw asAirQualityError(error);
  }
}

export const weatherRouter = router({
  /**
   * The forecast for a hike, not for a car park.
   *
   * Returns one sample per point along the route — eight of them — each read at that
   * point's own predicted arrival hour and at its own altitude, plus the safety flags
   * derived from the set.
   */
  alongRoute: publicProcedure
    .input(alongRouteRequestSchema)
    .query(({ ctx, input }) => alongRouteFor(ctx, input)),

  /** The European AQI across a viewport, as a lattice of model cells. */
  airQualityGrid: publicProcedure
    .input(airQualityGridRequestSchema)
    .query(({ input }) => airQualityGridFor(input)),

  /** The European AQI at one point — a trail's centroid, usually. */
  airQualityAt: publicProcedure
    .input(airQualityAtRequestSchema)
    .query(({ input }) => airQualityAtFor(input)),
});

/**
 * The cache key, plus the one thing `forecastCacheKey` cannot know.
 *
 * When the caller names no start time the forecaster picks the next 07:00 local to the
 * trail, so the *answer* depends on the current hour while the *request* does not. Left
 * alone, a forecast computed at 06:50 for "today at 07:00" would still be served at 07:30,
 * by which time it describes a start that has been and gone. Bucketing those entries by
 * wall-clock hour retires them exactly when they stop being true.
 */
export function cacheKey(request: AlongRouteInput, nowMs: number): string {
  const key = forecastCacheKey(request);
  if (request.startAt) return key;
  return `${key}|now=${Math.floor(nowMs / 1000 / HOUR_S)}`;
}

/**
 * Whose units the flag messages are written in.
 *
 * Server-side because the flags are prose — "gusts of 61 km/h at the High point" — and
 * splitting a sentence into a number and a unit for the client to reassemble produces worse
 * English in both systems. The cache key carries the unit system for the same reason.
 */
export function unitsFor(units: string | null | undefined): UnitSystem {
  return units === 'imperial' ? 'imperial' : 'metric';
}

/**
 * Upstream's problem, said honestly.
 *
 * A weather service being slow or rate-limited is not an internal error, and labelling it
 * one costs the client the only thing it can act on: whether retrying is worth it. tRPC
 * counts both `SERVICE_UNAVAILABLE` and `TIMEOUT` among the codes worth retrying.
 */
export function asTrpcError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;

  if (error instanceof OpenMeteoError) {
    return new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'The forecast service is not answering right now. Try again in a moment.',
      cause: error,
    });
  }

  // `AbortSignal.timeout` rejects with a DOMException — an Error, but not one of ours.
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new TRPCError({
      code: 'TIMEOUT',
      message: 'The forecast service took too long to answer.',
      cause: error,
    });
  }

  return deliberateServerError('Could not build a forecast for that trail.', error);
}

/**
 * The same mapping, with a message about air rather than about a trail.
 *
 * Worth the four lines: an overlay that fails saying "could not build a forecast for that
 * trail" sends the reader looking for a broken trail that does not exist. The retryable
 * codes — which is the part the client acts on — are identical.
 *
 * Both messages are built by `deliberateServerError`, which is what keeps that true across
 * the wire. Under a blanket scrub of every 500 the two came out identical and this helper did
 * nothing at all — invisibly, because the test below asserts on the `TRPCError` and the
 * replacement happened at serialisation.
 */
export function asAirQualityError(error: unknown): TRPCError {
  const mapped = asTrpcError(error);
  if (mapped.code !== 'INTERNAL_SERVER_ERROR') return mapped;
  return deliberateServerError('Could not read air quality for that area.', error);
}
