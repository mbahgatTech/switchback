import type { WeatherSample } from '@switchback/core';
import { describe, expect, it } from 'vitest';
import {
  AFTER_DARK_GRACE_S,
  AQI_CAUTION,
  AQI_WARNING,
  COLD_CAUTION_C,
  COLD_WARNING_C,
  HEAT_CAUTION_C,
  HEAT_WARNING_C,
  PRECIP_AMOUNT_MM,
  PRECIP_PROBABILITY_PCT,
  UV_CAUTION,
  UV_WARNING,
  WIND_CAUTION_KMH,
  WIND_WARNING_KMH,
  deriveFlags,
} from '../src/flags';

const BENIGN: WeatherSample = {
  distM: 0,
  lng: -5,
  lat: 56.79,
  eleM: 100,
  label: 'Trailhead',
  arrivalAt: '2026-07-20T07:00:00+01:00',
  elapsedS: 0,
  temperatureC: 14,
  apparentTemperatureC: 13,
  precipitationProbability: 5,
  precipitationMm: 0,
  windSpeedKmh: 10,
  windGustsKmh: 16,
  windDirectionDeg: 225,
  cloudCoverPct: 40,
  uvIndex: 3,
  freezingLevelM: 3200,
  weatherCode: 3,
  isDaylight: true,
};

function sample(overrides: Partial<WeatherSample> = {}): WeatherSample {
  return { ...BENIGN, ...overrides };
}

/** Two samples: a trailhead and a high point, both benign unless overridden. */
function pair(
  high: Partial<WeatherSample> = {},
  low: Partial<WeatherSample> = {},
): WeatherSample[] {
  return [
    sample({ ...low }),
    sample({ distM: 2000, eleM: 900, label: 'High point', elapsedS: 5400, ...high }),
  ];
}

const ARRIVALS = [1_784_000_000, 1_784_005_400];
const SUNSET_S = 1_784_040_000;

function flags(samples: WeatherSample[], extra: Partial<Parameters<typeof deriveFlags>[0]> = {}) {
  return deriveFlags({
    samples,
    arrivalS: ARRIVALS.slice(0, samples.length),
    sunsetS: SUNSET_S,
    unitSystem: 'metric',
    ...extra,
  });
}

const kinds = (result: ReturnType<typeof deriveFlags>) => result.map((f) => f.kind);

describe('deriveFlags', () => {
  it('says nothing about a good day', () => {
    expect(flags(pair())).toEqual([]);
  });

  it('returns nothing for no samples', () => {
    expect(
      deriveFlags({ samples: [], arrivalS: [], sunsetS: SUNSET_S, unitSystem: 'metric' }),
    ).toEqual([]);
  });
});

describe('freezing level', () => {
  it('fires when the 0 °C isotherm sits at or below the high point', () => {
    const result = flags(pair({ freezingLevelM: 850 }));
    expect(kinds(result)).toContain('freezing_level_below_summit');
    const flag = result.find((f) => f.kind === 'freezing_level_below_summit')!;
    expect(flag.severity).toBe('warning');
    expect(flag.sampleIndex).toBe(1);
    expect(flag.message).toContain('850 m');
    expect(flag.message).toContain('900 m');
  });

  it('fires on the boundary, where the freezing level meets the summit exactly', () => {
    expect(kinds(flags(pair({ freezingLevelM: 900 })))).toContain('freezing_level_below_summit');
  });

  it('stays quiet when the freezing level is above the trail', () => {
    expect(kinds(flags(pair({ freezingLevelM: 901 })))).not.toContain(
      'freezing_level_below_summit',
    );
  });

  it('treats an unknown freezing level as unknown, not as safe', () => {
    // The whole rule in one test: a null must not produce a flag, and must not silence one
    // either — it produces no claim at all.
    expect(kinds(flags(pair({ freezingLevelM: null })))).not.toContain(
      'freezing_level_below_summit',
    );
  });

  it('is judged at the high point, not the trailhead', () => {
    // Freezing level 500 m: above the trailhead, below the summit. A trailhead-only check
    // would call this fine, which is the exact failure this product exists to avoid.
    const result = flags(pair({ freezingLevelM: 500 }, { freezingLevelM: 500 }));
    expect(kinds(result)).toContain('freezing_level_below_summit');
    expect(result[0]!.sampleIndex).toBe(1);
  });
});

describe('wind', () => {
  it('cautions above the caution threshold', () => {
    const result = flags(pair({ windGustsKmh: WIND_CAUTION_KMH }));
    expect(kinds(result)).toEqual(['high_wind']);
    expect(result[0]!.severity).toBe('caution');
    expect(result[0]!.message).toContain('High point');
  });

  it('warns above the severe threshold, and does not also caution', () => {
    const result = flags(pair({ windGustsKmh: WIND_WARNING_KMH }));
    expect(kinds(result)).toEqual(['severe_wind']);
    expect(result[0]!.severity).toBe('warning');
  });

  it('stays quiet just below the threshold', () => {
    expect(flags(pair({ windGustsKmh: WIND_CAUTION_KMH - 0.1 }))).toEqual([]);
  });

  it('names the windiest point, wherever it is', () => {
    const result = flags(pair({ windGustsKmh: 20 }, { windGustsKmh: 70, label: 'Trailhead' }));
    expect(result[0]!.sampleIndex).toBe(0);
    expect(result[0]!.message).toContain('Trailhead');
  });

  it('says nothing when no sample has a gust reading', () => {
    expect(flags(pair({ windGustsKmh: null }, { windGustsKmh: null }))).toEqual([]);
  });
});

describe('thunderstorms', () => {
  it.each([95, 96, 99])('warns on WMO code %i', (code) => {
    const result = flags(pair({ weatherCode: code }));
    expect(kinds(result)).toContain('thunderstorm_risk');
    expect(result.find((f) => f.kind === 'thunderstorm_risk')!.severity).toBe('warning');
  });

  it('ignores ordinary rain codes', () => {
    expect(kinds(flags(pair({ weatherCode: 63 })))).not.toContain('thunderstorm_risk');
  });

  it('names the first sample it reaches, not the last', () => {
    const result = flags(pair({ weatherCode: 95 }, { weatherCode: 95 }));
    expect(result.find((f) => f.kind === 'thunderstorm_risk')!.sampleIndex).toBe(0);
  });
});

describe('precipitation', () => {
  it('fires on probability alone', () => {
    const result = flags(pair({ precipitationProbability: PRECIP_PROBABILITY_PCT }));
    expect(kinds(result)).toEqual(['precipitation_en_route']);
    expect(result[0]!.message).toContain('50%');
  });

  it('fires on amount alone, even when probability is missing', () => {
    // A model that gives an amount but no probability past its high-resolution horizon
    // should still warn about rain, and should not claim a percentage it does not have.
    const result = flags(
      pair({ precipitationProbability: null, precipitationMm: PRECIP_AMOUNT_MM }),
    );
    expect(kinds(result)).toEqual(['precipitation_en_route']);
    expect(result[0]!.message).not.toContain('%');
  });

  it('ignores a trace', () => {
    expect(flags(pair({ precipitationProbability: 20, precipitationMm: 0.1 }))).toEqual([]);
  });

  it('is a caution, not a warning — rain is a packing decision', () => {
    expect(flags(pair({ precipitationProbability: 95 }))[0]!.severity).toBe('caution');
  });
});

describe('darkness', () => {
  it('warns when the finish lands well after sunset', () => {
    const result = deriveFlags({
      samples: pair(),
      arrivalS: [SUNSET_S - 7200, SUNSET_S + 3600],
      sunsetS: SUNSET_S,
      unitSystem: 'metric',
    });
    expect(kinds(result)).toContain('finish_after_dark');
    const flag = result.find((f) => f.kind === 'finish_after_dark')!;
    expect(flag.severity).toBe('warning');
    expect(flag.message).toContain('1h');
    expect(flag.sampleIndex).toBe(1);
  });

  it('allows the twilight grace period', () => {
    const result = deriveFlags({
      samples: pair(),
      arrivalS: [SUNSET_S - 7200, SUNSET_S + AFTER_DARK_GRACE_S - 60],
      sunsetS: SUNSET_S,
      unitSystem: 'metric',
    });
    expect(kinds(result)).not.toContain('finish_after_dark');
  });

  it('says nothing when sunset is unknown', () => {
    const result = deriveFlags({
      samples: pair(),
      arrivalS: [SUNSET_S - 7200, SUNSET_S + 36_000],
      sunsetS: null,
      unitSystem: 'metric',
    });
    expect(kinds(result)).not.toContain('finish_after_dark');
  });
});

describe('uv, heat and cold', () => {
  it('escalates UV from caution to warning', () => {
    expect(flags(pair({ uvIndex: UV_CAUTION }))[0]!.severity).toBe('caution');
    expect(flags(pair({ uvIndex: UV_WARNING }))[0]!.severity).toBe('warning');
    expect(flags(pair({ uvIndex: UV_CAUTION - 0.1 }))).toEqual([]);
  });

  it('escalates heat from caution to warning, on apparent temperature', () => {
    expect(flags(pair({ apparentTemperatureC: HEAT_CAUTION_C }))[0]!.kind).toBe('extreme_heat');
    expect(flags(pair({ apparentTemperatureC: HEAT_CAUTION_C }))[0]!.severity).toBe('caution');
    expect(flags(pair({ apparentTemperatureC: HEAT_WARNING_C }))[0]!.severity).toBe('warning');
  });

  it('escalates cold from caution to warning', () => {
    expect(flags(pair({ apparentTemperatureC: COLD_CAUTION_C }))[0]!.kind).toBe('extreme_cold');
    expect(flags(pair({ apparentTemperatureC: COLD_WARNING_C }))[0]!.severity).toBe('warning');
    expect(flags(pair({ apparentTemperatureC: -20 }))[0]!.message).toContain('-20°C');
  });

  it('does not invent a temperature when none was returned', () => {
    expect(flags(pair({ apparentTemperatureC: null }, { apparentTemperatureC: null }))).toEqual([]);
    expect(flags(pair({ uvIndex: null }, { uvIndex: null }))).toEqual([]);
  });
});

describe('air quality', () => {
  it('fires on the poor band and escalates on very poor', () => {
    expect(kinds(flags(pair(), { aqi: [10, AQI_CAUTION] }))).toEqual(['poor_air_quality']);
    expect(flags(pair(), { aqi: [10, AQI_CAUTION] })[0]!.severity).toBe('caution');
    expect(flags(pair(), { aqi: [10, AQI_WARNING] })[0]!.severity).toBe('warning');
  });

  it('stays quiet on clean air, on missing readings, and when not fetched at all', () => {
    expect(flags(pair(), { aqi: [10, 20] })).toEqual([]);
    expect(flags(pair(), { aqi: [null, null] })).toEqual([]);
    expect(flags(pair())).toEqual([]);
  });
});

describe('ordering', () => {
  it('puts warnings first, then follows the trail', () => {
    const result = flags(
      [
        sample({ precipitationProbability: 80 }),
        sample({ distM: 2000, eleM: 900, label: 'High point', windGustsKmh: 80, uvIndex: 9 }),
      ],
      { aqi: [95, 10] },
    );

    const severities = result.map((f) => f.severity);
    expect(severities).toEqual(
      [...severities].sort((a, b) => (a === b ? 0 : a === 'warning' ? -1 : 1)),
    );
    expect(severities[0]).toBe('warning');

    // Within a severity, sample order — a reader going down the list is hiking forwards.
    const warnings = result.filter((f) => f.severity === 'warning').map((f) => f.sampleIndex ?? 0);
    expect(warnings).toEqual([...warnings].sort((a, b) => a - b));
  });
});
