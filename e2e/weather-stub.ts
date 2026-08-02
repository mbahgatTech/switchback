/**
 * A stand-in for Open-Meteo, so the browser suite does not depend on a third party being reachable.
 *
 * `trail.spec.ts` failed in CI with `tRPC weather.airQualityAt failed: TypeError: fetch failed` —
 * the runner could not reach api.open-meteo.com, the forecast strip never rendered, and the spec
 * reported that as a defect. The fetch happens in the Next.js server, not the browser, so
 * `page.route` cannot reach it the way `photographs.spec.ts` intercepts Commons; the app has to be
 * pointed somewhere else instead. `playwright.config.ts` sets `OPEN_METEO_URL` and
 * `OPEN_METEO_AIR_QUALITY_URL` at this process.
 *
 * The series are generated, not recorded: a captured response would expire, and pinned numbers let
 * the spec assert a temperature rather than that some digits appeared.
 */
import { createServer } from 'node:http';

/** Hours either side of now, matching `past_days=1` and a week forward. */
const PAST_HOURS = 24;
const FUTURE_HOURS = 24 * 7;
const HOUR_S = 3600;

/**
 * Pinned so an assertion can name it. Warm at the trailhead, freezing well above any summit the
 * suite opens — the freezing-level annotation is what made the collar count weather-dependent, and
 * a fixture that never triggers it keeps the two specs independent.
 */
export const STUB_TEMPERATURE_C = 11;
export const STUB_FREEZING_LEVEL_M = 4200;
export const STUB_AQI = 21;

/** Hourly series start, aligned to the hour so the app's arrival-hour lookup is exact. */
function windowStart(nowS: number): number {
  return Math.floor(nowS / HOUR_S) * HOUR_S - PAST_HOURS * HOUR_S;
}

function hours(nowS: number): number[] {
  const start = windowStart(nowS);
  return Array.from({ length: PAST_HOURS + FUTURE_HOURS }, (_, i) => start + i * HOUR_S);
}

/** Coordinate lists arrive comma-separated; one response object per point, in request order. */
function coordinates(params: URLSearchParams, key: string): number[] {
  return (params.get(key) ?? '')
    .split(',')
    .filter((s) => s.length > 0)
    .map(Number);
}

function forecastFor(params: URLSearchParams, nowS: number): unknown[] {
  const lats = coordinates(params, 'latitude');
  const lngs = coordinates(params, 'longitude');
  const elevations = coordinates(params, 'elevation');
  const timeS = hours(nowS);
  const days = Array.from(
    { length: 8 },
    (_, i) => Math.floor(timeS[0]! / 86_400) * 86_400 + i * 86_400,
  );

  return lats.map((lat, i) => ({
    latitude: lat,
    longitude: lngs[i] ?? 0,
    elevation: elevations[i] ?? 0,
    timezone: 'UTC',
    utc_offset_seconds: 0,
    hourly: {
      time: timeS,
      // Cooler with altitude, so a summit sample differs from the trailhead and the strip is
      // visibly time-shifted rather than one reading repeated.
      temperature_2m: timeS.map(() => STUB_TEMPERATURE_C - (elevations[i] ?? 0) / 200),
      apparent_temperature: timeS.map(() => STUB_TEMPERATURE_C - 2 - (elevations[i] ?? 0) / 200),
      precipitation_probability: timeS.map(() => 10),
      precipitation: timeS.map(() => 0),
      wind_speed_10m: timeS.map(() => 12),
      wind_gusts_10m: timeS.map(() => 24),
      wind_direction_10m: timeS.map(() => 225),
      cloud_cover: timeS.map(() => 30),
      uv_index: timeS.map(() => 3),
      freezing_level_height: timeS.map(() => STUB_FREEZING_LEVEL_M),
      weather_code: timeS.map(() => 1),
      is_day: timeS.map((t) => ((t % 86_400) / 3600 >= 6 && (t % 86_400) / 3600 < 20 ? 1 : 0)),
    },
    daily: {
      time: days,
      sunrise: days.map((d) => d + 6 * HOUR_S),
      sunset: days.map((d) => d + 20 * HOUR_S),
    },
  }));
}

function airQualityFor(params: URLSearchParams, nowS: number): unknown[] {
  const lats = coordinates(params, 'latitude');
  const lngs = coordinates(params, 'longitude');
  const timeS = hours(nowS);

  return lats.map((lat, i) => ({
    latitude: lat,
    longitude: lngs[i] ?? 0,
    timezone: 'UTC',
    utc_offset_seconds: 0,
    hourly: { time: timeS, european_aqi: timeS.map(() => STUB_AQI) },
  }));
}

const port = Number(process.env.WEATHER_STUB_PORT ?? 4599);

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const nowS = Math.floor(Date.now() / 1000);

  // Playwright polls this before starting the app, so it must answer before anything else does.
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
    return;
  }

  const body =
    url.pathname === '/air-quality'
      ? airQualityFor(url.searchParams, nowS)
      : forecastFor(url.searchParams, nowS);

  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}).listen(port, '127.0.0.1', () => {
  console.warn(`weather stub on http://127.0.0.1:${port}`);
});
