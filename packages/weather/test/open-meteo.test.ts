import { describe, expect, it } from 'vitest';
import {
  OPEN_METEO_URL,
  OpenMeteoClient,
  OpenMeteoError,
  seriesSpanS,
  type HourlySeries,
} from '../src/open-meteo';
import { HOUR_S } from '../src/time';

const POINTS = [
  { lat: 56.7969, lng: -5.0036, eleM: 100 },
  { lat: 56.7969, lng: -5.0036, eleM: 1345 },
];

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ONE_LOCATION = {
  latitude: 56.7969,
  longitude: -5.0036,
  elevation: 1345,
  timezone: 'Europe/London',
  utc_offset_seconds: 3600,
  hourly: {
    time: [1_784_000_000, 1_784_003_600],
    temperature_2m: [11.2, null],
    apparent_temperature: [9.4, null],
    precipitation_probability: [null, 40],
    precipitation: [0, null],
    wind_speed_10m: [22, 24],
    wind_gusts_10m: [40, 44],
    wind_direction_10m: [225, 230],
    cloud_cover: [80, 90],
    uv_index: [null, 1.2],
    freezing_level_height: [900, 880],
    weather_code: [3, 61],
    is_day: [0, 1],
  },
  daily: {
    time: [1_783_990_000],
    sunrise: [1_784_000_000],
    sunset: [1_784_050_000],
  },
};

function client(fetchImpl: typeof fetch, overrides = {}) {
  return new OpenMeteoClient({
    fetchImpl,
    sleepImpl: async () => {},
    randomImpl: () => 0.5,
    ...overrides,
  });
}

describe('OpenMeteoClient.forecast', () => {
  it('sends one request with parallel coordinate and elevation lists', async () => {
    let url = '';
    const fetchImpl = (async (input: string | URL) => {
      url = String(input);
      return jsonResponse([ONE_LOCATION, ONE_LOCATION]);
    }) as unknown as typeof fetch;

    await client(fetchImpl).forecast(POINTS);

    const params = new URL(url).searchParams;
    expect(url.startsWith(OPEN_METEO_URL)).toBe(true);
    expect(params.get('latitude')).toBe('56.7969,56.7969');
    expect(params.get('elevation')).toBe('100,1345');
    expect(params.get('wind_speed_unit')).toBe('kmh');
    expect(params.get('hourly')).toContain('freezing_level_height');
    expect(params.get('daily')).toBe('sunrise,sunset');
  });

  it('accepts a single-object response as well as an array', async () => {
    const fetchImpl = (async () => jsonResponse(ONE_LOCATION)) as unknown as typeof fetch;
    const result = await client(fetchImpl).forecast([POINTS[0]!]);
    expect(result).toHaveLength(1);
    expect(result[0]!.timezone).toBe('Europe/London');
    expect(result[0]!.utcOffsetS).toBe(3600);
  });

  it('keeps nulls as nulls', async () => {
    // "No value at this hour" is not "zero at this hour". For precipitation that difference
    // is the difference between a dash and a claim.
    const fetchImpl = (async () => jsonResponse([ONE_LOCATION])) as unknown as typeof fetch;
    const [location] = await client(fetchImpl).forecast([POINTS[0]!]);

    expect(location!.hourly.temperatureC).toEqual([11.2, null]);
    expect(location!.hourly.precipitationProbability).toEqual([null, 40]);
    expect(location!.hourly.precipitationMm).toEqual([0, null]);
    expect(location!.hourly.uvIndex).toEqual([null, 1.2]);
  });

  it('does not call out at all for an empty point list', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse([]);
    }) as unknown as typeof fetch;

    expect(await client(fetchImpl).forecast([])).toEqual([]);
    expect(await client(fetchImpl).airQuality([])).toEqual([]);
    expect(calls).toBe(0);
  });

  it('retries a 503 and succeeds', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1 ? jsonResponse({ reason: 'busy' }, 503) : jsonResponse([ONE_LOCATION]);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).forecast([POINTS[0]!]);
    expect(calls).toBe(2);
    expect(result).toHaveLength(1);
  });

  it('gives up after maxAttempts and reports the upstream reason', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ reason: 'Minutely API request limit exceeded' }, 429);
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl, { maxAttempts: 3 }).forecast([POINTS[0]!])).rejects.toThrow(
      /Minutely API request limit exceeded/,
    );
    expect(calls).toBe(3);
  });

  it('does not retry a bad request', async () => {
    // A 400 is our mistake. Retrying it three times against a free service is rude and does
    // not fix anything.
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse({ reason: 'Cannot initialize Timezone from invalid String value' }, 400);
    }) as unknown as typeof fetch;

    await expect(client(fetchImpl).forecast([POINTS[0]!])).rejects.toBeInstanceOf(OpenMeteoError);
    expect(calls).toBe(1);
  });

  it('honours Retry-After over its own backoff', async () => {
    const waits: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1
        ? jsonResponse({ reason: 'slow down' }, 429, { 'retry-after': '2' })
        : jsonResponse([ONE_LOCATION]);
    }) as unknown as typeof fetch;

    const impl = new OpenMeteoClient({
      fetchImpl,
      sleepImpl: async (ms) => {
        waits.push(ms);
      },
    });
    await impl.forecast([POINTS[0]!]);
    expect(waits).toEqual([2000]);
  });

  it('retries a transport failure', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) throw new Error('socket hang up');
      return jsonResponse([ONE_LOCATION]);
    }) as unknown as typeof fetch;

    expect(await client(fetchImpl).forecast([POINTS[0]!])).toHaveLength(1);
    expect(calls).toBe(2);
  });

  it('survives a response missing whole sections', async () => {
    const fetchImpl = (async () => jsonResponse([{ latitude: 1 }])) as unknown as typeof fetch;
    const [location] = await client(fetchImpl).forecast([POINTS[0]!]);
    expect(location!.hourly.timeS).toEqual([]);
    expect(location!.timezone).toBe('UTC');
    expect(location!.daily.sunsetS).toEqual([]);
  });
});

describe('OpenMeteoClient.airQuality', () => {
  it('asks the air quality host for european_aqi only', async () => {
    let url = '';
    const fetchImpl = (async (input: string | URL) => {
      url = String(input);
      return jsonResponse([{ hourly: { time: [1, 2], european_aqi: [21, null] } }]);
    }) as unknown as typeof fetch;

    const result = await client(fetchImpl).airQuality(POINTS);
    expect(url).toContain('air-quality');
    expect(new URL(url).searchParams.get('hourly')).toBe('european_aqi');
    expect(result[0]!.europeanAqi).toEqual([21, null]);
  });
});

describe('seriesSpanS', () => {
  const empty: HourlySeries = {
    timeS: [],
    temperatureC: [],
    apparentTemperatureC: [],
    precipitationProbability: [],
    precipitationMm: [],
    windSpeedKmh: [],
    windGustsKmh: [],
    windDirectionDeg: [],
    cloudCoverPct: [],
    uvIndex: [],
    freezingLevelM: [],
    weatherCode: [],
    isDay: [],
  };

  it('counts the last hour as an hour', () => {
    expect(seriesSpanS(empty)).toBe(0);
    expect(seriesSpanS({ ...empty, timeS: [0, HOUR_S, 2 * HOUR_S] })).toBe(3 * HOUR_S);
  });
});
