/**
 * A fake Open-Meteo whose numbers encode *where* and *when* they came from: temperature is a
 * pure function of the elevation asked about, cloud cover of the slot's local hour. So a sample
 * reporting 16.2 °C and 44% cloud proves the code read location 4 at 11:00 — which is what
 * catches the bug this feature is most likely to grow, reading every sample off the trailhead.
 */

import type { ElevationPoint, RouteType } from '@switchback/core';
import { DAY_S, HOUR_S } from '../src/time';

export const TZ = 'Europe/London';
/** BST. Non-zero on purpose: a zero offset would hide every offset bug in the file. */
export const UTC_OFFSET_S = 3600;

export const NOW_MS = Date.UTC(2026, 6, 20, 9, 0, 0);
export const NOW_S = Math.floor(NOW_MS / 1000);

/** Sea-level temperature and the standard atmospheric lapse rate the fixture applies. */
export const SEA_LEVEL_C = 20;
export const LAPSE_C_PER_M = 0.0065;

export function temperatureAt(eleM: number): number {
  return Number((SEA_LEVEL_C - LAPSE_C_PER_M * eleM).toFixed(2));
}

/** The instant of local midnight on the day containing `epochS`. */
export function localMidnightS(epochS: number, offsetS: number = UTC_OFFSET_S): number {
  return Math.floor((epochS + offsetS) / DAY_S) * DAY_S - offsetS;
}

export function localHourOf(epochS: number, offsetS: number = UTC_OFFSET_S): number {
  const secondsIntoLocalDay = (((epochS + offsetS) % DAY_S) + DAY_S) % DAY_S;
  return Math.floor(secondsIntoLocalDay / HOUR_S);
}

export interface FixtureOptions {
  freezingLevelM?: number;
  gustsKmh?: number;
  windKmh?: number;
  precipitationProbability?: number;
  precipitationMm?: number;
  weatherCode?: number;
  uvIndex?: number;
  /** Local hour of sunset. 21:00 in July at this latitude. */
  sunsetHourLocal?: number;
  sunriseHourLocal?: number;
  europeanAqi?: number;
  utcOffsetS?: number;
  timezone?: string;
  /** Day of week (0 = Sunday) the daily outlook should report as a washout. */
  soakedDayOfWeek?: number;
}

function parseList(params: URLSearchParams, key: string): number[] {
  const raw = params.get(key);
  return raw ? raw.split(',').map(Number) : [];
}

/** Weekday of a daily entry, applying the offset exactly as the client has to. */
export function dayOfWeekOf(daySchemaS: number, offsetS: number): number {
  return new Date((daySchemaS + offsetS) * 1000).getUTCDay();
}

/**
 * The daily aggregates, emitted only when the request asks for them. Kept in the same fake as
 * the hourly body because there is one Open-Meteo forecast endpoint, and two fakes would
 * eventually disagree about something like the offset convention on `time`.
 */
function makeOutlookDaily(
  daysS: readonly number[],
  offsetS: number,
  options: FixtureOptions,
): Record<string, (number | null)[]> {
  const soaked = (t: number) =>
    options.soakedDayOfWeek !== undefined && dayOfWeekOf(t, offsetS) === options.soakedDayOfWeek;

  return {
    weather_code: daysS.map((t) => (soaked(t) ? 65 : 3)),
    // Descending with the day index, so a test can prove which day a value came from.
    temperature_2m_max: daysS.map((t, i) => (soaked(t) ? 4 : 18 - i)),
    temperature_2m_min: daysS.map((t, i) => (soaked(t) ? 1 : 10 - i)),
    precipitation_sum: daysS.map((t) => (soaked(t) ? 24 : (options.precipitationMm ?? 0))),
    precipitation_probability_max: daysS.map((t) =>
      soaked(t) ? 100 : (options.precipitationProbability ?? 5),
    ),
    wind_gusts_10m_max: daysS.map((t) => (soaked(t) ? 85 : (options.gustsKmh ?? 15))),
  };
}

export function makeForecastBody(params: URLSearchParams, options: FixtureOptions = {}) {
  const lats = parseList(params, 'latitude');
  const lngs = parseList(params, 'longitude');
  const eles = parseList(params, 'elevation');
  const offsetS = options.utcOffsetS ?? UTC_OFFSET_S;

  // An outlook request asks for daily variables and no hourly ones, and unlike the along-route
  // call it does not look backwards — so its week starts today, not yesterday.
  const wantsOutlook = (params.get('daily') ?? '').includes('temperature_2m_max');
  const midnightS = localMidnightS(NOW_S, offsetS);
  const startS = wantsOutlook ? midnightS : midnightS - DAY_S;
  const timeS = Array.from({ length: 24 * 8 }, (_, i) => startS + i * HOUR_S);
  const daysS = Array.from({ length: wantsOutlook ? 7 : 8 }, (_, i) => startS + i * DAY_S);

  return lats.map((lat, i) => {
    const eleM = eles[i] ?? 0;
    return {
      latitude: lat,
      longitude: lngs[i] ?? 0,
      elevation: eleM,
      timezone: options.timezone ?? TZ,
      utc_offset_seconds: offsetS,
      hourly: {
        time: timeS,
        temperature_2m: timeS.map(() => temperatureAt(eleM)),
        apparent_temperature: timeS.map(() => temperatureAt(eleM) - 1),
        precipitation_probability: timeS.map(() => options.precipitationProbability ?? 5),
        precipitation: timeS.map(() => options.precipitationMm ?? 0),
        wind_speed_10m: timeS.map(() => options.windKmh ?? 12),
        wind_gusts_10m: timeS.map(() => options.gustsKmh ?? 18),
        wind_direction_10m: timeS.map(() => 225),
        // The hour marker. Every assertion about time-shifting reads this.
        cloud_cover: timeS.map((t) => localHourOf(t, offsetS)),
        uv_index: timeS.map(() => options.uvIndex ?? 3),
        freezing_level_height: timeS.map(() => options.freezingLevelM ?? 3200),
        weather_code: timeS.map(() => options.weatherCode ?? 3),
        is_day: timeS.map((t) =>
          localHourOf(t, offsetS) >= 5 && localHourOf(t, offsetS) < 21 ? 1 : 0,
        ),
      },
      daily: {
        time: daysS,
        sunrise: daysS.map((d) => d + (options.sunriseHourLocal ?? 5) * HOUR_S),
        sunset: daysS.map((d) => d + (options.sunsetHourLocal ?? 21) * HOUR_S),
        ...(wantsOutlook ? makeOutlookDaily(daysS, offsetS, options) : {}),
      },
    };
  });
}

export function makeAirQualityBody(params: URLSearchParams, options: FixtureOptions = {}) {
  const lats = parseList(params, 'latitude');
  const offsetS = options.utcOffsetS ?? UTC_OFFSET_S;
  const startS = localMidnightS(NOW_S, offsetS);
  const timeS = Array.from({ length: 24 * 3 }, (_, i) => startS + i * HOUR_S);

  return lats.map(() => ({
    hourly: {
      time: timeS,
      european_aqi: timeS.map(() => options.europeanAqi ?? 20),
    },
  }));
}

export interface FakeUpstream {
  fetchImpl: typeof fetch;
  /** Every URL requested, in order. */
  calls: string[];
  forecastCalls: string[];
  airQualityCalls: string[];
}

export function fakeUpstream(options: FixtureOptions = {}): FakeUpstream {
  const calls: string[] = [];
  const forecastCalls: string[] = [];
  const airQualityCalls: string[] = [];

  // Narrower than `fetch` on purpose: the client only ever sends a URL string, and the cast
  // below says so. (`RequestInfo` is unavailable — this repo builds against ES2022 with no DOM.)
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const params = new URL(url).searchParams;
    const isAir = url.includes('air-quality');
    if (isAir) airQualityCalls.push(url);
    else forecastCalls.push(url);

    const body = isAir ? makeAirQualityBody(params, options) : makeForecastBody(params, options);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls, forecastCalls, airQualityCalls };
}

/** Query params of the nth call of a kind, for asserting what we actually asked upstream. */
export function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

export interface ProfileOptions {
  points?: number;
  spacingM?: number;
  startEleM?: number;
  endEleM?: number;
  lat?: number;
  lng?: number;
}

/**
 * A synthetic climb: evenly spaced, monotonically ascending, 25 m apart like the real
 * resampled profiles. Coordinates drift east so no two points share a location key.
 */
export function makeProfile(options: ProfileOptions = {}): ElevationPoint[] {
  const points = options.points ?? 81;
  const spacingM = options.spacingM ?? 25;
  const startEleM = options.startEleM ?? 100;
  const endEleM = options.endEleM ?? 900;
  const lat = options.lat ?? 56.79;
  const lng = options.lng ?? -5.0;

  return Array.from({ length: points }, (_, i) => {
    const t = points === 1 ? 0 : i / (points - 1);
    return {
      distM: i * spacingM,
      eleM: startEleM + (endEleM - startEleM) * t,
      // ~11 m per step at this latitude, enough that no two points round together at 4 dp.
      lng: Number((lng + i * 0.0004).toFixed(6)),
      lat: Number((lat + i * 0.0002).toFixed(6)),
    };
  });
}

export const OUT_AND_BACK: RouteType = 'out_and_back';
export const POINT_TO_POINT: RouteType = 'point_to_point';
