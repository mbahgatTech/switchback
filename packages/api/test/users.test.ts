import { describe, expect, it } from 'vitest';
import { CADENCE_MONTHS } from '@switchback/core';
import type { StatsRows } from '../src/routers/users';
import { shapeStats } from '../src/routers/users';

const NOW = new Date('2026-07-27T00:00:00Z');

function rows(over: Partial<StatsRows> = {}): StatsRows {
  return {
    totals: [
      {
        hikes: 4,
        trails: 3,
        lengthM: 48_200.000000004,
        gainM: 3_140.7,
        estimatedTimeS: 61_200,
        firstHike: new Date('2025-09-14T00:00:00Z'),
        lastHike: new Date('2026-07-04T00:00:00Z'),
      },
    ],
    records: [
      {
        kind: 'longest',
        trailId: 't1',
        trailName: 'Cwm Idwal',
        trailSlug: 'cwm-idwal',
        completedAt: new Date('2026-03-02T00:00:00Z'),
        valueM: 18_400,
      },
      {
        kind: 'steepest',
        trailId: 't2',
        trailName: 'Tryfan north ridge',
        trailSlug: 'tryfan-north-ridge',
        completedAt: new Date('2025-09-14T00:00:00Z'),
        valueM: 910,
      },
      {
        kind: 'highest',
        trailId: 't2',
        trailName: 'Tryfan north ridge',
        trailSlug: 'tryfan-north-ridge',
        completedAt: new Date('2025-09-14T00:00:00Z'),
        valueM: 917.6,
      },
    ],
    months: [
      { month: '2026-03', hikes: 1, lengthM: 18_400, gainM: 620 },
      { month: '2026-07', hikes: 2, lengthM: 19_800, gainM: 1_610 },
    ],
    regions: [
      { region: 'Gwynedd', hikes: 3, lengthM: 40_100.2 },
      { region: null, hikes: 1, lengthM: 8_100 },
    ],
    reviews: 2,
    photos: 7,
    now: NOW,
    ...over,
  };
}

describe('shapeStats totals', () => {
  it('rounds the float tail a SUM over many hikes carries', () => {
    const stats = shapeStats(rows());
    expect(stats.lengthM).toBe(48_200);
    expect(stats.gainM).toBe(3_141);
  });

  it('counts hikes and distinct trails separately', () => {
    const stats = shapeStats(rows());
    expect(stats.hikes).toBe(4);
    expect(stats.trails).toBe(3);
  });

  it('gives dates as YYYY-MM-DD rather than timestamps', () => {
    const stats = shapeStats(rows());
    expect(stats.firstHike).toBe('2025-09-14');
    expect(stats.lastHike).toBe('2026-07-04');
  });

  it('reads as a clean zero when nobody has hiked anything', () => {
    const stats = shapeStats(
      rows({ totals: [], records: [], months: [], regions: [], reviews: 0, photos: 0 }),
    );
    expect(stats.hikes).toBe(0);
    expect(stats.lengthM).toBe(0);
    expect(stats.firstHike).toBeNull();
    expect(stats.longest).toBeNull();
    // The strip is still drawn — thirteen empty months is a true statement about a new
    // account, and an empty array would collapse the graphic instead of showing it.
    expect(stats.months).toHaveLength(CADENCE_MONTHS);
  });
});

describe('shapeStats records', () => {
  it('carries the slug so a record can be clicked back to its trail', () => {
    expect(shapeStats(rows()).longest).toEqual({
      trailId: 't1',
      trailName: 'Cwm Idwal',
      trailSlug: 'cwm-idwal',
      completedAt: '2026-03-02',
      valueM: 18_400,
    });
  });

  it('drops a record whose measurement the ingest never produced', () => {
    // A trail with no summit elevation must not print "highest point: 0 m", which is a
    // claim nobody made.
    const withNull = rows().records.map((record) =>
      record.kind === 'highest' ? { ...record, valueM: null } : record,
    );
    const stats = shapeStats(rows({ records: withNull }));
    expect(stats.highest).toBeNull();
    expect(stats.steepest).not.toBeNull();
  });

  it('leaves a record null when the query returned no row for it', () => {
    const stats = shapeStats(rows({ records: [] }));
    expect([stats.longest, stats.steepest, stats.highest]).toEqual([null, null, null]);
  });
});

describe('shapeStats cadence', () => {
  it('keeps the months nobody hiked in', () => {
    const stats = shapeStats(rows());
    expect(stats.months).toHaveLength(CADENCE_MONTHS);
    expect(stats.months.at(-1)).toEqual({
      month: '2026-07',
      hikes: 2,
      lengthM: 19_800,
      gainM: 1_610,
    });
    const april = stats.months.find((month) => month.month === '2026-04');
    expect(april).toEqual({ month: '2026-04', hikes: 0, lengthM: 0, gainM: 0 });
  });

  it('runs oldest first, so the strip reads left to right in time', () => {
    const months = shapeStats(rows()).months.map((month) => month.month);
    expect([...months].sort()).toEqual(months);
  });

  it('ignores a month older than the window', () => {
    const stats = shapeStats(
      rows({ months: [{ month: '2019-04', hikes: 9, lengthM: 1, gainM: 1 }] }),
    );
    expect(stats.months.every((month) => month.hikes === 0)).toBe(true);
  });
});

describe('shapeStats regions', () => {
  it('keeps trails with no region as their own bucket rather than dropping them', () => {
    const stats = shapeStats(rows());
    expect(stats.regions).toEqual([
      { region: 'Gwynedd', hikes: 3, lengthM: 40_100 },
      { region: null, hikes: 1, lengthM: 8_100 },
    ]);
  });
});

describe('shapeStats contributions', () => {
  it('passes the review and photo counts straight through', () => {
    const stats = shapeStats(rows());
    expect(stats.reviews).toBe(2);
    expect(stats.photos).toBe(7);
  });
});
