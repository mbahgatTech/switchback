/**
 * Lifeline's derivations.
 *
 * Small functions, and every one of them is load-bearing for something a person will read
 * while worried. The tests are written against that: the interesting cases are not "does the
 * arithmetic work" but "what does this say at the moment it matters" — a hike one second
 * before its deadline, a hike that ended, a phone that has never sent anything at all.
 *
 * `now` is passed explicitly to every function under test. A safety feature whose behaviour
 * depends on the machine's clock zone is one that behaves differently in Seattle and in
 * Oslo, and these assertions would not catch it if they let the default through.
 */

import { describe, expect, it } from 'vitest';
import {
  LIFELINE_MESSAGE_MAX,
  LIFELINE_PING_INTERVAL_S,
  LIFELINE_PRESET_MINUTES,
  LIFELINE_STALE_PING_S,
  LIFELINE_STATUSES,
  LIFELINE_STATUS_LABELS,
  MAX_LIFELINE_MINUTES,
  MIN_LIFELINE_MINUTES,
  formatSpan,
  isLive,
  isStalePing,
  lifelineCreateSchema,
  lifelinePingSchema,
  overdueByS,
} from '../src/index';

const NOW = new Date('2026-07-18T15:00:00.000Z');
const minutesBefore = (m: number): Date => new Date(NOW.getTime() - m * 60_000);
const minutesAfter = (m: number): Date => new Date(NOW.getTime() + m * 60_000);

describe('overdueByS', () => {
  it('is zero for a hike that is still within its window', () => {
    expect(overdueByS(minutesAfter(45), NOW)).toBe(0);
  });

  it('is zero exactly on the deadline, not one', () => {
    // The boundary is the whole feature: this is the second the status flips, and being a
    // second early would tell somebody their partner is late while they are unlocking the car.
    expect(overdueByS(NOW, NOW)).toBe(0);
  });

  it('counts up from the deadline once it passes', () => {
    expect(overdueByS(minutesBefore(1), NOW)).toBe(60);
    expect(overdueByS(minutesBefore(95), NOW)).toBe(95 * 60);
  });

  it('never goes negative, however far in the future the return time is', () => {
    expect(overdueByS(minutesAfter(60 * 72), NOW)).toBe(0);
  });

  it('floors rather than rounds, so it never reports lateness that has not happened', () => {
    expect(overdueByS(new Date(NOW.getTime() - 900), NOW)).toBe(0);
    expect(overdueByS(new Date(NOW.getTime() - 1_900), NOW)).toBe(1);
  });
});

describe('isLive', () => {
  it('serves a position for a hike in progress, late or not', () => {
    expect(isLive('active')).toBe(true);
    expect(isLive('overdue')).toBe(true);
  });

  it('stops serving a position the moment the hike is over', () => {
    // The promise in `packages/core/src/lifeline.ts`: somebody given a link so they could stop
    // worrying on a Tuesday does not thereby acquire a standing feed of where that person hikes.
    expect(isLive('completed')).toBe(false);
    expect(isLive('cancelled')).toBe(false);
  });

  it('has an answer for every status there is', () => {
    for (const status of LIFELINE_STATUSES) {
      expect(typeof isLive(status)).toBe('boolean');
      expect(LIFELINE_STATUS_LABELS[status]).toBeTruthy();
    }
  });
});

describe('isStalePing', () => {
  it('treats a phone that has never reported as stale', () => {
    // Not "current with no position": a follow page that says the fix is fresh when there is
    // no fix would be the single most misleading thing this product could display.
    expect(isStalePing(null, NOW)).toBe(true);
  });

  it('calls a recent fix current', () => {
    expect(isStalePing(minutesBefore(1), NOW)).toBe(false);
    expect(isStalePing(minutesBefore(19), NOW)).toBe(false);
  });

  it('holds on right up to the threshold and gives up after it', () => {
    const exactly = new Date(NOW.getTime() - LIFELINE_STALE_PING_S * 1000);
    expect(isStalePing(exactly, NOW)).toBe(false);
    expect(isStalePing(new Date(exactly.getTime() - 1), NOW)).toBe(true);
  });

  it('survives several dropped pings before saying anything', () => {
    // The ratio that keeps the page calm: one lost fix in a valley must never read as lost
    // contact, so the threshold has to be several cadences wide.
    expect(LIFELINE_STALE_PING_S / LIFELINE_PING_INTERVAL_S).toBeGreaterThanOrEqual(4);
  });

  it('is not confused by a clock that runs backwards', () => {
    // Phone clocks correct themselves mid-hike. A fix stamped in the future is odd, but it is
    // certainly not old, and reporting it as stale would raise an alarm out of a time sync.
    expect(isStalePing(minutesAfter(5), NOW)).toBe(false);
  });
});

describe('formatSpan', () => {
  it('does not put a number on a span too small to matter', () => {
    expect(formatSpan(0)).toBe('less than a minute');
    expect(formatSpan(59)).toBe('less than a minute');
  });

  it('reads in minutes, then hours, then days', () => {
    expect(formatSpan(60)).toBe('1 min');
    expect(formatSpan(45 * 60)).toBe('45 min');
    expect(formatSpan(60 * 60)).toBe('1 h');
    expect(formatSpan(80 * 60)).toBe('1 h 20 min');
    expect(formatSpan(24 * 3_600)).toBe('1 day');
    expect(formatSpan(26 * 3_600)).toBe('1 day 2 h');
    expect(formatSpan(50 * 3_600)).toBe('2 days 2 h');
  });

  it('drops the zero rather than saying "1 h 0 min"', () => {
    expect(formatSpan(2 * 3_600)).toBe('2 h');
    expect(formatSpan(48 * 3_600)).toBe('2 days');
  });

  it('treats a negative span as none, since a countdown can cross zero mid-render', () => {
    expect(formatSpan(-90)).toBe('less than a minute');
  });

  it('says one day rather than 1 days', () => {
    expect(formatSpan(24 * 3_600)).not.toContain('days');
  });
});

describe('lifelineCreateSchema', () => {
  it('takes a name and a duration and nothing else is required', () => {
    const parsed = lifelineCreateSchema.parse({ contactName: 'Dave', minutes: 240 });
    expect(parsed.minutes).toBe(240);
    expect(parsed.contactName).toBe('Dave');
  });

  it('accepts every preset the interface offers', () => {
    // The buttons and the validator have to agree, or a preset silently fails to start.
    for (const minutes of LIFELINE_PRESET_MINUTES) {
      expect(() => lifelineCreateSchema.parse({ minutes })).not.toThrow();
    }
  });

  it('refuses a window so short the hiker is late before they park', () => {
    expect(() => lifelineCreateSchema.parse({ minutes: MIN_LIFELINE_MINUTES - 1 })).toThrow();
    expect(() => lifelineCreateSchema.parse({ minutes: MIN_LIFELINE_MINUTES })).not.toThrow();
  });

  it('refuses a window longer than the privacy ceiling', () => {
    expect(() => lifelineCreateSchema.parse({ minutes: MAX_LIFELINE_MINUTES + 1 })).toThrow();
    expect(() => lifelineCreateSchema.parse({ minutes: MAX_LIFELINE_MINUTES })).not.toThrow();
  });

  it('trims the name, because a trailing space is not a contact', () => {
    expect(lifelineCreateSchema.parse({ contactName: '  Mum  ', minutes: 120 }).contactName).toBe(
      'Mum',
    );
  });

  it('rejects a name that is only whitespace rather than storing an empty one', () => {
    expect(() => lifelineCreateSchema.parse({ contactName: '   ', minutes: 120 })).toThrow();
  });

  it('caps the message rather than truncating it silently', () => {
    const long = 'x'.repeat(LIFELINE_MESSAGE_MAX + 1);
    expect(() => lifelineCreateSchema.parse({ message: long, minutes: 120 })).toThrow();
  });

  it('will not take a fractional duration', () => {
    expect(() => lifelineCreateSchema.parse({ minutes: 120.5 })).toThrow();
  });
});

describe('lifelinePingSchema', () => {
  const base = { id: 'lls_1', lng: -121.49, lat: 48.02 };

  it('takes a bare position', () => {
    expect(lifelinePingSchema.parse(base).lat).toBeCloseTo(48.02, 6);
  });

  it('takes elevation and battery when the device knows them', () => {
    const parsed = lifelinePingSchema.parse({ ...base, eleM: 1_820, batteryPct: 41 });
    expect(parsed.eleM).toBe(1_820);
    expect(parsed.batteryPct).toBe(41);
  });

  it('refuses coordinates off the planet', () => {
    expect(() => lifelinePingSchema.parse({ ...base, lat: 91 })).toThrow();
    expect(() => lifelinePingSchema.parse({ ...base, lng: -181 })).toThrow();
  });

  it('refuses an elevation nobody can stand at', () => {
    // A barometric altimeter indoors will report absurdities, and one of them landing in the
    // database would put a hiker a kilometre underground on somebody's follow page.
    expect(() => lifelinePingSchema.parse({ ...base, eleM: -900 })).toThrow();
    expect(() => lifelinePingSchema.parse({ ...base, eleM: 12_000 })).toThrow();
  });

  it('refuses a battery percentage that is not one', () => {
    expect(() => lifelinePingSchema.parse({ ...base, batteryPct: 101 })).toThrow();
    expect(() => lifelinePingSchema.parse({ ...base, batteryPct: 0.4 })).toThrow();
  });
});
