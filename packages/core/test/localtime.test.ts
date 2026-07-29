/**
 * The vocabulary and the clock arithmetic both clients share.
 *
 * Two things are worth testing here and the rest is a lookup table. The first is that
 * `splitLocalIso` reads the offset the *server* wrote rather than the one the machine
 * running the test happens to sit in — every assertion below uses an offset that is not
 * this repo's CI timezone, so a `new Date(...).getHours()` creeping in would fail.
 *
 * The second is the round trip: `splitLocalIso` → `localIso` has to be lossless, because
 * that is the loop the start-time control runs on every interaction. If it drifts by an
 * hour the forecast quietly answers a different question than the one on screen.
 */

import { describe, expect, it } from 'vitest';
import {
  addDays,
  clockOf,
  compassPoint,
  dayOfWeekOf,
  formatDayLabel,
  formatHour,
  localDateAt,
  localIso,
  nextDateOn,
  offsetMinutes,
  splitLocalIso,
  weatherCodeLabel,
} from '../src/index';

describe('splitLocalIso', () => {
  it('reads the wall time and the offset the server wrote, not the local one', () => {
    expect(splitLocalIso('2026-07-27T07:00:00+02:00')).toEqual({
      date: '2026-07-27',
      time: '07:00',
      hour: 7,
      offset: '+02:00',
    });
  });

  it('handles UTC, negative offsets, and fractional seconds', () => {
    expect(splitLocalIso('2026-01-02T23:30:00Z')?.offset).toBe('Z');
    expect(splitLocalIso('2026-01-02T05:15:00-08:00')?.offset).toBe('-08:00');
    expect(splitLocalIso('2026-01-02T05:15:09.482-08:00')?.time).toBe('05:15');
  });

  it('returns null rather than a plausible-looking guess', () => {
    expect(splitLocalIso('2026-07-27')).toBeNull();
    // No offset means no trail-local wall time, which is the whole point of the type.
    expect(splitLocalIso('2026-07-27T07:00:00')).toBeNull();
    expect(clockOf(null)).toBeNull();
  });

  it('round-trips through localIso without drifting', () => {
    const original = '2026-07-27T07:00:00+05:45';
    const parts = splitLocalIso(original)!;
    expect(localIso(parts.date, parts.hour, parts.offset)).toBe(original);
  });
});

describe('addDays', () => {
  it('crosses months and years', () => {
    expect(addDays('2026-07-27', 6)).toBe('2026-08-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('is unaffected by a daylight-saving change in the middle of the span', () => {
    // Europe springs forward on 2026-03-29. Date-only arithmetic must not lose a day to it.
    expect(addDays('2026-03-27', 4)).toBe('2026-03-31');
  });
});

describe('weekdays', () => {
  it('counts from Sunday, matching the busyness week', () => {
    expect(dayOfWeekOf('2026-07-26')).toBe(0);
    expect(dayOfWeekOf('2026-07-27')).toBe(1);
  });

  it('finds the next occurrence of a weekday, counting today', () => {
    expect(nextDateOn('2026-07-26', 0)).toBe('2026-07-26');
    expect(nextDateOn('2026-07-26', 2)).toBe('2026-07-28');
    expect(nextDateOn('2026-07-28', 1)).toBe('2026-08-03');
  });

  it('labels a day the way a hike gets planned', () => {
    expect(formatDayLabel('2026-07-27')).toBe('Mon 27 Jul');
    expect(formatDayLabel('2026-01-05')).toBe('Mon 5 Jan');
    expect(formatHour(7)).toBe('07:00');
    expect(formatHour(23)).toBe('23:00');
  });
});

describe('localDateAt', () => {
  it('answers with the date at the trail, not the date on the machine asking', () => {
    // 23:30 UTC is already tomorrow in Kathmandu and still yesterday afternoon in Alaska.
    expect(localDateAt('2026-07-26T23:30:00.000Z', '+05:45')).toBe('2026-07-27');
    expect(localDateAt('2026-07-26T01:30:00.000Z', '-08:00')).toBe('2026-07-25');
    expect(localDateAt('2026-07-26T12:00:00.000Z', 'Z')).toBe('2026-07-26');
  });

  it('converts an offset to minutes, sign and all', () => {
    expect(offsetMinutes('Z')).toBe(0);
    expect(offsetMinutes('+02:00')).toBe(120);
    expect(offsetMinutes('-08:00')).toBe(-480);
    expect(offsetMinutes('+05:45')).toBe(345);
    expect(offsetMinutes('nonsense')).toBeNull();
  });

  it('refuses an unreadable instant rather than returning the epoch', () => {
    expect(localDateAt('not a date', '+02:00')).toBeNull();
    expect(localDateAt('2026-07-26T12:00:00.000Z', 'nonsense')).toBeNull();
  });
});

describe('weatherCodeLabel', () => {
  it('names the codes Open-Meteo actually emits', () => {
    expect(weatherCodeLabel(0)).toBe('Clear');
    expect(weatherCodeLabel(3)).toBe('Overcast');
    expect(weatherCodeLabel(65)).toBe('Heavy rain');
    expect(weatherCodeLabel(95)).toBe('Thunderstorm');
  });

  it('says nothing rather than inventing a sky', () => {
    expect(weatherCodeLabel(null)).toBeNull();
    expect(weatherCodeLabel(4)).toBeNull();
  });
});

describe('compassPoint', () => {
  it('reads the direction the wind comes from, to sixteen points', () => {
    expect(compassPoint(0)).toBe('N');
    expect(compassPoint(225)).toBe('SW');
    expect(compassPoint(315)).toBe('NW');
    expect(compassPoint(337.5)).toBe('NNW');
  });

  it('wraps past north instead of falling off the end of the table', () => {
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(360)).toBe('N');
    expect(compassPoint(-45)).toBe('NW');
    expect(compassPoint(720 + 90)).toBe('E');
  });

  it('has nothing to say about a missing reading', () => {
    expect(compassPoint(null)).toBeNull();
    expect(compassPoint(Number.NaN)).toBeNull();
  });
});
