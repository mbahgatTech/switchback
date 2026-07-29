import { describe, expect, it } from 'vitest';
import type { ElevationPoint } from '@switchback/core';
import {
  OFF_PATH_FACTOR,
  SAC_TERRAIN_FACTOR,
  TOBLER_BASE_KMH,
  cumulativeTimeS,
  estimateMovingTimeS,
  terrainFactorFor,
  timeAtDistanceS,
  toblerSpeedKmh,
} from '@switchback/geo';

function profileOf(spacingM: number, count: number, eleAt: (distM: number) => number) {
  return Array.from({ length: count }, (_, i) => ({
    distM: i * spacingM,
    eleM: eleAt(i * spacingM),
    lng: 0,
    lat: 45,
  })) satisfies ElevationPoint[];
}

describe('toblerSpeedKmh', () => {
  it('gives the published flat-ground pace of 5.04 km/h', () => {
    expect(toblerSpeedKmh(0)).toBeCloseTo(5.037, 3);
  });

  it('peaks at 6 km/h on a gentle downhill, not on the flat', () => {
    expect(toblerSpeedKmh(-0.05)).toBeCloseTo(TOBLER_BASE_KMH, 9);
    expect(toblerSpeedKmh(-0.05)).toBeGreaterThan(toblerSpeedKmh(0));
  });

  it('is symmetric about that −5% peak', () => {
    for (const d of [0.02, 0.1, 0.25]) {
      expect(toblerSpeedKmh(-0.05 + d)).toBeCloseTo(toblerSpeedKmh(-0.05 - d), 9);
    }
  });

  it('reproduces published table values', () => {
    // W = 6·exp(−3.5·|S + 0.05|)
    expect(toblerSpeedKmh(0.05)).toBeCloseTo(6 * Math.exp(-0.35), 6);
    expect(toblerSpeedKmh(0.1)).toBeCloseTo(6 * Math.exp(-0.525), 6);
    expect(toblerSpeedKmh(-0.1)).toBeCloseTo(toblerSpeedKmh(0), 6);
  });

  it('slows monotonically as an ascent steepens', () => {
    let prev = Infinity;
    for (const s of [0, 0.05, 0.1, 0.2, 0.3]) {
      const speed = toblerSpeedKmh(s);
      expect(speed).toBeLessThan(prev);
      prev = speed;
    }
  });

  it('floors on a cliff face, so one bad DEM sample cannot add hours', () => {
    expect(toblerSpeedKmh(5)).toBe(0.6);
    expect(toblerSpeedKmh(-5)).toBe(0.6);
  });

  it('falls back to the flat pace for a non-finite slope', () => {
    expect(toblerSpeedKmh(Number.NaN)).toBeCloseTo(toblerSpeedKmh(0), 9);
  });
});

describe('terrainFactorFor', () => {
  it('is neutral with no tags at all', () => {
    expect(terrainFactorFor({})).toBe(1);
    expect(terrainFactorFor({ sacScale: null, surface: null })).toBe(1);
  });

  it('applies the sac_scale multiplier', () => {
    expect(terrainFactorFor({ sacScale: 'alpine_hiking' })).toBe(SAC_TERRAIN_FACTOR.alpine_hiking);
  });

  it('makes harder terrain strictly slower', () => {
    expect(terrainFactorFor({ sacScale: 'difficult_alpine_hiking' })).toBeLessThan(
      terrainFactorFor({ sacScale: 'hiking' }),
    );
  });

  it('speeds up on pavement and slows down in sand', () => {
    expect(terrainFactorFor({ surface: 'asphalt' })).toBeGreaterThan(1);
    expect(terrainFactorFor({ surface: 'sand' })).toBeLessThan(1);
  });

  it('is case-insensitive about surface tags', () => {
    expect(terrainFactorFor({ surface: 'GRAVEL' })).toBe(terrainFactorFor({ surface: 'gravel' }));
  });

  it('ignores a surface value OSM has but we do not model', () => {
    expect(terrainFactorFor({ surface: 'woodchips' })).toBe(1);
  });

  it('compounds terrain, surface and off-path travel', () => {
    const combined = terrainFactorFor({
      sacScale: 'mountain_hiking',
      surface: 'scree',
      onPath: false,
    });
    expect(combined).toBeCloseTo(SAC_TERRAIN_FACTOR.mountain_hiking * 0.65 * OFF_PATH_FACTOR, 9);
  });
});

describe('cumulativeTimeS', () => {
  const flat1km = profileOf(100, 11, () => 500);

  it('starts at zero and never goes backwards', () => {
    const cum = cumulativeTimeS(profileOf(25, 41, (d) => d * 0.1));
    expect(cum[0]).toBe(0);
    for (let i = 1; i < cum.length; i++) expect(cum[i]!).toBeGreaterThan(cum[i - 1]!);
  });

  it('hikes a flat kilometre in 1/5.037 of an hour', () => {
    const expected = (1 / toblerSpeedKmh(0)) * 3600;
    expect(cumulativeTimeS(flat1km)[10]).toBeCloseTo(expected, 3);
    expect(expected).toBeCloseTo(715, 0);
  });

  it('takes longer uphill than on the flat over the same ground distance', () => {
    const uphill = profileOf(100, 11, (d) => 500 + d * 0.15);
    expect(estimateMovingTimeS(uphill)).toBeGreaterThan(estimateMovingTimeS(flat1km));
  });

  it('scales linearly with paceFactor', () => {
    const base = estimateMovingTimeS(flat1km);
    expect(estimateMovingTimeS(flat1km, { paceFactor: 1.3 })).toBeCloseTo(base * 1.3, 6);
    expect(estimateMovingTimeS(flat1km, { paceFactor: 0.8 })).toBeCloseTo(base * 0.8, 6);
  });

  it('scales inversely with terrainFactor', () => {
    const base = estimateMovingTimeS(flat1km);
    expect(estimateMovingTimeS(flat1km, { terrainFactor: 0.5 })).toBeCloseTo(base * 2, 6);
  });

  it('does not stall on the duplicate vertices raw geometry contains', () => {
    const dupes: ElevationPoint[] = [
      { distM: 0, eleM: 500, lng: 0, lat: 45 },
      { distM: 0, eleM: 500, lng: 0, lat: 45 },
      { distM: 100, eleM: 500, lng: 0, lat: 45 },
    ];
    const cum = cumulativeTimeS(dupes);
    expect(cum[1]).toBe(0);
    expect(cum[2]).toBeGreaterThan(0);
  });

  it('is zero for a profile with nothing to hike', () => {
    expect(estimateMovingTimeS([])).toBe(0);
    expect(estimateMovingTimeS(profileOf(100, 1, () => 500))).toBe(0);
  });
});

describe('timeAtDistanceS', () => {
  const profile = profileOf(100, 11, () => 500);
  const cum = cumulativeTimeS(profile);

  it('interpolates between profile points — the weather sampler’s lookup', () => {
    expect(timeAtDistanceS(profile, cum, 550)).toBeCloseTo((cum[5]! + cum[6]!) / 2, 6);
  });

  it('is exact at a profile point', () => {
    expect(timeAtDistanceS(profile, cum, 300)).toBeCloseTo(cum[3]!, 6);
  });

  it('clamps at both ends', () => {
    expect(timeAtDistanceS(profile, cum, -100)).toBe(0);
    expect(timeAtDistanceS(profile, cum, 99_999)).toBe(cum[10]);
  });

  it('is monotonic across the whole trail', () => {
    let prev = -1;
    for (let d = 0; d <= 1000; d += 37) {
      const t = timeAtDistanceS(profile, cum, d);
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });

  it('handles an empty profile', () => {
    expect(timeAtDistanceS([], [], 500)).toBe(0);
  });
});
