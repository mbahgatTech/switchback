import { busynessForecastSchema, type BusynessDay } from '@switchback/core';
import { describe, expect, it } from 'vitest';
import type { DaylightWindow } from '../src/daylight';
import {
  MODEL_PROVIDER,
  WEATHER_PENALTY,
  busynessForecast,
  peakLevelFrom,
  quietestDaylightHour,
  recommend,
  type BusynessInput,
} from '../src/forecast';
import type { ObservationBucket } from '../src/observe';
import type { DayWeather } from '../src/weather';

const JUNE = Date.UTC(2026, 5, 21, 9, 0, 0);
const DECEMBER = Date.UTC(2026, 11, 21, 9, 0, 0);

const BEN_NEVIS: BusynessInput = {
  trailId: 'trail-1',
  timezone: 'Europe/London',
  latDeg: 56.7969,
  lngDeg: -5.0036,
  utcOffsetS: 3600,
  nowMs: JUNE,
  estimatedTimeS: 6 * 3600,
};

const FAIR: DayWeather = { precipitationProbability: 5, temperatureMaxC: 18, windGustsMaxKmh: 12 };
const SOAKED: DayWeather = {
  precipitationProbability: 100,
  precipitationMm: 22,
  temperatureMaxC: 4,
  windGustsMaxKmh: 80,
};

function peakScore(day: BusynessDay): number {
  return Math.max(...day.hours.map((h) => h.score));
}

describe('busynessForecast', () => {
  it('satisfies the published contract', () => {
    // The schema is the API's output type. If this drifts, both clients break at runtime
    // rather than at compile time, which is the worst possible place to find out.
    expect(() => busynessForecastSchema.parse(busynessForecast(BEN_NEVIS))).not.toThrow();
  });

  it('returns a full week of labelled hours', () => {
    const forecast = busynessForecast(BEN_NEVIS);
    expect(forecast.week).toHaveLength(7);
    forecast.week.forEach((day, index) => {
      expect(day.dayOfWeek).toBe(index);
      expect(day.hours).toHaveLength(24);
      day.hours.forEach((hour, h) => {
        expect(hour.hour).toBe(h);
        expect(hour.score).toBeGreaterThanOrEqual(0);
        expect(hour.score).toBeLessThanOrEqual(100);
      });
    });
  });

  it('normalises to this trail’s own peak, so the busiest hour is exactly 100', () => {
    const forecast = busynessForecast(BEN_NEVIS);
    expect(Math.max(...forecast.week.map(peakScore))).toBe(100);
  });

  it('peaks on Saturday and puts every day’s peak in daylight', () => {
    const forecast = busynessForecast(BEN_NEVIS);
    expect(peakScore(forecast.week[6]!)).toBeGreaterThan(peakScore(forecast.week[2]!));
    for (const day of forecast.week) {
      expect(day.peakHour).toBeGreaterThan(5);
      expect(day.peakHour).toBeLessThan(21);
    }
  });

  it('says plainly that it is modelled until it is not', () => {
    const modelled = busynessForecast(BEN_NEVIS);
    expect(modelled.confidence).toBe('modeled');
    expect(modelled.observationCount).toBe(0);
    expect(modelled.provider).toBe(MODEL_PROVIDER);

    const buckets: ObservationBucket[] = [
      { dayOfWeek: 6, hour: 9, observed: 40, sampleCount: 150 },
      { dayOfWeek: 0, hour: 10, observed: 30, sampleCount: 90 },
    ];
    const observed = busynessForecast({ ...BEN_NEVIS, buckets });
    expect(observed.observationCount).toBe(240);
    expect(observed.confidence).toBe('high');
  });

  it('lets recorded starts move the peak off the modelled hour', () => {
    const buckets: ObservationBucket[] = Array.from({ length: 24 }, (_, hour) => ({
      dayOfWeek: 6,
      hour,
      observed: hour === 16 ? 100 : 1,
      sampleCount: 400,
    }));
    const forecast = busynessForecast({ ...BEN_NEVIS, buckets });
    expect(forecast.week[6]!.peakHour).toBe(16);
  });

  it('reports whether weather was folded in', () => {
    expect(busynessForecast(BEN_NEVIS).weatherAdjusted).toBe(false);
    expect(busynessForecast({ ...BEN_NEVIS, weather: new Map() }).weatherAdjusted).toBe(false);
    expect(busynessForecast({ ...BEN_NEVIS, weather: new Map([[6, FAIR]]) }).weatherAdjusted).toBe(
      true,
    );
  });

  it('moves the crowd off a washed-out Saturday', () => {
    const weather = new Map<number, DayWeather>([
      [6, SOAKED],
      [0, FAIR],
    ]);
    const dry = busynessForecast(BEN_NEVIS);
    const wet = busynessForecast({ ...BEN_NEVIS, weather });

    expect(peakScore(dry.week[6]!)).toBeGreaterThan(peakScore(dry.week[0]!));
    expect(peakScore(wet.week[6]!)).toBeLessThan(peakScore(wet.week[0]!));
  });

  it('does not recommend the wettest day just because it is empty', () => {
    // The trap this whole cost function exists for: rain lowers the score, so the
    // quietest hour of the week is on the day nobody would want to be out.
    const weather = new Map<number, DayWeather>([
      [0, SOAKED],
      [1, FAIR],
      [2, FAIR],
      [3, FAIR],
      [4, FAIR],
      [5, FAIR],
      [6, FAIR],
    ]);
    const forecast = busynessForecast({ ...BEN_NEVIS, weather });
    expect(forecast.recommendation).not.toBeNull();
    expect(forecast.recommendation!.dayOfWeek).not.toBe(0);
  });

  it('recommends a start that is light enough to set off and finish', () => {
    const winter = busynessForecast({ ...BEN_NEVIS, nowMs: DECEMBER, estimatedTimeS: 4 * 3600 });
    const recommendation = winter.recommendation!;
    expect(recommendation).not.toBeNull();
    // Fort William in December: light from about 09:00 to 15:30. A four-hour hike has one
    // sensible start window, and "07:00, it'll be quiet" is not in it.
    expect(recommendation.hour).toBeGreaterThanOrEqual(8);
    expect(recommendation.hour).toBeLessThanOrEqual(11);
    expect(recommendation.reason.length).toBeGreaterThan(0);
  });

  it('withholds an absolute crowding claim about a trail it knows nothing about', () => {
    expect(busynessForecast(BEN_NEVIS).peakLevel).toBeNull();
    expect(busynessForecast({ ...BEN_NEVIS, signals: { popularity: 3000 } }).peakLevel).toBe(
      'packed',
    );
  });

  it('stamps when it was computed', () => {
    expect(busynessForecast(BEN_NEVIS).computedAt).toBe(new Date(JUNE).toISOString());
    expect(busynessForecast(BEN_NEVIS).trailId).toBe('trail-1');
    expect(busynessForecast({ ...BEN_NEVIS, timezone: undefined }).timezone).toBe('UTC');
  });

  it('survives a polar winter without producing nonsense', () => {
    const forecast = busynessForecast({
      ...BEN_NEVIS,
      latDeg: 78.2,
      lngDeg: 15.6,
      nowMs: DECEMBER,
    });
    expect(() => busynessForecastSchema.parse(forecast)).not.toThrow();
    // Nothing to recommend when the sun does not rise, and saying so is better than
    // inventing a daylight start that does not exist.
    expect(forecast.recommendation).toBeNull();
  });
});

describe('recommend', () => {
  const window: DaylightWindow = {
    sunriseHour: 8,
    sunsetHour: 16,
    daylightHours: 8,
    solarNoonHour: 12,
    polarDay: false,
    polarNight: false,
  };

  function week(scoreFor: (dayOfWeek: number) => number): BusynessDay[] {
    return Array.from({ length: 7 }, (_, dayOfWeek) => ({
      dayOfWeek,
      hours: Array.from({ length: 24 }, (_, hour) => ({
        hour,
        score: scoreFor(dayOfWeek),
        level: 'quiet' as const,
      })),
      peakHour: 12,
      quietestHour: 3,
    }));
  }

  const NEUTRAL = [1, 1, 1, 1, 1, 1, 1];

  it('picks the genuinely quiet day when the weather is the same everywhere', () => {
    const result = recommend(
      week((d) => (d === 0 ? 20 : 40)),
      window,
      NEUTRAL,
      6 * 3600,
      false,
    );
    expect(result!.dayOfWeek).toBe(0);
  });

  it('refuses the same day once the reason it is quiet is rain', () => {
    const soaked = [0.35, 1, 1, 1, 1, 1, 1];
    const result = recommend(
      week((d) => (d === 0 ? 20 : 40)),
      window,
      soaked,
      6 * 3600,
      true,
    );

    // 20 + 55 × 0.65 = 55.75 against 40. The penalty is what stops the model telling you
    // to climb a mountain in a storm because you would have it to yourself.
    expect(WEATHER_PENALTY * (1 - 0.35)).toBeGreaterThan(40 - 20);
    expect(result!.dayOfWeek).not.toBe(0);
  });

  it('only offers starts that fit inside the daylight', () => {
    const result = recommend(
      week(() => 40),
      window,
      NEUTRAL,
      6 * 3600,
      false,
    )!;
    expect(result.hour + 0.5).toBeGreaterThanOrEqual(window.sunriseHour);
    expect(result.hour + 0.5 + 6).toBeLessThanOrEqual(window.sunsetHour);
  });

  it('says so rather than nothing when the hike cannot fit in the day', () => {
    const result = recommend(
      week(() => 40),
      window,
      NEUTRAL,
      12 * 3600,
      false,
    )!;
    expect(result.hour + 0.5).toBeGreaterThanOrEqual(window.sunriseHour);
    expect(result.hour + 0.5).toBeLessThanOrEqual(window.sunsetHour);
    expect(result.reason).toMatch(/light will go/);
  });

  it('has nothing to say during a polar night', () => {
    const polar: DaylightWindow = {
      sunriseHour: 12,
      sunsetHour: 12,
      daylightHours: 0,
      solarNoonHour: 12,
      polarNight: true,
      polarDay: false,
    };
    expect(
      recommend(
        week(() => 40),
        polar,
        NEUTRAL,
        3600,
        false,
      ),
    ).toBeNull();
  });

  it('credits the weather when the weather is why', () => {
    const factors = [1, 1, 1, 1, 1, 1, 1.12];
    const result = recommend(
      week((d) => (d === 6 ? 30 : 40)),
      window,
      factors,
      3600,
      true,
    )!;
    expect(result.dayOfWeek).toBe(6);
    expect(result.reason).toMatch(/weather/);
  });
});

describe('quietestDaylightHour', () => {
  const window: DaylightWindow = {
    sunriseHour: 8,
    sunsetHour: 16,
    daylightHours: 8,
    solarNoonHour: 12,
    polarDay: false,
    polarNight: false,
  };

  it('ignores the small hours, which are quietest on every trail on earth', () => {
    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      score: hour === 3 ? 0 : hour === 11 ? 5 : 50,
      level: 'quiet' as const,
    }));
    expect(quietestDaylightHour(hours, window)).toBe(11);
  });
});

describe('peakLevelFrom', () => {
  it('distinguishes “we do not know” from “nobody goes”', () => {
    expect(peakLevelFrom(0, 0)).toBeNull();
    expect(peakLevelFrom(0.05, 0)).toBe('quiet');
    expect(peakLevelFrom(0, 4)).toBe('quiet');
  });

  it('spreads trails across all four steps rather than calling them all packed', () => {
    expect(peakLevelFrom(0.3, 0)).toBe('quiet');
    expect(peakLevelFrom(0.55, 0)).toBe('moderate');
    expect(peakLevelFrom(0.8, 0)).toBe('busy');
    expect(peakLevelFrom(1, 0)).toBe('packed');
  });

  it('takes the stronger of modelled and recorded evidence', () => {
    expect(peakLevelFrom(0.1, 5000)).toBe('packed');
  });
});
