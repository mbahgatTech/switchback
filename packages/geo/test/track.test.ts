import { describe, expect, it } from 'vitest';
import type { TrackFix } from '@switchback/core';
import {
  MAX_PLAUSIBLE_SPEED_MPS,
  MAX_SAMPLE_GAP_S,
  MIN_STEP_M,
  cleanFixes,
  computeSplits,
  simplifyTrack,
  summariseTrack,
  toGpx,
} from '@switchback/geo';
import { offset } from './helpers';

/**
 * These are the numbers a hike is remembered by, so the tests are written against the
 * failure modes of real GPS rather than against clean synthetic lines: a lunch stop that
 * invents a kilometre, a canopy fix that teleports across a valley, a phone whose first
 * position is 300 m out.
 *
 * Every fixture is built from metre offsets, so each expectation comes from the intent
 * ("an hour at 1 m/s") rather than from whatever the implementation returned first.
 */

const ORIGIN: [number, number] = [-121.4, 48.0];

/** A hike due north at a constant speed, one fix a second. */
function hike(speedMps: number, seconds: number, startT = 0, startNorthM = 0): TrackFix[] {
  return Array.from({ length: seconds + 1 }, (_, i) => {
    const [lng, lat] = offset(ORIGIN, startNorthM + i * speedMps, 0);
    return { t: startT + i, lng, lat, accuracyM: 5 };
  });
}

/** Standing still, with the couple of metres of wander a real receiver produces. */
function stand(seconds: number, startT: number, northM: number): TrackFix[] {
  return Array.from({ length: seconds }, (_, i) => {
    const [lng, lat] = offset(ORIGIN, northM + Math.sin(i) * 1.5, Math.cos(i) * 1.5);
    return { t: startT + i, lng, lat, accuracyM: 6 };
  });
}

describe('summariseTrack', () => {
  it('measures a steady hike', () => {
    const stats = summariseTrack(hike(1.4, 3_600));
    expect(stats.distanceM).toBeGreaterThan(4_950);
    expect(stats.distanceM).toBeLessThan(5_100);
    expect(stats.elapsedTimeS).toBe(3_600);
    expect(stats.movingTimeS).toBe(3_600);
    expect(stats.avgSpeedMps).toBeCloseTo(1.4, 1);
  });

  it('does not invent distance out of a lunch stop', () => {
    // The headline bug this file exists for: ten minutes of 1 Hz jitter while stationary
    // sums to hundreds of metres if every wobble is credited.
    const stats = summariseTrack(stand(600, 0, 0));
    expect(stats.distanceM).toBe(0);
    expect(stats.elapsedTimeS).toBe(599);
  });

  it('excludes the stop from moving time but not from elapsed', () => {
    const fixes = [...hike(1.4, 600), ...stand(600, 601, 840), ...hike(1.4, 600, 1_201, 840)];
    const stats = summariseTrack(fixes);
    expect(stats.elapsedTimeS).toBe(1_801);
    // Two ten-minute legs of hiking; the stop in between contributes nothing.
    expect(stats.movingTimeS).toBeGreaterThan(1_150);
    expect(stats.movingTimeS).toBeLessThan(1_260);
  });

  it('still counts a slow hiker whose steps are under the jitter floor', () => {
    // 0.6 m/s at 1 Hz is a 0.6 m step — well below MIN_STEP_M. Discarding those steps one
    // by one would report a two-kilometre amble as standing still for an hour.
    expect(0.6).toBeLessThan(MIN_STEP_M);
    const stats = summariseTrack(hike(0.6, 3_600));
    expect(stats.distanceM).toBeGreaterThan(2_100);
    expect(stats.distanceM).toBeLessThan(2_200);
  });

  it('uses the hysteresis filter for ascent, not the sum of every wobble', () => {
    const fixes = hike(1.4, 200).map((fix, i) => ({
      ...fix,
      eleM: 500 + i * 0.5 + Math.sin(i) * 3,
    }));
    const stats = summariseTrack(fixes);
    // The real climb is 100 m; naive summing of the ±3 m noise would report several hundred.
    expect(stats.gainM).toBeGreaterThan(90);
    expect(stats.gainM).toBeLessThan(115);
    // Min and max are the raw extremes, not the filtered ones — the hysteresis is about how
    // much climbing happened, not about how high the hiker got.
    expect(stats.minEleM).toBe(500);
    expect(stats.maxEleM).toBeGreaterThanOrEqual(600);
  });

  it('reports nothing rather than throwing on an empty recording', () => {
    expect(summariseTrack([])).toMatchObject({ distanceM: 0, elapsedTimeS: 0, avgSpeedMps: null });
    expect(summariseTrack([{ t: 0, lng: -121.4, lat: 48 }])).toMatchObject({ elapsedTimeS: 0 });
  });
});

describe('cleanFixes', () => {
  it('drops a fix too inaccurate to be a position', () => {
    const fixes: TrackFix[] = [
      { t: 0, lng: -121.4, lat: 48, accuracyM: 480 },
      { t: 1, lng: -121.4, lat: 48, accuracyM: 8 },
    ];
    expect(cleanFixes(fixes).map((f) => f.t)).toEqual([1]);
  });

  it('rejects a canopy jump instead of hiking to it and back', () => {
    const [jumpLng, jumpLat] = offset(ORIGIN, 4_000, 0);
    const fixes: TrackFix[] = [
      ...hike(1.4, 10),
      { t: 11, lng: jumpLng, lat: jumpLat, accuracyM: 9 },
      ...hike(1.4, 10, 12, 15.4),
    ];
    const speedOfJump = 4_000 / 1;
    expect(speedOfJump).toBeGreaterThan(MAX_PLAUSIBLE_SPEED_MPS);

    const stats = summariseTrack(fixes);
    // 8 km of phantom travel if the jump were believed.
    expect(stats.distanceM).toBeLessThan(60);
  });

  it('orders a batch that arrived out of sequence', () => {
    const later = hike(1.4, 5, 100);
    const earlier = hike(1.4, 5, 0);
    expect(cleanFixes([...later, ...earlier]).map((f) => f.t)).toEqual([
      0, 1, 2, 3, 4, 5, 100, 101, 102, 103, 104, 105,
    ]);
  });

  it('discards a duplicate second, so a retried upload cannot double a hike', () => {
    const once = hike(1.4, 60);
    expect(summariseTrack([...once, ...once]).distanceM).toBe(summariseTrack(once).distanceM);
  });
});

describe('computeSplits', () => {
  it('cuts a hike into whole kilometres and marks the remainder', () => {
    const splits = computeSplits(hike(2, 1_300)); // 2,600 m
    expect(splits).toHaveLength(3);
    expect(splits[0]).toMatchObject({ index: 1, distanceM: 1_000, complete: true });
    expect(splits[2]?.complete).toBe(false);
    expect(splits[2]?.distanceM).toBeLessThan(1_000);
  });

  it('sums to the total distance — a table that does not add up reads as broken', () => {
    const fixes = hike(1.6, 2_000);
    const total = summariseTrack(fixes).distanceM;
    const summed = computeSplits(fixes).reduce((sum, split) => sum + split.distanceM, 0);
    expect(Math.abs(summed - total)).toBeLessThanOrEqual(3);
  });

  it('quotes pace per whole unit, so the partial last split is still comparable', () => {
    const splits = computeSplits(hike(2, 1_300));
    // 2 m/s is 500 s per kilometre.
    for (const split of splits) expect(split.paceSPerUnit).toBeGreaterThan(480);
    for (const split of splits) expect(split.paceSPerUnit).toBeLessThan(520);
  });

  it('splits on miles when the hiker reads miles', () => {
    const metric = computeSplits(hike(2, 1_300), 'metric');
    const imperial = computeSplits(hike(2, 1_300), 'imperial');
    expect(imperial.length).toBeLessThan(metric.length);
    expect(imperial[0]?.distanceM).toBe(1_609);
  });

  it('returns nothing for a recording with one fix', () => {
    expect(computeSplits([{ t: 0, lng: -121.4, lat: 48 }])).toEqual([]);
  });
});

describe('simplifyTrack', () => {
  it('keeps the shape and both ends while shedding the jitter', () => {
    const fixes = [...hike(1.4, 600), ...stand(600, 601, 840)];
    const thinned = simplifyTrack(fixes);
    expect(thinned.length).toBeLessThan(fixes.length / 4);
    expect(thinned[0]).toEqual(fixes[0]);
    expect(thinned[thinned.length - 1]).toEqual(fixes[fixes.length - 1]);
  });

  it('carries the whole fix through, not just its coordinates', () => {
    const fixes = hike(1.4, 300).map((fix, i) => ({ ...fix, heartRate: 120 + (i % 20) }));
    for (const fix of simplifyTrack(fixes)) expect(fix.heartRate).toBeDefined();
  });

  it('does not flatten ten minutes of straight hiking to two points', () => {
    // The failure this guard exists for. A straight line is geometrically two points, and
    // storing it as two points throws away every split, every heart rate, and the whole
    // pace curve — the recording becomes an outline of a hike rather than the hike.
    const straight = hike(1.4, 600);
    const thinned = simplifyTrack(straight);
    expect(thinned.length).toBeGreaterThanOrEqual(600 / MAX_SAMPLE_GAP_S);
    for (let i = 1; i < thinned.length; i++) {
      expect(thinned[i]!.t - thinned[i - 1]!.t).toBeLessThanOrEqual(MAX_SAMPLE_GAP_S);
    }
  });

  it('still measures the same hike after thinning', () => {
    // Thinning is a storage decision, so it must not move the numbers. Within a metre or
    // two: the retained fixes are a subset, and a chord is marginally shorter than its arc.
    const fixes = [...hike(1.4, 900), ...stand(300, 901, 1_260), ...hike(1.2, 600, 1_201, 1_260)];
    const before = summariseTrack(fixes);
    const after = summariseTrack(simplifyTrack(fixes));
    expect(Math.abs(after.distanceM - before.distanceM)).toBeLessThan(before.distanceM * 0.02);
    expect(after.elapsedTimeS).toBe(before.elapsedTimeS);
  });

  it('leaves an already-sparse track alone', () => {
    // A fix a minute is already coarser than the gap cap, and there is nothing to insert —
    // the refill must never invent a point that was not recorded.
    const sparse = Array.from({ length: 20 }, (_, i) => {
      const [lng, lat] = offset(ORIGIN, i * 80, 0);
      return { t: i * 60, lng, lat, accuracyM: 5 };
    });
    expect(simplifyTrack(sparse).length).toBeLessThanOrEqual(sparse.length);
  });
});

describe('toGpx', () => {
  const gpx = toGpx(
    [
      { t: 0, lng: -121.4, lat: 48, eleM: 512.3, heartRate: 118 },
      { t: 60, lng: -121.401, lat: 48.001, eleM: 546.9 },
    ],
    {
      name: 'Vesper Peak & back',
      startedAt: new Date('2026-07-04T14:30:00.000Z'),
      activityType: 'hiking',
    },
  );

  it('writes a track, not a route — a route is a plan', () => {
    expect(gpx).toContain('<trk>');
    expect(gpx).toContain('<trkseg>');
    expect(gpx).not.toContain('<rte>');
  });

  it('gives every point an absolute time, reconstructed from the start', () => {
    expect(gpx).toContain('<time>2026-07-04T14:30:00.000Z</time>');
    expect(gpx).toContain('<time>2026-07-04T14:31:00.000Z</time>');
  });

  it('escapes the name rather than emitting invalid XML', () => {
    expect(gpx).toContain('<name>Vesper Peak &amp; back</name>');
  });

  it('carries heart rate in the extension Garmin reads', () => {
    expect(gpx).toContain('<gpxtpx:hr>118</gpxtpx:hr>');
  });
});
