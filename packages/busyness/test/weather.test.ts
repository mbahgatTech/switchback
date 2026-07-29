import { describe, expect, it } from 'vitest';
import {
  COMFORT_HIGH_C,
  COMFORT_LOW_C,
  MIN_WEATHER_FACTOR,
  comfortFactor,
  weatherFactor,
  weatherFactorsByDay,
  type DayWeather,
} from '../src/weather';

const FAIR: DayWeather = {
  precipitationProbability: 5,
  precipitationMm: 0,
  temperatureMaxC: 18,
  windGustsMaxKmh: 15,
};

describe('weatherFactor', () => {
  it('is neutral when there is no forecast', () => {
    expect(weatherFactor(null)).toBe(1);
    expect(weatherFactor(undefined)).toBe(1);
    expect(weatherFactor({})).toBe(1);
  });

  it('rewards a clear, mild day above neutral', () => {
    // A model capped at 1 could only ever punish, and would have nothing to say about the
    // one genuinely good Saturday in a fortnight.
    expect(weatherFactor(FAIR)).toBeGreaterThan(1);
  });

  it('suppresses rain in proportion to the probability', () => {
    const dry = weatherFactor({ ...FAIR, precipitationProbability: 0 });
    const half = weatherFactor({ ...FAIR, precipitationProbability: 50 });
    const soaked = weatherFactor({ ...FAIR, precipitationProbability: 100 });

    expect(half).toBeLessThan(dry);
    expect(soaked).toBeLessThan(half);
    // Smooth, so a one-point forecast revision cannot flip the recommendation.
    expect(Math.abs(weatherFactor({ ...FAIR, precipitationProbability: 51 }) - half)).toBeLessThan(
      0.01,
    );
  });

  it('treats a downpour as worse than drizzle at the same probability', () => {
    const drizzle = weatherFactor({ ...FAIR, precipitationProbability: 90, precipitationMm: 0.4 });
    const downpour = weatherFactor({ ...FAIR, precipitationProbability: 90, precipitationMm: 20 });
    expect(downpour).toBeLessThan(drizzle);
  });

  it('ignores wind until it is worth ignoring a hill for', () => {
    const breezy = weatherFactor({ ...FAIR, windGustsMaxKmh: 30 });
    const blowy = weatherFactor({ ...FAIR, windGustsMaxKmh: 40 });
    const severe = weatherFactor({ ...FAIR, windGustsMaxKmh: 85 });

    expect(blowy).toBe(breezy);
    expect(severe).toBeLessThan(blowy);
  });

  it('never falls further than the floor', () => {
    const worst = weatherFactor({
      precipitationProbability: 100,
      precipitationMm: 60,
      temperatureMaxC: -12,
      windGustsMaxKmh: 130,
    });
    expect(worst).toBeGreaterThanOrEqual(MIN_WEATHER_FACTOR);
    // Weather reshuffles a week; it does not empty one. Somebody always goes.
    expect(worst).toBeGreaterThan(0.3);
  });

  it('reads a missing field as unknown rather than zero', () => {
    // A `null` precipitation is "we don't know", and treating it as 0 mm would quietly
    // promote every gap in the forecast to a perfect day.
    expect(weatherFactor({ precipitationProbability: null, temperatureMaxC: 18 })).toBe(
      weatherFactor({ temperatureMaxC: 18 }),
    );
    expect(weatherFactor({ temperatureMaxC: Number.NaN })).toBe(1);
  });
});

describe('comfortFactor', () => {
  it('is flat across the comfortable band', () => {
    expect(comfortFactor(COMFORT_LOW_C)).toBe(comfortFactor(COMFORT_HIGH_C));
    expect(comfortFactor(18)).toBe(comfortFactor(COMFORT_LOW_C));
  });

  it('falls away at both ends, and faster in the heat', () => {
    expect(comfortFactor(0)).toBeLessThan(comfortFactor(10));
    expect(comfortFactor(33)).toBeLessThan(comfortFactor(26));
    // Ten degrees below comfortable is a jacket; ten above is a reason to stay in.
    expect(comfortFactor(COMFORT_LOW_C - 10)).toBeGreaterThan(comfortFactor(COMFORT_HIGH_C + 10));
  });
});

describe('weatherFactorsByDay', () => {
  it('is all neutral without a forecast', () => {
    expect(weatherFactorsByDay(null)).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it('leaves days the forecast does not reach at neutral', () => {
    // No weather is not bad weather. A five-day forecast must not make the sixth day look
    // like the best in the week purely by not being mentioned.
    const factors = weatherFactorsByDay(new Map([[6, { precipitationProbability: 95 }]]));
    expect(factors[6]!).toBeLessThan(1);
    expect(factors.filter((f) => f === 1)).toHaveLength(6);
  });

  it('ignores a day index that is not a day', () => {
    const factors = weatherFactorsByDay(new Map([[7, { precipitationProbability: 95 }]]));
    expect(factors).toEqual([1, 1, 1, 1, 1, 1, 1]);
  });
});
