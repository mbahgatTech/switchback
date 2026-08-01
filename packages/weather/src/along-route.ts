/**
 * Along-trail, time-shifted weather: sample the route, ask the forecast about each sample at
 * *its own* predicted arrival hour, and say what that means.
 *
 *     Trailhead  07:00 · 11 °C, calm
 *     High point 11:20 ·  1 °C, gusts 61 km/h, 30% rain
 *     Back       14:05 ·  9 °C
 *
 * Three moving parts: `buildJourney` (the route as actually hiked, return leg included),
 * `cumulativeTimeS` from @switchback/geo (when you reach each point), and Open-Meteo's
 * multi-location request with our own DEM elevations. One upstream call per forecast, plus one
 * for air quality, which is allowed to fail.
 */

import type {
  AlongRouteForecast,
  ElevationPoint,
  RouteType,
  UnitSystem,
  WeatherSample,
} from '@switchback/core';
import { alongRouteForecastSchema } from '@switchback/core';
import { deriveFlags } from './flags';
import {
  OpenMeteoClient,
  type AirQualitySeries,
  type ForecastPoint,
  type LocationForecast,
} from './open-meteo';
import { buildJourney, planSamples, type SamplePlan } from './sample';
import {
  dayIndexFor,
  defaultStartEpochS,
  epochSecondsFrom,
  hourIndexFor,
  isoWithOffset,
} from './time';

export interface AlongRouteInput {
  trailId: string;
  /** Resampled elevation points for the trail, ascending by `distM`. */
  profile: readonly ElevationPoint[];
  routeType: RouteType;
  /**
   * The trail's published length — the round trip, where the hike is one. Compared against the
   * profile's own extent to tell an implied return leg from one already drawn; see `hikedProfile`.
   */
  lengthM: number;
  /** ISO 8601 with offset. Defaults to the next 07:00 local to the trail. */
  startAt?: string | undefined;
  paceFactor?: number;
  includeReturn?: boolean;
  /** From `terrainFactorFor` in @switchback/geo — surface and sac_scale. */
  terrainFactor?: number;
  unitSystem?: UnitSystem;
  sampleCount?: number;
  includeAirQuality?: boolean;
}

export interface AlongRouteDeps {
  client?: OpenMeteoClient;
  /** Epoch milliseconds. Injected so tests are not a function of the wall clock. */
  now?: () => number;
}

export async function alongRouteForecast(
  input: AlongRouteInput,
  deps: AlongRouteDeps = {},
): Promise<AlongRouteForecast> {
  const client = deps.client ?? new OpenMeteoClient();
  const nowS = Math.floor((deps.now?.() ?? Date.now()) / 1000);
  const unitSystem = input.unitSystem ?? 'metric';
  const paceFactor = input.paceFactor ?? 1;
  const includeReturn = input.includeReturn ?? true;

  const journey = buildJourney(input.profile, {
    routeType: input.routeType,
    includeReturn,
    lengthM: input.lengthM,
  });
  if (journey.length === 0) {
    throw new Error(`Trail ${input.trailId} has no elevation profile to forecast against.`);
  }

  const planOptions = {
    count: input.sampleCount,
    unitSystem,
    paceFactor,
    terrainFactor: input.terrainFactor,
    routeType: input.routeType,
  };

  // Two passes over the same pure function: sample *positions* do not depend on the start time,
  // but the default start time depends on the trail's UTC offset, which only the response knows.
  // Plan to learn where to ask, ask, then re-plan with the real start. No second network call —
  // the first request already returned a week of hours.
  const provisional = planSamples(journey, nowS, planOptions);
  const points = provisional.map((s) => ({ lat: s.lat, lng: s.lng, eleM: s.eleM }));
  const { unique, indexOf } = dedupePoints(points);

  const [locations, airQuality] = await Promise.all([
    client.forecast(unique),
    input.includeAirQuality === false
      ? Promise.resolve<AirQualitySeries[]>([])
      : client.airQuality(unique).catch(() => [] as AirQualitySeries[]),
  ]);

  const first = locations[0];
  if (!first) throw new Error('Open-Meteo returned no locations for this trail.');

  const utcOffsetS = first.utcOffsetS;
  const requestedStartS = input.startAt ? epochSecondsFrom(input.startAt) : null;
  const startAtS = requestedStartS ?? defaultStartEpochS(nowS, utcOffsetS);

  const plans = planSamples(journey, startAtS, planOptions);
  const samples = plans.map((plan, i) =>
    toSample(plan, locations[indexOf[i] ?? 0] ?? first, utcOffsetS),
  );

  const aqi = plans.map((plan, i) => {
    const series = airQuality[indexOf[i] ?? 0];
    if (!series) return null;
    const hour = hourIndexFor(series.timeS, plan.arrivalS);
    return hour === null ? null : (series.europeanAqi[hour] ?? null);
  });

  const dayIndex = dayIndexFor(first.daily.timeS, startAtS);
  const sunriseS = dayIndex === null ? null : (first.daily.sunriseS[dayIndex] ?? null);
  const sunsetS = dayIndex === null ? null : (first.daily.sunsetS[dayIndex] ?? null);

  return alongRouteForecastSchema.parse({
    trailId: input.trailId,
    startAt: isoWithOffset(startAtS, utcOffsetS),
    timezone: first.timezone,
    paceFactor,
    samples,
    flags: deriveFlags({
      samples,
      arrivalS: plans.map((p) => p.arrivalS),
      sunsetS,
      aqi,
      unitSystem,
    }),
    sunriseAt: sunriseS === null ? null : isoWithOffset(sunriseS, utcOffsetS),
    sunsetAt: sunsetS === null ? null : isoWithOffset(sunsetS, utcOffsetS),
    fetchedAt: new Date(nowS * 1000).toISOString(),
    // Open-Meteo's response names no model run; `fetchedAt` is the freshness signal. This stays
    // null until upstream gives us something true to put in it.
    model: null,
  } satisfies AlongRouteForecast);
}

/**
 * Read one sample's forecast at its own arrival hour. Values are clamped into the schema's
 * declared range first: a wind direction of 360.0000001 from an upstream rounding step would
 * otherwise throw at the schema boundary and take down a trail page.
 */
function toSample(plan: SamplePlan, location: LocationForecast, utcOffsetS: number): WeatherSample {
  const hourly = location.hourly;
  const i = hourIndexFor(hourly.timeS, plan.arrivalS);
  const at = <T>(series: readonly (T | null)[]): T | null =>
    i === null ? null : (series[i] ?? null);

  const isDay = at(hourly.isDay);

  return {
    distM: plan.distM,
    lng: plan.lng,
    lat: plan.lat,
    eleM: plan.eleM,
    label: plan.label,
    arrivalAt: isoWithOffset(plan.arrivalS, utcOffsetS),
    elapsedS: Math.round(plan.elapsedS),
    temperatureC: at(hourly.temperatureC),
    apparentTemperatureC: at(hourly.apparentTemperatureC),
    precipitationProbability: clamp(at(hourly.precipitationProbability), 0, 100),
    precipitationMm: clamp(at(hourly.precipitationMm), 0, Infinity),
    windSpeedKmh: clamp(at(hourly.windSpeedKmh), 0, Infinity),
    windGustsKmh: clamp(at(hourly.windGustsKmh), 0, Infinity),
    windDirectionDeg: clamp(at(hourly.windDirectionDeg), 0, 360),
    cloudCoverPct: clamp(at(hourly.cloudCoverPct), 0, 100),
    uvIndex: clamp(at(hourly.uvIndex), 0, Infinity),
    freezingLevelM: at(hourly.freezingLevelM),
    weatherCode: at(hourly.weatherCode),
    isDaylight: isDay === null ? null : isDay === 1,
  };
}

function clamp(value: number | null, lo: number, hi: number): number | null {
  if (value === null) return null;
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Collapse repeated coordinates before asking upstream. An out-and-back samples the same ground
 * twice at different hours, and one request covers both.
 */
function dedupePoints(points: readonly ForecastPoint[]): {
  unique: ForecastPoint[];
  indexOf: number[];
} {
  const unique: ForecastPoint[] = [];
  const seen = new Map<string, number>();
  const indexOf: number[] = [];

  for (const point of points) {
    // 4dp (~11 m) is the precision the request is serialised at, so points that round together
    // here would have been sent as identical strings anyway.
    const key = `${point.lat.toFixed(4)},${point.lng.toFixed(4)},${Math.round(point.eleM)}`;
    const existing = seen.get(key);
    if (existing !== undefined) {
      indexOf.push(existing);
      continue;
    }
    seen.set(key, unique.length);
    indexOf.push(unique.length);
    unique.push(point);
  }

  return { unique, indexOf };
}
