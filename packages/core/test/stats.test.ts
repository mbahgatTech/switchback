import { describe, expect, it } from 'vitest';
import { CADENCE_MONTHS, cadenceMonths, fillCadence, monthKey, monthLabel } from '../src/stats';

describe('monthKey', () => {
  it('pads the month and reads the date in UTC', () => {
    expect(monthKey(new Date('2026-01-04T00:00:00Z'))).toBe('2026-01');
    expect(monthKey(new Date('2026-11-30T23:59:00Z'))).toBe('2026-11');
  });
});

describe('cadenceMonths', () => {
  it('ends at the current month and runs oldest first', () => {
    const months = cadenceMonths(new Date('2026-07-27T12:00:00Z'));
    expect(months).toHaveLength(CADENCE_MONTHS);
    expect(months.at(-1)).toBe('2026-07');
    expect(months[0]).toBe('2025-07');
  });

  it('crosses the year boundary without landing in month zero', () => {
    // The naive `month - 1` version produces "2026-00" here, and January is the one month
    // nobody is looking at the strip in.
    const months = cadenceMonths(new Date('2026-01-15T00:00:00Z'), 3);
    expect(months).toEqual(['2025-11', '2025-12', '2026-01']);
  });

  it('puts the same month at both ends, a year apart', () => {
    const months = cadenceMonths(new Date('2026-07-01T00:00:00Z'));
    expect(months[0]?.slice(5)).toBe(months.at(-1)?.slice(5));
  });

  it('does not roll a 31st into the next month', () => {
    // `setUTCMonth(-1)` on 31 March gives 3 March, and every later step is then off by a
    // month. Anchoring the cursor to the first is what prevents it.
    expect(cadenceMonths(new Date('2026-03-31T00:00:00Z'), 2)).toEqual(['2026-02', '2026-03']);
  });
});

describe('fillCadence', () => {
  const present = new Map([['2026-07', { hikes: 3, lengthM: 24_000, gainM: 1_800 }]]);

  it('keeps months nobody hiked in, as zeroes', () => {
    const months = fillCadence(present, new Date('2026-07-27T00:00:00Z'), 3);
    expect(months).toEqual([
      { month: '2026-05', hikes: 0, lengthM: 0, gainM: 0 },
      { month: '2026-06', hikes: 0, lengthM: 0, gainM: 0 },
      { month: '2026-07', hikes: 3, lengthM: 24_000, gainM: 1_800 },
    ]);
  });

  it('ignores months outside the window', () => {
    const stale = new Map([['2019-04', { hikes: 9, lengthM: 1, gainM: 1 }]]);
    const months = fillCadence(stale, new Date('2026-07-27T00:00:00Z'), 2);
    expect(months.every((month) => month.hikes === 0)).toBe(true);
  });
});

describe('monthLabel', () => {
  it('prints the year only where it changes', () => {
    expect(monthLabel('2025-07')).toBe('Jul ’25');
    expect(monthLabel('2025-08', '2025-07')).toBe('Aug');
    expect(monthLabel('2026-01', '2025-12')).toBe('Jan ’26');
  });

  it('carries at most two years across a full strip', () => {
    const months = cadenceMonths(new Date('2026-07-27T00:00:00Z'));
    const labelled = months.map((month, index) => monthLabel(month, months[index - 1]));
    expect(labelled.filter((label) => label.includes('’'))).toHaveLength(2);
  });
});
