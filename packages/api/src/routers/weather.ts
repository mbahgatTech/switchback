/**
 * Weather along the trail. Everything hard lives in `@switchback/weather` (and the design is in
 * `docs/architecture.md`); what happens here is the part that needs the database — find the
 * trail, hand over its real profile and terrain tags — plus an hour-long cache.
 *
 * The cache is here rather than inside the forecaster, which is a pure function of its input
 * and stays testable. It is also what keeps the free tier viable: between the one-hour TTL, the
 * single flight that collapses a thundering herd, and `dedupePoints`, a popular trail costs 24
 * upstream calls a day however many people look at it.
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
 * Module-level so it survives between requests on a warm instance. Each instance keeps its own
 * copy: a forecast is worthless after an hour, so a shared KV store would add a dependency and
 * a network hop to protect data with a sixty-minute shelf life.
 */
const defaultCache = new ForecastCache();

/**
 * Air quality gets its own two, sized for how they are asked. The grid is expensive and a
 * panning map hammers it, so it holds a few hundred viewports; point readings are cheap and
 * heavily shared (every trail in a 0.1° cell is one entry).
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
 * The resolver, as a function. Split out from the procedure so a test can hand it a stub
 * database and a stubbed Open-Meteo client, rather than testing tRPC's plumbing over a network.
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
    // Ingest writes the profile in a later step than the trail, so this is usually a trail
    // still being enriched. `NOT_FOUND` lets the client show "no forecast yet" and ask again,
    // which a 500 would not.
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
    // The same tags that set the trail's headline time estimate set its arrival times, so the
    // two never disagree on the page — and later means a different hour of the forecast.
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
 * The air over a viewport, one cell per model cell. Needs no database — the bbox is the whole
 * question — which is why it sits beside the forecast: what it shares with `alongRoute` is the
 * upstream service, the cache discipline and the error mapping, not a table.
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
   * The forecast for a hike, not for a car park: one sample per point along the route, each
   * read at that point's own predicted arrival hour and at its own altitude, plus the safety
   * flags derived from the set.
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
 * The cache key, plus the one thing `forecastCacheKey` cannot know: with no `startAt` the
 * forecaster picks the next 07:00 local to the trail, so the answer depends on the current hour
 * while the request does not. Bucketing those entries by wall-clock hour retires them exactly
 * when they stop being true.
 */
export function cacheKey(request: AlongRouteInput, nowMs: number): string {
  const key = forecastCacheKey(request);
  if (request.startAt) return key;
  return `${key}|now=${Math.floor(nowMs / 1000 / HOUR_S)}`;
}

/**
 * Whose units the flag messages are written in. Server-side because the flags are prose —
 * "gusts of 61 km/h at the High point" — and splitting a sentence into a number and a unit for
 * the client to reassemble produces worse English in both systems.
 */
export function unitsFor(units: string | null | undefined): UnitSystem {
  return units === 'imperial' ? 'imperial' : 'metric';
}

/**
 * Upstream's problem, said honestly: a weather service being slow or rate-limited is not an
 * internal error, and labelling it one costs the client the only thing it can act on. tRPC
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
 * The same mapping with a message about air rather than about a trail — an overlay failing with
 * "could not build a forecast for that trail" sends the reader looking for a broken trail that
 * does not exist. Both messages go through `deliberateServerError`, which is what keeps them
 * distinct across the wire; a blanket scrub of every 500 made this helper do nothing.
 */
export function asAirQualityError(error: unknown): TRPCError {
  const mapped = asTrpcError(error);
  if (mapped.code !== 'INTERNAL_SERVER_ERROR') return mapped;
  return deliberateServerError('Could not read air quality for that area.', error);
}
