import { describe, expect, it } from 'vitest';
import {
  DAY_S,
  HOUR_S,
  dayIndexFor,
  defaultStartEpochS,
  epochSecondsFrom,
  hourIndexFor,
  isoWithOffset,
} from '../src/time';

describe('isoWithOffset', () => {
  it('renders the instant in the trail’s local time, with the offset attached', () => {
    const noonUtc = Math.floor(Date.UTC(2026, 6, 20, 12, 0, 0) / 1000);
    expect(isoWithOffset(noonUtc, 3600)).toBe('2026-07-20T13:00:00+01:00');
    expect(isoWithOffset(noonUtc, 0)).toBe('2026-07-20T12:00:00+00:00');
    expect(isoWithOffset(noonUtc, -7 * HOUR_S)).toBe('2026-07-20T05:00:00-07:00');
  });

  it('handles half-hour and three-quarter-hour offsets', () => {
    const noonUtc = Math.floor(Date.UTC(2026, 6, 20, 12, 0, 0) / 1000);
    // Kathmandu, +05:45. A trail exists there and the string has to be right.
    expect(isoWithOffset(noonUtc, 5 * HOUR_S + 45 * 60)).toBe('2026-07-20T17:45:00+05:45');
    // Chatham Islands, -09:30 equivalent on the negative side.
    expect(isoWithOffset(noonUtc, -(9 * HOUR_S + 30 * 60))).toBe('2026-07-20T02:30:00-09:30');
  });

  it('does not depend on the host timezone', () => {
    // Same assertion as above, made explicit: the implementation reads only getUTC*, so a CI
    // runner in UTC and a laptop in Cardiff produce identical strings. If someone swaps in
    // getHours() this is the test that fails.
    const instant = Math.floor(Date.UTC(2026, 0, 1, 23, 30, 0) / 1000);
    expect(isoWithOffset(instant, 3600)).toBe('2026-01-02T00:30:00+01:00');
    expect(isoWithOffset(instant, -3600)).toBe('2026-01-01T22:30:00-01:00');
  });

  it('round-trips through Date.parse', () => {
    const instant = Math.floor(Date.UTC(2026, 6, 20, 6, 15, 30) / 1000);
    expect(epochSecondsFrom(isoWithOffset(instant, 5 * HOUR_S + 45 * 60))).toBe(instant);
  });
});

describe('epochSecondsFrom', () => {
  it('returns null rather than NaN on nonsense', () => {
    expect(epochSecondsFrom('not a date')).toBeNull();
    expect(epochSecondsFrom('')).toBeNull();
  });
});

describe('defaultStartEpochS', () => {
  const off = 3600;

  it('picks 07:00 local today when the day has not reached it', () => {
    const at5am = Math.floor(Date.UTC(2026, 6, 20, 4, 0, 0) / 1000); // 05:00 local
    expect(isoWithOffset(defaultStartEpochS(at5am, off), off)).toBe('2026-07-20T07:00:00+01:00');
  });

  it('rolls to tomorrow once 07:00 local has passed', () => {
    const at2pm = Math.floor(Date.UTC(2026, 6, 20, 13, 0, 0) / 1000); // 14:00 local
    expect(isoWithOffset(defaultStartEpochS(at2pm, off), off)).toBe('2026-07-21T07:00:00+01:00');
  });

  it('treats 07:00 exactly as already gone', () => {
    // Otherwise a request made at 07:00:00 plans a hike starting in zero seconds, which is
    // not what anyone means when they open a trail page.
    const at7 = Math.floor(Date.UTC(2026, 6, 20, 6, 0, 0) / 1000);
    expect(isoWithOffset(defaultStartEpochS(at7, off), off)).toBe('2026-07-21T07:00:00+01:00');
  });

  it('works either side of the international date line', () => {
    const instant = Math.floor(Date.UTC(2026, 6, 20, 12, 0, 0) / 1000);
    for (const offset of [-11 * HOUR_S, -7 * HOUR_S, 0, 3600, 9 * HOUR_S, 13 * HOUR_S]) {
      const start = defaultStartEpochS(instant, offset);
      expect(isoWithOffset(start, offset)).toMatch(/T07:00:00/);
      expect(start).toBeGreaterThan(instant);
      expect(start - instant).toBeLessThanOrEqual(DAY_S);
    }
  });
});

describe('hourIndexFor', () => {
  const base = Math.floor(Date.UTC(2026, 6, 20, 0, 0, 0) / 1000);
  const times = Array.from({ length: 24 }, (_, i) => base + i * HOUR_S);

  it('returns the slot covering the instant', () => {
    expect(hourIndexFor(times, base)).toBe(0);
    expect(hourIndexFor(times, base + 30 * 60)).toBe(0);
    expect(hourIndexFor(times, base + HOUR_S)).toBe(1);
    expect(hourIndexFor(times, base + 11 * HOUR_S + 59 * 60)).toBe(11);
  });

  it('covers the final hour to its end, then stops', () => {
    expect(hourIndexFor(times, base + 23 * HOUR_S)).toBe(23);
    expect(hourIndexFor(times, base + 23 * HOUR_S + 3599)).toBe(23);
    expect(hourIndexFor(times, base + 24 * HOUR_S)).toBeNull();
  });

  it('returns null before the window and on an empty series', () => {
    expect(hourIndexFor(times, base - 1)).toBeNull();
    expect(hourIndexFor([], base)).toBeNull();
  });

  it('agrees with a linear scan at every hour and half hour', () => {
    for (let i = 0; i < times.length; i++) {
      expect(hourIndexFor(times, times[i]!)).toBe(i);
      expect(hourIndexFor(times, times[i]! + 1800)).toBe(i);
    }
  });
});

describe('dayIndexFor', () => {
  const base = Math.floor(Date.UTC(2026, 6, 20, 0, 0, 0) / 1000);
  const days = Array.from({ length: 7 }, (_, i) => base + i * DAY_S);

  it('finds the day containing the instant', () => {
    expect(dayIndexFor(days, base + 8 * HOUR_S)).toBe(0);
    expect(dayIndexFor(days, base + DAY_S)).toBe(1);
    expect(dayIndexFor(days, base + 6 * DAY_S + 23 * HOUR_S)).toBe(6);
  });

  it('returns null outside the range', () => {
    expect(dayIndexFor(days, base - 1)).toBeNull();
    expect(dayIndexFor(days, base + 7 * DAY_S)).toBeNull();
  });
});
