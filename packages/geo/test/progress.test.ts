import { describe, expect, it } from 'vitest';
import type { ElevationPoint } from '@switchback/core';
import {
  advanceProgress,
  buildHikePlan,
  computeGainLoss,
  gainAt,
  gainLossCurve,
  nearestPointOnLine,
  type HikePlan,
} from '@switchback/geo';
import { lineNorth } from './helpers';

/** A profile running `lengthM` north, sampled every `lengthM / (heights.length - 1)`. */
function profileOf(heights: readonly number[], lengthM: number): ElevationPoint[] {
  const line = lineNorth([0, 45], lengthM, heights.length);
  return heights.map((eleM, i) => ({
    distM: (lengthM * i) / (heights.length - 1),
    eleM,
    lng: line[i]![0],
    lat: line[i]![1],
  }));
}

/** A steady 1,000 m climb over 5 km, in 50 m steps. */
const climb = profileOf(
  Array.from({ length: 21 }, (_, i) => 100 + i * 50),
  5000,
);

describe('gainLossCurve', () => {
  it('spends the whole published ascent by the last sample', () => {
    const heights = [100, 140, 90, 300, 250, 400];
    const curve = gainLossCurve(heights);
    const total = computeGainLoss(heights);
    expect(curve.gainM[curve.gainM.length - 1]).toBe(total.gainM);
    expect(curve.lossM[curve.lossM.length - 1]).toBe(total.lossM);
  });

  it('never goes backwards, and credits a climb while it is still being climbed', () => {
    const curve = gainLossCurve([100, 150, 200, 250]);
    expect(curve.gainM).toEqual([0, 50, 100, 150]);
    for (let i = 1; i < curve.gainM.length; i++) {
      expect(curve.gainM[i]!).toBeGreaterThanOrEqual(curve.gainM[i - 1]!);
    }
  });

  it('carries the last reading across a sample with no elevation', () => {
    const curve = gainLossCurve([100, 150, Number.NaN, 200]);
    expect(curve.gainM).toEqual([0, 50, 50, 100]);
  });
});

describe('buildHikePlan', () => {
  it('keeps the ascent curve paired with the samples thinning kept', () => {
    const long = profileOf(
      Array.from({ length: 900 }, (_, i) => 100 + i),
      9000,
    );
    const plan = buildHikePlan(long, { routeType: 'point_to_point', lengthM: 9000 })!;

    expect(plan.profile.length).toBeLessThanOrEqual(220);
    expect(plan.gainToM).toHaveLength(plan.profile.length);
    expect(plan.gainToM[plan.gainToM.length - 1]).toBe(
      computeGainLoss(long.map((p) => p.eleM)).gainM,
    );
  });

  it('doubles the axis for a trail whose line is retraced', () => {
    const plan = buildHikePlan(climb, { routeType: 'out_and_back', lengthM: 10_000 })!;
    expect(plan.storedLengthM).toBe(5000);
    expect(plan.hikedLengthM).toBe(10_000);
  });

  it('still reports a distance for a trail whose elevation pass has not run', () => {
    const plan = buildHikePlan([], { routeType: 'point_to_point', lengthM: 4000 })!;
    expect(plan.profile).toEqual([]);
    expect(plan.hikedLengthM).toBe(4000);
    expect(buildHikePlan([], { routeType: 'point_to_point', lengthM: 0 })).toBeNull();
  });
});

describe('advanceProgress', () => {
  const line = lineNorth([0, 45], 5000, 21);
  const at = (metresAlong: number) =>
    nearestPointOnLine(line[Math.round(metresAlong / 250)]!, line);

  it('counts down the distance and the climb as the hiker goes up', () => {
    const plan = buildHikePlan(climb, { routeType: 'point_to_point', lengthM: 5000 })!;

    const start = advanceProgress(plan, null, at(0));
    expect(start.remainingM).toBeCloseTo(5000, -1);
    expect(start.remainingGainM).toBeCloseTo(1000, 0);

    const halfway = advanceProgress(plan, start, at(2500));
    expect(halfway.remainingM).toBeCloseTo(2500, -1);
    expect(halfway.remainingGainM).toBeCloseTo(500, 0);
    expect(halfway.at).toEqual(line[10]);
  });

  it('reads the return leg once the hiker has reached the far end', () => {
    const plan = buildHikePlan(climb, { routeType: 'out_and_back', lengthM: 10_000 })!;

    const outbound = advanceProgress(plan, null, at(4000));
    expect(outbound.hikedM).toBeCloseTo(4000, -1);

    const summit = advanceProgress(plan, outbound, at(5000));
    const descending = advanceProgress(plan, summit, at(4000));
    expect(descending.alongM).toBeCloseTo(4000, -1);
    expect(descending.hikedM).toBeCloseTo(6000, -1);
    expect(descending.remainingM).toBeCloseTo(4000, -1);
  });

  it('does not take a wobble short of the far end for a turnaround', () => {
    const plan = buildHikePlan(climb, { routeType: 'out_and_back', lengthM: 10_000 })!;

    const up = advanceProgress(plan, null, at(3000));
    const slipped = advanceProgress(plan, up, at(2750));
    expect(slipped.hikedM).toBeCloseTo(2750, -1);
  });
});

describe('gainAt', () => {
  const plan: HikePlan = {
    profile: [
      { distM: 0, eleM: 100, lng: 0, lat: 45 },
      { distM: 1000, eleM: 300, lng: 0, lat: 45 },
    ],
    gainToM: [0, 200],
    storedLengthM: 1000,
    hikedLengthM: 1000,
  };

  it('interpolates between two samples', () => {
    expect(gainAt(plan, 250)).toBeCloseTo(50, 6);
  });

  it('clamps to the ends rather than extrapolating', () => {
    expect(gainAt(plan, -500)).toBe(0);
    expect(gainAt(plan, 9000)).toBe(200);
  });

  it('reads zero from a plan with no profile', () => {
    expect(gainAt({ ...plan, profile: [], gainToM: [] }, 500)).toBe(0);
  });
});
