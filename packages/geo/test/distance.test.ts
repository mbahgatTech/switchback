import { describe, expect, it } from 'vitest';
import {
  EARTH_RADIUS_M,
  bboxOf,
  bearingDeg,
  compassPoint,
  cumulativeDistancesM,
  haversineM,
  lineLengthM,
  nearestPointOnLine,
  nearestPointOnSegment,
  padBBox,
} from '@switchback/geo';
import { M_PER_DEG_LAT, lineNorth, offset } from './helpers';

describe('haversineM', () => {
  it('gives one degree of latitude as R·π/180, exactly', () => {
    expect(haversineM([0, 0], [0, 1])).toBeCloseTo((EARTH_RADIUS_M * Math.PI) / 180, 6);
  });

  it('shrinks a degree of longitude by cos(latitude)', () => {
    const atEquator = haversineM([0, 0], [1, 0]);
    const at60 = haversineM([0, 60], [1, 60]);
    expect(at60 / atEquator).toBeCloseTo(0.5, 3);
  });

  it('matches the published great-circle distance JFK → LAX (~3,983 km)', () => {
    const km = haversineM([-73.7789, 40.6413], [-118.4081, 33.9425]) / 1000;
    expect(km).toBeGreaterThan(3950);
    expect(km).toBeLessThan(4010);
  });

  it('is symmetric and zero for identical points', () => {
    const a: [number, number] = [7.6586, 45.9763];
    const b: [number, number] = [7.8586, 46.0763];
    expect(haversineM(a, b)).toBeCloseTo(haversineM(b, a), 9);
    expect(haversineM(a, a)).toBe(0);
  });

  it('is stable across the antimeridian', () => {
    const oneDegAt0 = haversineM([0, 0], [1, 0]);
    expect(haversineM([179.5, 0], [-179.5, 0])).toBeCloseTo(oneDegAt0, 3);
  });
});

describe('bearingDeg', () => {
  it('reads due north, east, south and west', () => {
    expect(bearingDeg([0, 0], [0, 1])).toBeCloseTo(0, 6);
    expect(bearingDeg([0, 0], [1, 0])).toBeCloseTo(90, 6);
    expect(bearingDeg([0, 1], [0, 0])).toBeCloseTo(180, 6);
    expect(bearingDeg([1, 0], [0, 0])).toBeCloseTo(270, 6);
  });

  it('stays within [0, 360)', () => {
    const b = bearingDeg([10, 45], [9.9, 44.9]);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});

describe('lineLengthM and cumulativeDistancesM', () => {
  const line = lineNorth([7.5, 45.9], 1000, 11);

  it('measures a line built to a known length', () => {
    expect(lineLengthM(line)).toBeCloseTo(1000, 3);
  });

  it('starts cumulative distance at zero and ends at the total', () => {
    const cum = cumulativeDistancesM(line);
    expect(cum).toHaveLength(line.length);
    expect(cum[0]).toBe(0);
    expect(cum[cum.length - 1]).toBeCloseTo(1000, 3);
  });

  it('is monotonically non-decreasing, so it can index the profile', () => {
    const cum = cumulativeDistancesM(line);
    for (let i = 1; i < cum.length; i++) expect(cum[i]!).toBeGreaterThanOrEqual(cum[i - 1]!);
  });

  it('measures nothing for a single point', () => {
    expect(lineLengthM([[0, 0]])).toBe(0);
    expect(cumulativeDistancesM([[0, 0]])).toEqual([0]);
  });
});

describe('bboxOf and padBBox', () => {
  it('bounds a coordinate list as [w, s, e, n]', () => {
    expect(
      bboxOf([
        [2, 10],
        [-3, 40],
        [5, 20],
      ]),
    ).toEqual([-3, 10, 5, 40]);
  });

  it('pads by a real distance, widening longitude more at high latitude', () => {
    const [w, s, e, n] = padBBox([10, 60, 10, 60], 1000);
    expect((n - 60) * M_PER_DEG_LAT).toBeCloseTo(1000, 3);
    expect((60 - s) * M_PER_DEG_LAT).toBeCloseTo(1000, 3);
    // Longitude pad is the latitude pad divided by cos(60°) = 2×.
    expect((e - 10) / (n - 60)).toBeCloseTo(2, 2);
    expect(w).toBeLessThan(10);
  });

  it('clamps to the valid coordinate range near the poles', () => {
    const [w, s, e, n] = padBBox([-179.99, -89.99, 179.99, 89.99], 500_000);
    expect(w).toBeGreaterThanOrEqual(-180);
    expect(e).toBeLessThanOrEqual(180);
    expect(s).toBeGreaterThanOrEqual(-90);
    expect(n).toBeLessThanOrEqual(90);
  });
});

describe('nearestPointOnSegment', () => {
  const a: [number, number] = [0, 45];
  const b = offset(a, 1000, 0); // 1 km due north

  it('measures perpendicular offset from the segment', () => {
    const p = offset(a, 500, 80); // 500 m along, 80 m to the side
    const hit = nearestPointOnSegment(p, a, b);
    expect(hit.distM).toBeCloseTo(80, 0);
    expect(hit.t).toBeCloseTo(0.5, 2);
  });

  it('clamps past the ends rather than extrapolating the line', () => {
    const beyond = offset(b, 300, 0);
    const hit = nearestPointOnSegment(beyond, a, b);
    expect(hit.t).toBe(1);
    expect(hit.distM).toBeCloseTo(300, 0);
  });

  it('survives the duplicate vertices that raw OSM geometry is full of', () => {
    const hit = nearestPointOnSegment(offset(a, 0, 50), a, a);
    expect(hit.distM).toBeCloseTo(50, 0);
    expect(hit.t).toBe(0);
  });
});

describe('nearestPointOnLine', () => {
  const route = lineNorth([0, 45], 2000, 5); // vertices every 500 m

  it('reports both cross-track error and how far along the user is', () => {
    const p = offset(route[0]!, 1250, 40);
    const hit = nearestPointOnLine(p, route);
    expect(hit.distM).toBeCloseTo(40, 0);
    expect(hit.alongM).toBeCloseTo(1250, 0);
    expect(hit.segmentIndex).toBe(2);
  });

  it('pins to the start and end for positions beyond either', () => {
    expect(nearestPointOnLine(offset(route[0]!, -200, 0), route).alongM).toBeCloseTo(0, 3);
    expect(nearestPointOnLine(offset(route[4]!, 200, 0), route).alongM).toBeCloseTo(2000, 0);
  });

  it('handles a one-point line instead of dividing by zero', () => {
    const hit = nearestPointOnLine([0, 45], [[0, 45]]);
    expect(hit.distM).toBe(0);
    expect(hit.alongM).toBe(0);
  });

  it('refuses an empty line loudly', () => {
    expect(() => nearestPointOnLine([0, 0], [])).toThrow(/empty line/);
  });
});

describe('compassPoint', () => {
  it('names each of the eight directions at its own bearing', () => {
    const named = [0, 45, 90, 135, 180, 225, 270, 315].map(compassPoint);
    expect(named).toEqual(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
  });

  it('centres each sector on its direction rather than starting it there', () => {
    // The off-by-half-a-sector bug is `Math.floor(deg / 45)`, which makes north the sector
    // 0°–45° instead of the one centred on 0°. Every assertion here is a bearing the two
    // versions disagree about: under the buggy one, a trail 44° round the rose — all but
    // due northeast — is written up as due north.
    expect(compassPoint(22.4)).toBe('N');
    expect(compassPoint(22.6)).toBe('NE');
    expect(compassPoint(44)).toBe('NE');
    expect(compassPoint(337.6)).toBe('N');
    expect(compassPoint(337.4)).toBe('NW');
  });

  it('wraps rather than falling off either end', () => {
    expect(compassPoint(360)).toBe('N');
    expect(compassPoint(359.9)).toBe('N');
    expect(compassPoint(720 + 90)).toBe('E');
    expect(compassPoint(-90)).toBe('W');
    expect(compassPoint(-45)).toBe('NW');
  });

  it('survives a bearing that is not a number', () => {
    // `bearingDeg` of a point to itself is well defined, but a coordinate read from a
    // cookie or a URL is not, and a compass rose is not where that should surface.
    expect(compassPoint(Number.NaN)).toBe('N');
    expect(compassPoint(Infinity)).toBe('N');
  });

  it('agrees with bearingDeg on the ground', () => {
    const here: [number, number] = [-3.07, 54.45];
    expect(compassPoint(bearingDeg(here, [-3.07, 54.55]))).toBe('N');
    expect(compassPoint(bearingDeg(here, [-2.9, 54.45]))).toBe('E');
    expect(compassPoint(bearingDeg(here, [-3.07, 54.35]))).toBe('S');
    expect(compassPoint(bearingDeg(here, [-3.24, 54.45]))).toBe('W');
  });
});
