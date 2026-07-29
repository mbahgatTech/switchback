/**
 * Open-Meteo adapter.
 *
 * The reason along-trail weather is affordable at all: Open-Meteo accepts *lists* of
 * coordinates in one request and answers with one array of forecasts. Eight points along a
 * ridge is one HTTP call, not eight — which is what keeps a feature that fires on every
 * trail page inside a 10,000-request daily allowance.
 *
 * Two details do the real work here:
 *
 * - **`elevation` is sent, not inferred.** Left to itself Open-Meteo picks the elevation of
 *   the model cell, which over mountains is an average that can sit hundreds of metres
 *   below a summit. Passing our own DEM elevation triggers its statistical downscaling, and
 *   that is the difference between telling someone the summit is 8 °C and telling them it
 *   is 1 °C. Without this the whole feature is valley weather with extra steps.
 * - **`timeformat=unixtime`.** Every timestamp comes back as an epoch second in UTC, so
 *   matching an arrival time to a forecast hour is integer comparison rather than string
 *   parsing across a DST boundary. `utc_offset_seconds` comes back too, and rendering uses
 *   it once, at the end.
 *
 * Attribution is not optional: Open-Meteo is CC-BY 4.0 and the free tier is non-commercial.
 * `ATTRIBUTION.weather` in @switchback/core carries the credit and it is displayed wherever
 * this data is.
 */

import { HOUR_S } from './time';

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_AIR_QUALITY_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

/**
 * Hourly variables requested, in the order the response object keys them.
 *
 * `freezing_level_height` is the one that would not appear on a consumer weather app and is
 * the single most useful number in the list: the altitude of the 0 °C isotherm, which is
 * how you know whether the top of the route is snow before you have driven to it.
 */
const HOURLY_VARS = [
  'temperature_2m',
  'apparent_temperature',
  'precipitation_probability',
  'precipitation',
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'cloud_cover',
  'uv_index',
  'freezing_level_height',
  'weather_code',
  'is_day',
] as const;

const DAILY_VARS = ['sunrise', 'sunset'] as const;

/**
 * Daily aggregates, for the question "which day this week".
 *
 * Deliberately a different shape from the hourly series above, because it answers a
 * different question. The along-route forecast asks what it will be like *at the summit at
 * 11:20*; busyness asks whether Saturday is a write-off. Rolling the hourly series up here
 * would work and would be worse: `precipitation_probability_max` is the model's own daily
 * maximum, not the max of the twenty-four values we happened to sample.
 */
const DAILY_OUTLOOK_VARS = [
  'weather_code',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'precipitation_probability_max',
  'wind_gusts_10m_max',
] as const;

/** Retried; anything else is a bad request and retrying it just annoys a free service. */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * The current European AQI and everything needed to explain it.
 *
 * `current` rather than `hourly`, which is the whole reason a viewport-wide grid is
 * affordable: three days of hourly series at fifty locations is a megabyte of JSON to
 * render six colours from, where one value per location is a few kilobytes. The along-route
 * forecast still asks for the series, because it reads each point at a different hour.
 *
 * The five sub-indices come along because the European AQI is the *worst* of them, so the
 * one that matches the overall figure names what is actually in the air. That single word
 * is the difference between a number and advice.
 */
const AIR_QUALITY_CURRENT_VARS = [
  'european_aqi',
  'european_aqi_pm2_5',
  'european_aqi_pm10',
  'european_aqi_nitrogen_dioxide',
  'european_aqi_ozone',
  'european_aqi_sulphur_dioxide',
  'pm2_5',
] as const;

/** A place to ask about. Air quality needs no elevation — the models are surface fields. */
export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface ForecastPoint extends GeoPoint {
  /** Metres above sea level, from our own DEM. Drives Open-Meteo's downscaling. */
  eleM: number;
}

/** One location's hourly series. Every array is index-aligned with `timeS`. */
export interface HourlySeries {
  timeS: number[];
  temperatureC: (number | null)[];
  apparentTemperatureC: (number | null)[];
  precipitationProbability: (number | null)[];
  precipitationMm: (number | null)[];
  windSpeedKmh: (number | null)[];
  windGustsKmh: (number | null)[];
  windDirectionDeg: (number | null)[];
  cloudCoverPct: (number | null)[];
  uvIndex: (number | null)[];
  freezingLevelM: (number | null)[];
  weatherCode: (number | null)[];
  isDay: (number | null)[];
}

export interface DailySeries {
  timeS: number[];
  sunriseS: (number | null)[];
  sunsetS: (number | null)[];
}

export interface LocationForecast {
  lat: number;
  lng: number;
  /** Elevation the model actually used — not always the one we asked for. */
  elevationM: number;
  timezone: string;
  utcOffsetS: number;
  hourly: HourlySeries;
  daily: DailySeries;
}

export interface AirQualitySeries {
  timeS: number[];
  europeanAqi: (number | null)[];
}

/**
 * One location's air, right now.
 *
 * `lat`/`lng` are the coordinates *Open-Meteo answered with*, not the ones we sent. It
 * snaps every request to its own grid and says where it landed, which is the only
 * trustworthy statement of where a reading applies — and the thing that lets the overlay
 * draw a cell at the model's true footprint instead of pretending the number belongs to
 * the exact pixel someone happened to ask about.
 */
export interface AirQualityNow extends GeoPoint {
  /** The hour these readings are for, epoch seconds UTC. */
  timeS: number;
  europeanAqi: number | null;
  /** Sub-indices, in the order `AIR_QUALITY_POLLUTANTS` names them. */
  pm25Index: number | null;
  pm10Index: number | null;
  no2Index: number | null;
  ozoneIndex: number | null;
  so2Index: number | null;
  /** Fine particulates, µg/m³. */
  pm25: number | null;
}

/** One day's summary at one location. `timeS` is local midnight, as an epoch second. */
export interface OutlookDay {
  timeS: number;
  /** Day of week 0–6, 0 = Sunday, in the trail's own local time. */
  dayOfWeek: number;
  weatherCode: number | null;
  temperatureMaxC: number | null;
  temperatureMinC: number | null;
  precipitationMm: number | null;
  precipitationProbability: number | null;
  windGustsMaxKmh: number | null;
}

export interface DailyOutlook {
  timezone: string;
  utcOffsetS: number;
  days: OutlookDay[];
}

export class OpenMeteoError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OpenMeteoError';
  }
}

export interface OpenMeteoOptions {
  url?: string;
  airQualityUrl?: string;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  /** Deterministic jitter in tests. */
  randomImpl?: () => number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  timeoutMs?: number;
}

export class OpenMeteoClient {
  private readonly url: string;
  private readonly airQualityUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly randomImpl: () => number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly timeoutMs: number;

  constructor(options: OpenMeteoOptions = {}) {
    this.url = options.url?.trim() || OPEN_METEO_URL;
    this.airQualityUrl = options.airQualityUrl?.trim() || OPEN_METEO_AIR_QUALITY_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.randomImpl = options.randomImpl ?? Math.random;
    this.maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    this.baseBackoffMs = options.baseBackoffMs ?? 400;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /**
   * One request, every point.
   *
   * `past_days=1` is not about showing yesterday — it widens the returned window backwards
   * so a hike that started at 06:00 and is being checked at 14:00 still resolves its early
   * samples instead of falling off the front of the array.
   */
  async forecast(points: readonly ForecastPoint[]): Promise<LocationForecast[]> {
    if (points.length === 0) return [];

    const params = new URLSearchParams({
      latitude: points.map((p) => p.lat.toFixed(4)).join(','),
      longitude: points.map((p) => p.lng.toFixed(4)).join(','),
      elevation: points.map((p) => Math.round(p.eleM)).join(','),
      hourly: HOURLY_VARS.join(','),
      daily: DAILY_VARS.join(','),
      timezone: 'auto',
      timeformat: 'unixtime',
      wind_speed_unit: 'kmh',
      past_days: '1',
      forecast_days: '7',
    });

    const raw = await this.getJson(`${this.url}?${params.toString()}`);
    const locations = Array.isArray(raw) ? raw : [raw];
    return locations.map((entry) => parseLocation(entry as Record<string, unknown>));
  }

  /**
   * European AQI along the same points.
   *
   * Separate endpoint, separate call, and deliberately allowed to fail: air quality
   * sharpens the advice but a forecast without it is still a forecast, whereas a page that
   * 500s because a secondary service is down is nothing at all. The caller catches.
   */
  async airQuality(points: readonly ForecastPoint[]): Promise<AirQualitySeries[]> {
    if (points.length === 0) return [];

    const params = new URLSearchParams({
      latitude: points.map((p) => p.lat.toFixed(4)).join(','),
      longitude: points.map((p) => p.lng.toFixed(4)).join(','),
      hourly: 'european_aqi',
      timezone: 'auto',
      timeformat: 'unixtime',
      forecast_days: '3',
    });

    const raw = await this.getJson(`${this.airQualityUrl}?${params.toString()}`);
    const locations = Array.isArray(raw) ? raw : [raw];
    return locations.map((entry) => {
      const hourly = asRecord((entry as Record<string, unknown>).hourly);
      return {
        timeS: numberArray(hourly.time).map((t) => (t === null ? 0 : t)),
        europeanAqi: numberArray(hourly.european_aqi),
      };
    });
  }

  /**
   * The current European AQI at up to a few dozen points, in one call.
   *
   * The same list trick the forecast uses, and it matters more here: an overlay covering a
   * viewport asks about every cell on screen at once, so without it this feature would be
   * fifty requests per pan and would exhaust a day's allowance in an afternoon.
   *
   * Coordinates are sent at four decimals and come back snapped to the model grid. The
   * caller keeps what came back — see `AirQualityNow`.
   */
  async airQualityNow(points: readonly GeoPoint[]): Promise<AirQualityNow[]> {
    if (points.length === 0) return [];

    const params = new URLSearchParams({
      latitude: points.map((p) => p.lat.toFixed(4)).join(','),
      longitude: points.map((p) => p.lng.toFixed(4)).join(','),
      current: AIR_QUALITY_CURRENT_VARS.join(','),
      timeformat: 'unixtime',
    });

    const raw = await this.getJson(`${this.airQualityUrl}?${params.toString()}`);
    const locations = Array.isArray(raw) ? raw : [raw];
    return locations.map((entry, index) => {
      const record = asRecord(entry);
      const current = asRecord(record.current);
      const asked = points[index];
      return {
        // Falling back to what we asked for rather than to zero: a missing coordinate here
        // would otherwise put the cell in the Gulf of Guinea, which is a worse answer than
        // an unsnapped one.
        lat: typeof record.latitude === 'number' ? record.latitude : (asked?.lat ?? 0),
        lng: typeof record.longitude === 'number' ? record.longitude : (asked?.lng ?? 0),
        timeS: typeof current.time === 'number' ? current.time : 0,
        europeanAqi: finite(current.european_aqi),
        pm25Index: finite(current.european_aqi_pm2_5),
        pm10Index: finite(current.european_aqi_pm10),
        no2Index: finite(current.european_aqi_nitrogen_dioxide),
        ozoneIndex: finite(current.european_aqi_ozone),
        so2Index: finite(current.european_aqi_sulphur_dioxide),
        pm25: finite(current.pm2_5),
      };
    });
  }

  /**
   * Seven days of daily aggregates at one point.
   *
   * One coordinate, not a list: busyness is a property of the trail, not of a place on it,
   * and the centroid is the honest single answer. That keeps this to one request per trail
   * per hour — an order of magnitude cheaper than the along-route call it sits beside.
   *
   * **The `timeformat=unixtime` trap.** Open-Meteo returns every timestamp in GMT+0 even
   * when `timezone=auto` shifted the data, so a daily entry for local Saturday arrives as
   * the epoch second of Saturday 00:00 *UTC-shifted back*. Adding `utc_offset_seconds`
   * before reading the weekday is what stops a New Zealand trail's Saturday landing on
   * Friday — silently, and only for trails a long way from Greenwich.
   */
  async dailyOutlook(point: ForecastPoint): Promise<DailyOutlook> {
    const params = new URLSearchParams({
      latitude: point.lat.toFixed(4),
      longitude: point.lng.toFixed(4),
      elevation: String(Math.round(point.eleM)),
      daily: DAILY_OUTLOOK_VARS.join(','),
      timezone: 'auto',
      timeformat: 'unixtime',
      wind_speed_unit: 'kmh',
      forecast_days: '7',
    });

    const raw = await this.getJson(`${this.url}?${params.toString()}`);
    const entry = asRecord(Array.isArray(raw) ? raw[0] : raw);
    const daily = asRecord(entry.daily);
    const utcOffsetS = typeof entry.utc_offset_seconds === 'number' ? entry.utc_offset_seconds : 0;

    const timeS = requiredNumbers(daily.time);
    const codes = numberArray(daily.weather_code);
    const tempMax = numberArray(daily.temperature_2m_max);
    const tempMin = numberArray(daily.temperature_2m_min);
    const precip = numberArray(daily.precipitation_sum);
    const precipProb = numberArray(daily.precipitation_probability_max);
    const gusts = numberArray(daily.wind_gusts_10m_max);

    return {
      timezone: typeof entry.timezone === 'string' ? entry.timezone : 'UTC',
      utcOffsetS,
      days: timeS.map((seconds, i) => ({
        timeS: seconds,
        dayOfWeek: new Date((seconds + utcOffsetS) * 1000).getUTCDay(),
        weatherCode: codes[i] ?? null,
        temperatureMaxC: tempMax[i] ?? null,
        temperatureMinC: tempMin[i] ?? null,
        precipitationMm: precip[i] ?? null,
        precipitationProbability: precipProb[i] ?? null,
        windGustsMaxKmh: gusts[i] ?? null,
      })),
    };
  }

  private async getJson(url: string): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (response.ok) return await response.json();

        // Open-Meteo puts the actual complaint in `reason`, and it is usually specific
        // enough to fix ("Data corrupted at path ''. Cannot initialize Timezone from
        // invalid String value"). Surfacing the status alone would waste that.
        const reason = await readReason(response);
        if (!RETRYABLE_STATUS.has(response.status)) {
          throw new OpenMeteoError(`Open-Meteo ${response.status}: ${reason}`, response.status);
        }
        lastError = new OpenMeteoError(`Open-Meteo ${response.status}: ${reason}`, response.status);
        if (attempt < this.maxAttempts) {
          await this.sleepImpl(this.backoffMs(attempt, response.headers.get('retry-after')));
        }
      } catch (error) {
        if (error instanceof OpenMeteoError) throw error;
        lastError = error;
        if (attempt < this.maxAttempts) await this.sleepImpl(this.backoffMs(attempt, null));
      }
    }

    throw lastError instanceof Error ? lastError : new OpenMeteoError('Open-Meteo request failed');
  }

  /** Full jitter, and a server-named delay always wins over our own guess. */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const named = retryAfter === null ? NaN : Number(retryAfter);
    if (Number.isFinite(named) && named >= 0) return Math.min(named * 1000, 30_000);
    const ceiling = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), 8_000);
    return Math.round(ceiling / 2 + this.randomImpl() * (ceiling / 2));
  }
}

async function readReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { reason?: unknown };
    return typeof body.reason === 'string' ? body.reason : response.statusText;
  } catch {
    return response.statusText || 'no reason given';
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** One scalar, or `null` — the same refusal to invent a zero that `numberArray` makes. */
function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Coerce one series to numbers, preserving null.
 *
 * Open-Meteo returns `null` for a variable it has no value for at that hour — UV overnight,
 * precipitation probability past the high-resolution horizon. Those nulls are meaningful
 * and are carried all the way to the client, where the UI shows a dash rather than a zero.
 * Coercing them to 0 here would turn "unknown" into "none", which for precipitation is a
 * lie in the dangerous direction.
 */
function numberArray(value: unknown): (number | null)[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => (typeof entry === 'number' && Number.isFinite(entry) ? entry : null));
}

function requiredNumbers(value: unknown): number[] {
  return numberArray(value).map((n) => n ?? 0);
}

function parseLocation(entry: Record<string, unknown>): LocationForecast {
  const hourly = asRecord(entry.hourly);
  const daily = asRecord(entry.daily);
  const timeS = requiredNumbers(hourly.time);

  return {
    lat: typeof entry.latitude === 'number' ? entry.latitude : 0,
    lng: typeof entry.longitude === 'number' ? entry.longitude : 0,
    elevationM: typeof entry.elevation === 'number' ? entry.elevation : 0,
    timezone: typeof entry.timezone === 'string' ? entry.timezone : 'UTC',
    utcOffsetS: typeof entry.utc_offset_seconds === 'number' ? entry.utc_offset_seconds : 0,
    hourly: {
      timeS,
      temperatureC: numberArray(hourly.temperature_2m),
      apparentTemperatureC: numberArray(hourly.apparent_temperature),
      precipitationProbability: numberArray(hourly.precipitation_probability),
      precipitationMm: numberArray(hourly.precipitation),
      windSpeedKmh: numberArray(hourly.wind_speed_10m),
      windGustsKmh: numberArray(hourly.wind_gusts_10m),
      windDirectionDeg: numberArray(hourly.wind_direction_10m),
      cloudCoverPct: numberArray(hourly.cloud_cover),
      uvIndex: numberArray(hourly.uv_index),
      freezingLevelM: numberArray(hourly.freezing_level_height),
      weatherCode: numberArray(hourly.weather_code),
      isDay: numberArray(hourly.is_day),
    },
    daily: {
      timeS: requiredNumbers(daily.time),
      sunriseS: numberArray(daily.sunrise),
      sunsetS: numberArray(daily.sunset),
    },
  };
}

/** Hours covered by a series, for tests and diagnostics. */
export function seriesSpanS(series: HourlySeries): number {
  if (series.timeS.length === 0) return 0;
  return series.timeS[series.timeS.length - 1]! - series.timeS[0]! + HOUR_S;
}
