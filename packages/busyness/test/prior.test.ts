import { describe, expect, it } from 'vitest';
import { daylightWindow } from '../src/daylight';
import {
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  WEEKEND_BUMPS,
  contrastExponent,
  crowdingFrom,
  daylightGate,
  demandEvidence,
  hourShape,
  maxOf,
  priorSurface,
  saturate,
  type TrailSignals,
} from '../src/prior';

const BEN_NEVIS = { latDeg: 56.7969, lngDeg: -5.0036, utcOffsetS: 3600 };
const MIDSUMMER = 172;
const MIDWINTER = 355;

function surface(dayOfYear: number, signals?: TrailSignals) {
  return priorSurface(signals ? { ...BEN_NEVIS, dayOfYear, signals } : { ...BEN_NEVIS, dayOfYear });
}

/** Hours above a fraction of the weekly peak — a proxy for how spread out the curve is. */
function hoursAbove(demand: readonly (readonly number[])[], fraction: number, day: number): number {
  const peak = maxOf(demand);
  return (demand[day] ?? []).filter((value) => value > fraction * peak).length;
}

function peakHourOf(demand: readonly (readonly number[])[], day: number): number {
  const row = demand[day] ?? [];
  let best = 0;
  for (let i = 1; i < row.length; i++) if ((row[i] ?? 0) > (row[best] ?? 0)) best = i;
  return best;
}

describe('priorSurface', () => {
  it('fills a full week of hours with finite, non-negative demand', () => {
    const { demand } = surface(MIDSUMMER);
    expect(demand).toHaveLength(DAYS_PER_WEEK);
    for (const day of demand) {
      expect(day).toHaveLength(HOURS_PER_DAY);
      for (const value of day) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('peaks on Saturday, troughs midweek', () => {
    const { demand } = surface(MIDSUMMER);
    const peakOf = (day: number) => Math.max(...(demand[day] ?? []));
    expect(peakOf(6)).toBeGreaterThan(peakOf(2));
    expect(peakOf(0)).toBeGreaterThan(peakOf(2));
    expect(peakOf(5)).toBeGreaterThan(peakOf(3));
  });

  it('puts the busiest hour of every day in daylight', () => {
    const { demand, daylight } = surface(MIDSUMMER);
    for (let day = 0; day < DAYS_PER_WEEK; day++) {
      const hour = peakHourOf(demand, day) + 0.5;
      expect(hour).toBeGreaterThan(daylight.sunriseHour);
      expect(hour).toBeLessThan(daylight.sunsetHour);
    }
  });

  it('compresses the day in winter without being told about seasons', () => {
    // The whole seasonal argument in one assertion: nothing in this package knows what
    // December is. Anchoring the bumps to sunrise and sunset is what makes the winter
    // curve narrow, and it lands the peaks in the middle of a six-hour day rather than
    // leaving a "14:00 afternoon peak" sitting in the dark.
    const summer = surface(MIDSUMMER);
    const winter = surface(MIDWINTER);

    expect(hoursAbove(winter.demand, 0.25, 6)).toBeLessThan(hoursAbove(summer.demand, 0.25, 6));
    expect(winter.daylight.daylightHours).toBeLessThan(summer.daylight.daylightHours);

    const winterPeak = peakHourOf(winter.demand, 6) + 0.5;
    expect(winterPeak).toBeGreaterThan(winter.daylight.sunriseHour);
    expect(winterPeak).toBeLessThan(winter.daylight.sunsetHour);
  });

  it('is quietest at night, and never exactly zero', () => {
    const { demand } = surface(MIDSUMMER);
    const saturday = demand[6]!;
    expect(saturday[2]!).toBeLessThan(saturday[peakHourOf(demand, 6)]! * 0.1);
    expect(saturday[2]!).toBeGreaterThan(0);
  });

  it('flattens the weekly contrast as a trail becomes well known', () => {
    // An obscure trail is a weekend trail; a famous one is busy on a Tuesday too. This is
    // the only channel popularity has, because a popularity *multiplier* would divide
    // straight back out at normalisation and change nothing at all.
    const obscure = surface(MIDSUMMER, { popularity: 0 });
    const famous = surface(MIDSUMMER, { popularity: 4000 });

    const ratio = (s: ReturnType<typeof surface>) =>
      Math.max(...(s.demand[6] ?? [])) / Math.max(...(s.demand[2] ?? []));

    expect(ratio(obscure)).toBeGreaterThan(4);
    expect(ratio(famous)).toBeLessThan(ratio(obscure) / 2);
  });

  it('leaves the curve alone when there is no parking tag', () => {
    // 649 of our 657 trails have no capacity. The missing-tag path is the normal path.
    const withTag = surface(MIDSUMMER, { popularity: 4000, parkingCapacity: null });
    const without = surface(MIDSUMMER, { popularity: 4000 });
    expect(withTag.demand).toEqual(without.demand);
  });

  it('broadens the peak when the car park cannot hold the crowd', () => {
    const roomy = surface(MIDSUMMER, { popularity: 5000 });
    const tiny = surface(MIDSUMMER, { popularity: 5000, parkingCapacity: 12 });

    // Same crowding score either way — 5000 pins it at the ceiling — so the only thing
    // that has changed is the shape.
    expect(tiny.crowding).toBe(roomy.crowding);
    expect(hoursAbove(tiny.demand, 0.6, 6)).toBeGreaterThan(hoursAbove(roomy.demand, 0.6, 6));
  });

  it('produces a flat, finite curve through a polar night', () => {
    const polar = priorSurface({
      latDeg: 78.2,
      lngDeg: 15.6,
      utcOffsetS: 3600,
      dayOfYear: MIDWINTER,
    });
    expect(polar.daylight.polarNight).toBe(true);
    for (const day of polar.demand) {
      for (const value of day) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    }
    expect(maxOf(polar.demand)).toBeGreaterThan(0);
  });
});

describe('demandEvidence and crowdingFrom', () => {
  it('counts photographs, because a cold corpus has nothing else', () => {
    // `popularity` is 0 on every freshly ingested trail, so it cannot carry the estimate
    // alone. Commons and Mapillary photo counts arrive with the trail.
    expect(demandEvidence({ photoCount: 40 })).toBe(80);
    expect(crowdingFrom({ photoCount: 40 })).toBeGreaterThan(0.5);
    expect(crowdingFrom({ popularity: 0, photoCount: 0 })).toBe(0);
  });

  it('is logarithmic, so the busy end does not swallow the range', () => {
    const small = crowdingFrom({ popularity: 20 });
    const medium = crowdingFrom({ popularity: 200 });
    const large = crowdingFrom({ popularity: 2000 });

    expect(small).toBeLessThan(medium);
    expect(medium).toBeLessThan(large);
    expect(large).toBeLessThanOrEqual(1);
    // The first hundred hikers say more than the next nineteen hundred.
    expect(medium - small).toBeGreaterThan(large - medium);
  });

  it('ignores negative counts rather than trusting them', () => {
    expect(demandEvidence({ popularity: -5, reviewCount: -1 })).toBe(0);
    expect(crowdingFrom({ popularity: -5 })).toBe(0);
  });
});

describe('contrastExponent', () => {
  it('falls monotonically with crowding, and stays above one for unknown trails', () => {
    expect(contrastExponent(0)).toBeGreaterThan(1);
    expect(contrastExponent(1)).toBeLessThan(1);
    expect(contrastExponent(0.5)).toBeLessThan(contrastExponent(0));
    expect(contrastExponent(2)).toBe(contrastExponent(1));
  });
});

describe('hourShape', () => {
  const window = daylightWindow(56.7969, MIDSUMMER, { lngDeg: -5.0036, utcOffsetS: 3600 });

  it('places its bumps by fraction of daylight, not by clock time', () => {
    const at = (fraction: number) =>
      hourShape(window.sunriseHour + fraction * window.daylightHours, window, WEEKEND_BUMPS);

    expect(at(WEEKEND_BUMPS[0]!.at)).toBeGreaterThan(at(0.9));
    expect(at(WEEKEND_BUMPS[0]!.at)).toBeGreaterThan(at(0.05));
  });

  it('returns zero rather than NaN when there is no daylight to divide by', () => {
    const polar = daylightWindow(78.2, MIDWINTER, { lngDeg: 15.6, utcOffsetS: 3600 });
    expect(hourShape(12, polar, WEEKEND_BUMPS)).toBe(0);
  });
});

describe('daylightGate', () => {
  const window = daylightWindow(56.7969, MIDSUMMER, { lngDeg: -5.0036, utcOffsetS: 3600 });

  it('ramps rather than steps', () => {
    expect(daylightGate(window.sunriseHour, window)).toBeCloseTo(0.5, 1);
    expect(daylightGate(window.sunsetHour, window)).toBeCloseTo(0.5, 1);
    expect(daylightGate(window.sunriseHour - 3, window)).toBeLessThan(0.1);
    expect(daylightGate(window.solarNoonHour, window)).toBeGreaterThan(0.95);
  });

  it('is fully open through a polar day and shut through a polar night', () => {
    const day = daylightWindow(78.2, MIDSUMMER, { lngDeg: 15.6, utcOffsetS: 3600 });
    const night = daylightWindow(78.2, MIDWINTER, { lngDeg: 15.6, utcOffsetS: 3600 });
    expect(daylightGate(3, day)).toBe(1);
    expect(daylightGate(12, night)).toBe(0);
  });
});

describe('saturate', () => {
  const flat = [[1, 2, 4, 8]];

  it('is the identity with no capacity', () => {
    expect(saturate(flat, null, 0.9)).toEqual(flat);
    expect(saturate(flat, 0, 0.9)).toEqual(flat);
    expect(saturate(flat, Number.NaN, 0.9)).toEqual(flat);
  });

  it('compresses the tall values more than the short ones', () => {
    const [row] = saturate(flat, 5, 1);
    const ratio = (a: number, b: number) => a / b;
    expect(ratio(row![3]!, row![0]!)).toBeLessThan(ratio(8, 1));
    expect(row!.every((v, i) => i === 0 || v > row![i - 1]!)).toBe(true);
  });

  it('does not divide by an all-zero surface', () => {
    expect(saturate([[0, 0]], 10, 1)).toEqual([[0, 0]]);
  });
});
