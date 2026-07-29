import type { ElevationPoint } from '@switchback/core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SAMPLE_COUNT, buildJourney, planSamples } from '../src/sample';
import { OUT_AND_BACK, POINT_TO_POINT, makeProfile } from './fixtures';

const START_S = Math.floor(Date.UTC(2026, 6, 20, 6, 0, 0) / 1000);

describe('buildJourney', () => {
  it('mirrors an out-and-back without repeating the turnaround', () => {
    const profile = makeProfile({ points: 5, spacingM: 100 });
    const journey = buildJourney(profile, {
      routeType: OUT_AND_BACK,
      includeReturn: true,
      lengthM: 800,
    });

    expect(journey).toHaveLength(9);
    expect(journey.map((p) => p.distM)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800]);
    // The high point is the turnaround, and it appears exactly once.
    expect(journey.filter((p) => p.distM === 400)).toHaveLength(1);
    // Elevation retraces itself.
    expect(journey.map((p) => Math.round(p.eleM))).toEqual([
      100, 300, 500, 700, 900, 700, 500, 300, 100,
    ]);
    // Coordinates come back to where they started.
    expect(journey[8]!.lat).toBe(profile[0]!.lat);
    expect(journey[8]!.lng).toBe(profile[0]!.lng);
  });

  it('leaves an out-and-back whose geometry already contains the return', () => {
    // The 400 m of stored line *is* the whole hike — this trail was classified out-and-back
    // because it visibly retraces itself, not because a return leg was inferred. Mirroring
    // on the route type alone would sell an 800 m walk to someone doing 400.
    const profile = makeProfile({ points: 5, spacingM: 100 });
    const journey = buildJourney(profile, {
      routeType: OUT_AND_BACK,
      includeReturn: true,
      lengthM: 400,
    });
    expect(journey).toHaveLength(5);
  });

  it('leaves loops and point-to-points alone', () => {
    const profile = makeProfile({ points: 5, spacingM: 100 });
    for (const routeType of ['loop', 'point_to_point'] as const) {
      const journey = buildJourney(profile, { routeType, includeReturn: true, lengthM: 800 });
      expect(journey).toHaveLength(5);
    }
  });

  it('respects includeReturn: false on an out-and-back', () => {
    const profile = makeProfile({ points: 5, spacingM: 100 });
    const journey = buildJourney(profile, {
      routeType: OUT_AND_BACK,
      includeReturn: false,
      lengthM: 800,
    });
    expect(journey).toHaveLength(5);
  });

  it('copies rather than aliases the input', () => {
    const profile = makeProfile({ points: 3, spacingM: 100 });
    const journey = buildJourney(profile, {
      routeType: OUT_AND_BACK,
      includeReturn: true,
      lengthM: 400,
    });
    journey[0]!.eleM = -999;
    expect(profile[0]!.eleM).toBe(100);
  });

  it('does not fall over on a degenerate profile', () => {
    expect(buildJourney([], { routeType: OUT_AND_BACK, includeReturn: true, lengthM: 0 })).toEqual(
      [],
    );
    const single: ElevationPoint[] = [{ distM: 0, eleM: 10, lng: 1, lat: 2 }];
    expect(
      buildJourney(single, { routeType: OUT_AND_BACK, includeReturn: true, lengthM: 0 }),
    ).toHaveLength(1);
  });
});

describe('planSamples', () => {
  it('returns eight samples by default, in order along the trail', () => {
    const journey = makeProfile();
    const plans = planSamples(journey, START_S, { routeType: POINT_TO_POINT });

    expect(plans).toHaveLength(DEFAULT_SAMPLE_COUNT);
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i]!.index).toBeGreaterThan(plans[i - 1]!.index);
      expect(plans[i]!.distM).toBeGreaterThan(plans[i - 1]!.distM);
    }
  });

  it('always includes the trailhead, the finish and the high point', () => {
    // A profile whose maximum sits at an awkward index that even spacing would miss.
    const journey = makeProfile({ points: 61, spacingM: 25, startEleM: 100, endEleM: 400 });
    journey[37]!.eleM = 1500;

    const plans = planSamples(journey, START_S, { routeType: POINT_TO_POINT });
    const indices = plans.map((p) => p.index);

    expect(indices).toContain(0);
    expect(indices).toContain(60);
    expect(indices).toContain(37);
    expect(plans.find((p) => p.index === 37)!.label).toBe('High point');
  });

  it('gives arrival times that only move forwards', () => {
    const journey = buildJourney(makeProfile(), {
      routeType: OUT_AND_BACK,
      includeReturn: true,
      lengthM: 4000,
    });
    const plans = planSamples(journey, START_S, { routeType: OUT_AND_BACK });

    expect(plans[0]!.arrivalS).toBe(START_S);
    expect(plans[0]!.elapsedS).toBe(0);
    for (let i = 1; i < plans.length; i++) {
      expect(plans[i]!.arrivalS).toBeGreaterThan(plans[i - 1]!.arrivalS);
    }
  });

  it('descends faster than it climbs', () => {
    // The reason the return leg is real geometry rather than a doubling. A 2 km, 800 m climb
    // and the same ground downhill are not the same number of hours, and finishing before
    // sunset depends on which one we tell the user.
    const profile = makeProfile();
    const journey = buildJourney(profile, {
      routeType: OUT_AND_BACK,
      includeReturn: true,
      lengthM: 4000,
    });
    const plans = planSamples(journey, START_S, { routeType: OUT_AND_BACK });

    const turnaround = plans.find((p) => p.label === 'High point');
    const finish = plans[plans.length - 1]!;
    expect(turnaround).toBeDefined();

    const upS = turnaround!.elapsedS;
    const downS = finish.elapsedS - turnaround!.elapsedS;
    expect(downS).toBeLessThan(upS);
    // And by a margin that matters — not a rounding difference.
    expect(downS).toBeLessThan(upS * 0.75);
  });

  it('scales with paceFactor', () => {
    const journey = makeProfile();
    const brisk = planSamples(journey, START_S, { paceFactor: 0.75, routeType: POINT_TO_POINT });
    const steady = planSamples(journey, START_S, { paceFactor: 1, routeType: POINT_TO_POINT });
    const slow = planSamples(journey, START_S, { paceFactor: 1.5, routeType: POINT_TO_POINT });

    const finish = (plans: typeof brisk) => plans[plans.length - 1]!.elapsedS;
    expect(finish(brisk)).toBeLessThan(finish(steady));
    expect(finish(slow)).toBeGreaterThan(finish(steady));
  });

  it('labels the last point by what the route actually does', () => {
    const profile = makeProfile();

    const oneWay = planSamples(profile, START_S, { routeType: POINT_TO_POINT });
    expect(oneWay[oneWay.length - 1]!.label).toBe('Finish');

    const journey = buildJourney(profile, {
      routeType: OUT_AND_BACK,
      includeReturn: true,
      lengthM: 4000,
    });
    const there = planSamples(journey, START_S, { routeType: OUT_AND_BACK });
    expect(there[there.length - 1]!.label).toBe('Back at the start');

    expect(oneWay[0]!.label).toBe('Trailhead');
  });

  it('labels intermediate points by distance in the reader’s units', () => {
    const journey = makeProfile();
    const metric = planSamples(journey, START_S, {
      unitSystem: 'metric',
      routeType: POINT_TO_POINT,
    });
    const imperial = planSamples(journey, START_S, {
      unitSystem: 'imperial',
      routeType: POINT_TO_POINT,
    });

    const middle = (plans: typeof metric) => plans[2]!.label;
    expect(middle(metric)).toMatch(/\d/);
    expect(middle(metric)).not.toBe(middle(imperial));
  });

  it('honours a requested sample count, and never drops below the three fixed points', () => {
    const journey = makeProfile();
    expect(planSamples(journey, START_S, { count: 4 })).toHaveLength(4);
    expect(planSamples(journey, START_S, { count: 12 })).toHaveLength(12);
    // Asking for one point still yields start, finish and high point.
    expect(planSamples(journey, START_S, { count: 1 }).length).toBeGreaterThanOrEqual(2);
  });

  it('returns nothing for an empty journey', () => {
    expect(planSamples([], START_S)).toEqual([]);
  });
});
