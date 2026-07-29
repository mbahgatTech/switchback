import { describe, expect, it } from 'vitest';
import { alongRouteForecast } from '../src/along-route';
import { OpenMeteoClient } from '../src/open-meteo';
import { DAY_S, HOUR_S } from '../src/time';
import {
  NOW_MS,
  NOW_S,
  OUT_AND_BACK,
  POINT_TO_POINT,
  UTC_OFFSET_S,
  fakeUpstream,
  localHourOf,
  makeProfile,
  paramsOf,
  temperatureAt,
  type FixtureOptions,
} from './fixtures';

function run(
  overrides: Partial<Parameters<typeof alongRouteForecast>[0]> = {},
  fixture: FixtureOptions = {},
) {
  const upstream = fakeUpstream(fixture);
  const client = new OpenMeteoClient({
    fetchImpl: upstream.fetchImpl,
    sleepImpl: async () => {},
    maxAttempts: 1,
  });
  const promise = alongRouteForecast(
    {
      trailId: 'trail-1',
      profile: makeProfile(),
      routeType: POINT_TO_POINT,
      // The default profile spans 2,000 m, and a point-to-point is hiked exactly once, so
      // the published length is the stored length. Out-and-back cases override both.
      lengthM: 2000,
      ...overrides,
    },
    { client, now: () => NOW_MS },
  );
  return { upstream, promise };
}

describe('alongRouteForecast', () => {
  it('asks one upstream call about all eight points, with our own elevations', async () => {
    const { upstream, promise } = run();
    const forecast = await promise;

    expect(upstream.forecastCalls).toHaveLength(1);
    expect(forecast.samples).toHaveLength(8);

    const params = paramsOf(upstream.forecastCalls[0]!);
    expect(params.get('latitude')!.split(',')).toHaveLength(8);
    expect(params.get('longitude')!.split(',')).toHaveLength(8);

    // The elevation list is what buys the downscaling. Without it Open-Meteo answers with
    // the model cell's average height and the summit row is valley weather.
    const elevations = params.get('elevation')!.split(',').map(Number);
    expect(elevations).toHaveLength(8);
    expect(Math.max(...elevations)).toBe(900);
    expect(Math.min(...elevations)).toBe(100);
    expect(params.get('timeformat')).toBe('unixtime');
    expect(params.get('timezone')).toBe('auto');
  });

  it('reads every sample from its own location, so height actually changes the answer', async () => {
    const { promise } = run();
    const forecast = await promise;

    for (const sample of forecast.samples) {
      expect(sample.temperatureC).toBe(temperatureAt(Math.round(sample.eleM)));
    }

    const trailhead = forecast.samples[0]!;
    const summit = forecast.samples[forecast.samples.length - 1]!;
    expect(summit.eleM).toBeGreaterThan(trailhead.eleM);
    // 800 m of ascent at the standard lapse rate: 5.2 °C colder up there. A build that
    // reads every sample off location[0] passes every other test in this file and fails
    // this one.
    expect(trailhead.temperatureC! - summit.temperatureC!).toBeCloseTo(5.2, 1);
  });

  it('reads every sample at its own arrival hour', async () => {
    const { promise } = run();
    const forecast = await promise;

    // The fixture encodes the local hour of each slot as cloud cover, so this is a direct
    // assertion that the forecast was time-shifted rather than taken all at the start hour.
    for (const sample of forecast.samples) {
      const arrivalS = Math.floor(Date.parse(sample.arrivalAt) / 1000);
      expect(sample.cloudCoverPct).toBe(localHourOf(arrivalS));
    }

    const hours = forecast.samples.map((s) => s.cloudCoverPct!);
    expect(new Set(hours).size).toBeGreaterThan(1);
  });

  it('has arrival times that only move forwards', async () => {
    const { promise } = run();
    const forecast = await promise;

    const arrivals = forecast.samples.map((s) => Date.parse(s.arrivalAt));
    for (let i = 1; i < arrivals.length; i++) {
      expect(arrivals[i]!).toBeGreaterThan(arrivals[i - 1]!);
    }
    expect(forecast.samples[0]!.elapsedS).toBe(0);
  });

  it('defaults to the next 07:00 local to the trail', async () => {
    // The fixture clock is 10:00 local, so today's dawn start has gone.
    const { promise } = run();
    const forecast = await promise;

    expect(forecast.startAt).toBe('2026-07-21T07:00:00+01:00');
    expect(forecast.samples[0]!.arrivalAt).toBe('2026-07-21T07:00:00+01:00');
    expect(forecast.timezone).toBe('Europe/London');
  });

  it('honours an explicit start time', async () => {
    const startAt = '2026-07-22T05:30:00+01:00';
    const { promise } = run({ startAt });
    const forecast = await promise;

    expect(forecast.startAt).toBe('2026-07-22T05:30:00+01:00');
    expect(forecast.samples[0]!.cloudCoverPct).toBe(5);
  });

  it('reports sunrise and sunset in the trail’s own time', async () => {
    const { promise } = run();
    const forecast = await promise;

    expect(forecast.sunriseAt).toBe('2026-07-21T05:00:00+01:00');
    expect(forecast.sunsetAt).toBe('2026-07-21T21:00:00+01:00');
  });

  it('hikes an out-and-back back down, and asks about each shared point once', async () => {
    const { upstream, promise } = run({ routeType: OUT_AND_BACK, lengthM: 4000 });
    const forecast = await promise;

    expect(forecast.samples).toHaveLength(8);
    expect(forecast.samples[7]!.label).toBe('Back at the start');
    expect(forecast.samples[7]!.distM).toBeCloseTo(4000, 0);

    // The return leg retraces real ground, so fewer distinct coordinates than samples.
    const asked = paramsOf(upstream.forecastCalls[0]!).get('latitude')!.split(',');
    const distinct = new Set(forecast.samples.map((s) => `${s.lat},${s.lng},${s.eleM}`));
    expect(asked.length).toBeLessThan(8);
    expect(asked.length).toBe(distinct.size);

    // Same place, different hour — which is the entire point.
    const outbound = forecast.samples.find((s) => s.distM > 1000 && s.distM < 2000)!;
    const inbound = forecast.samples.find(
      (s) => s.distM > 2000 && Math.abs(2 * 2000 - s.distM - outbound.distM) < 200,
    );
    if (inbound) {
      expect(inbound.arrivalAt).not.toBe(outbound.arrivalAt);
      expect(inbound.temperatureC).toBe(outbound.temperatureC);
    }
  });

  it('finishes an out-and-back sooner than twice the climb', async () => {
    const { promise } = run({ routeType: OUT_AND_BACK, lengthM: 4000 });
    const forecast = await promise;

    const summit = forecast.samples.find((s) => s.label === 'High point')!;
    const finish = forecast.samples[forecast.samples.length - 1]!;
    expect(finish.elapsedS).toBeLessThan(summit.elapsedS * 2);
  });

  it('derives flags from what it found', async () => {
    const { promise } = run({}, { freezingLevelM: 600, gustsKmh: 72 });
    const forecast = await promise;

    const kinds = forecast.flags.map((f) => f.kind);
    expect(kinds).toContain('freezing_level_below_summit');
    expect(kinds).toContain('severe_wind');
    expect(forecast.flags[0]!.severity).toBe('warning');
  });

  it('fetches air quality alongside, and survives without it', async () => {
    const withAir = run({}, { europeanAqi: 90 });
    const forecast = await withAir.promise;
    expect(withAir.upstream.airQualityCalls).toHaveLength(1);
    expect(forecast.flags.map((f) => f.kind)).toContain('poor_air_quality');

    // Now the same request with air quality broken. A secondary service being down must not
    // cost the user their forecast.
    const upstream = fakeUpstream();
    const brittle = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes('air-quality')) throw new Error('air quality is down');
      return upstream.fetchImpl(input, init);
    }) as unknown as typeof fetch;

    const degraded = await alongRouteForecast(
      { trailId: 'trail-1', profile: makeProfile(), routeType: POINT_TO_POINT, lengthM: 2000 },
      {
        client: new OpenMeteoClient({
          fetchImpl: brittle,
          sleepImpl: async () => {},
          maxAttempts: 1,
        }),
        now: () => NOW_MS,
      },
    );

    expect(degraded.samples).toHaveLength(8);
    expect(degraded.flags.map((f) => f.kind)).not.toContain('poor_air_quality');
  });

  it('skips the air quality call when asked to', async () => {
    const { upstream, promise } = run({ includeAirQuality: false });
    await promise;
    expect(upstream.airQualityCalls).toHaveLength(0);
    expect(upstream.forecastCalls).toHaveLength(1);
  });

  it('leaves values unknown rather than guessing when the start is past the horizon', async () => {
    // Ten days out. The model does not go that far, so every reading is null — and that is
    // what the strip must show, rather than a plausible-looking number.
    const startS = NOW_S + 10 * DAY_S;
    const startAt = new Date(startS * 1000).toISOString();
    const { promise } = run({ startAt });
    const forecast = await promise;

    expect(forecast.samples).toHaveLength(8);
    expect(forecast.samples.every((s) => s.temperatureC === null)).toBe(true);
    expect(forecast.flags).toEqual([]);
  });

  it('renders every time with the trail’s offset, not the host’s', async () => {
    const { promise } = run({}, { utcOffsetS: -7 * HOUR_S, timezone: 'America/Denver' });
    const forecast = await promise;

    expect(forecast.timezone).toBe('America/Denver');
    expect(forecast.startAt).toMatch(/T07:00:00-07:00$/);
    for (const sample of forecast.samples) {
      expect(sample.arrivalAt.endsWith('-07:00')).toBe(true);
    }
  });

  it('refuses a trail with no profile rather than inventing one', async () => {
    await expect(run({ profile: [] }).promise).rejects.toThrow(/no elevation profile/);
  });

  it('stamps when it was fetched', async () => {
    const { promise } = run();
    const forecast = await promise;
    expect(forecast.fetchedAt).toBe(new Date(NOW_S * 1000).toISOString());
    expect(forecast.model).toBeNull();
    expect(forecast.trailId).toBe('trail-1');
    expect(forecast.paceFactor).toBe(1);
  });

  it('sends the whole request as one URL under any reasonable length', async () => {
    const { upstream, promise } = run({ sampleCount: 12 });
    await promise;
    // Twelve points of lat/lng/elevation plus twelve variables. Worth asserting because the
    // day this crosses a gateway's URL limit it fails in production, not in review.
    expect(upstream.forecastCalls[0]!.length).toBeLessThan(2000);
  });
});

describe('the upstream window', () => {
  it('asks for yesterday too, so a hike already underway still resolves', async () => {
    const { upstream, promise } = run();
    await promise;
    const params = paramsOf(upstream.forecastCalls[0]!);
    expect(params.get('past_days')).toBe('1');
    expect(params.get('forecast_days')).toBe('7');
  });

  it('reads a start earlier today rather than falling off the front of the array', async () => {
    const startS = NOW_S - 4 * HOUR_S;
    const { promise } = run({ startAt: new Date(startS * 1000).toISOString() });
    const forecast = await promise;

    expect(forecast.samples[0]!.temperatureC).not.toBeNull();
    expect(forecast.samples[0]!.cloudCoverPct).toBe(localHourOf(startS, UTC_OFFSET_S));
  });
});
