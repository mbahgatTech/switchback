import { describe, expect, it } from 'vitest';
import type { ElevationPoint } from '@switchback/core';
import {
  FLYOVER_HEADING_MIN_M,
  FLYOVER_HEADING_S,
  FLYOVER_MAX_MS,
  FLYOVER_MAX_ZOOM,
  FLYOVER_MIN_MS,
  FLYOVER_MIN_ZOOM,
  FLYOVER_MS_PER_HIKING_HOUR,
  FLYOVER_PITCH,
  FLYOVER_RELIEF_CLEARANCE,
  FLYOVER_SECONDS_PER_SCREEN,
  type FlyoverPlan,
  distanceAtTimeS,
  flyoverOverview,
  flyoverZoom,
  planFlyover,
  poseAt,
} from '@switchback/geo';

/** `count` points at `spacingM` apart, running due east along the equator. */
function eastward(spacingM: number, count: number, eleAt: (distM: number) => number) {
  // 111_320 m per degree of longitude at the equator, the same constant the package uses, so
  // `distM` and the coordinates describe one line rather than two.
  return Array.from({ length: count }, (_, i) => ({
    distM: i * spacingM,
    eleM: eleAt(i * spacingM),
    lng: (i * spacingM) / 111_320,
    lat: 0,
  })) satisfies ElevationPoint[];
}

const FLAT = eastward(25, 401, () => 100); // 10 km, level
const CLIMB = eastward(25, 401, (d) => 100 + (d > 5_000 ? (d - 5_000) * 0.25 : 0));

describe('planFlyover', () => {
  it('refuses a route that cannot be flown rather than returning an empty plan', () => {
    expect(planFlyover([])).toBeNull();
    expect(planFlyover([{ distM: 0, eleM: 10, lng: 0, lat: 0 }])).toBeNull();
    // Two points at the same place: a degenerate ingest geometry, and a zero-length divisor.
    expect(
      planFlyover([
        { distM: 0, eleM: 10, lng: 0, lat: 0 },
        { distM: 0, eleM: 10, lng: 0, lat: 0 },
      ]),
    ).toBeNull();
  });

  it('runs for twelve screen seconds per modelled hour, inside the clamps', () => {
    const plan = planFlyover(FLAT)!;
    expect(plan.hikingTimeS / 3600).toBeCloseTo(1.99, 1);
    expect(plan.durationMs).toBeCloseTo((plan.hikingTimeS / 3600) * FLYOVER_MS_PER_HIKING_HOUR, -1);
    expect(plan.durationMs).toBeGreaterThan(FLYOVER_MIN_MS);
    expect(plan.durationMs).toBeLessThan(FLYOVER_MAX_MS);
  });

  it('floors a stroll and caps a thru-hike', () => {
    expect(planFlyover(eastward(25, 21, () => 0))!.durationMs).toBe(FLYOVER_MIN_MS);
    // Roughly the Pacific Crest Trail's 4,265 km, the row that forced the ceiling.
    expect(planFlyover(eastward(500, 8_531, () => 0))!.durationMs).toBe(FLYOVER_MAX_MS);
  });

  it('takes the pace options, so a slower hiker gets a longer film', () => {
    const brisk = planFlyover(FLAT, { paceFactor: 0.8 })!;
    const steady = planFlyover(FLAT, { paceFactor: 1.3 })!;
    expect(steady.durationMs).toBeGreaterThan(brisk.durationMs);
  });
});

describe('distanceAtTimeS', () => {
  it('inverts the pacing curve at both ends exactly', () => {
    const plan = planFlyover(CLIMB)!;
    expect(distanceAtTimeS(plan, 0)).toBe(0);
    expect(distanceAtTimeS(plan, plan.hikingTimeS)).toBe(plan.lengthM);
    // Past the end is the end, not an extrapolation off the front of the trail.
    expect(distanceAtTimeS(plan, plan.hikingTimeS * 2)).toBe(plan.lengthM);
    expect(distanceAtTimeS(plan, -5)).toBe(0);
    expect(distanceAtTimeS(plan, Number.NaN)).toBe(0);
  });

  it('is monotonic, so the camera never doubles back', () => {
    const plan = planFlyover(CLIMB)!;
    let previous = -1;
    for (let i = 0; i <= 200; i += 1) {
      const d = distanceAtTimeS(plan, (i / 200) * plan.hikingTimeS);
      expect(d).toBeGreaterThanOrEqual(previous);
      previous = d;
    }
  });

  it('advances at constant speed on level ground', () => {
    const plan = planFlyover(FLAT)!;
    expect(distanceAtTimeS(plan, plan.hikingTimeS / 2)).toBeCloseTo(plan.lengthM / 2, 0);
  });

  it('labours on the climb — the whole reason progress is not linear in distance', () => {
    const plan = planFlyover(CLIMB)!;
    // CLIMB is level for 5 km then a 25% grade for 5 km, so halfway through the running time
    // is well short of halfway along.
    const halfway = distanceAtTimeS(plan, plan.hikingTimeS / 2);
    expect(halfway).toBeGreaterThan(plan.lengthM * 0.6);
    const atFoot = plan.cumTimeS.find((_, i) => (plan.profile[i]?.distM ?? 0) >= 5_000);
    expect(atFoot! / plan.hikingTimeS).toBeLessThan(0.35);
  });
});

describe('poseAt', () => {
  const plan = planFlyover(FLAT)!;

  it('starts at the trailhead and lands on the far end', () => {
    expect(poseAt(plan, 0)!.distanceM).toBe(0);
    expect(poseAt(plan, 1)!.distanceM).toBeCloseTo(plan.lengthM, 6);
  });

  it('clamps progress rather than running off either end', () => {
    expect(poseAt(plan, -1)!.distanceM).toBe(poseAt(plan, 0)!.distanceM);
    expect(poseAt(plan, 4)!.distanceM).toBe(poseAt(plan, 1)!.distanceM);
    expect(poseAt(plan, Number.NaN)!.distanceM).toBe(0);
  });

  it('faces along the route', () => {
    for (const t of [0, 0.25, 0.5, 0.75]) {
      expect(poseAt(plan, t)!.bearing).toBeCloseTo(90, 1);
    }
  });

  it('keeps the approach heading on the final frame instead of snapping to north', () => {
    // Regression: the window used to narrow against the end of the route, so the last frames
    // read finer and finer geometry until the final one whipped.
    expect(poseAt(plan, 1)!.bearing).toBeCloseTo(90, 1);
  });

  it('turns through a hairpin rather than cutting the corner', () => {
    // Due east for 1 km, then due north for 1 km.
    const corner: ElevationPoint[] = [];
    for (let d = 0; d <= 1_000; d += 25) {
      corner.push({ distM: d, eleM: 0, lng: d / 111_320, lat: 0 });
    }
    for (let d = 25; d <= 1_000; d += 25) {
      corner.push({ distM: 1_000 + d, eleM: 0, lng: 1_000 / 111_320, lat: d / 111_320 });
    }
    const turn = planFlyover(corner)!;
    expect(poseAt(turn, 0.05)!.bearing).toBeCloseTo(90, 0);
    expect(poseAt(turn, 0.95)!.bearing).toBeCloseTo(0, 0);

    // The turn is centred half a window short of the corner, not at it: a 2 km stroll runs at
    // the minimum duration, so FLYOVER_HEADING_MIN_M wins and the heading spans 400 m. At
    // 800 m in, the near half is due east and the far half due north — exactly 45°.
    expect(poseAt(turn, 800 / 2_000)!.bearing).toBeCloseTo(45, 1);
    expect(poseAt(turn, 600 / 2_000)!.bearing).toBeGreaterThan(70);
    expect(poseAt(turn, 0.5)!.bearing).toBeCloseTo(0, 1);
  });

  it('reports the ground height, which is what a camera has to clear', () => {
    const climb = planFlyover(CLIMB)!;
    expect(poseAt(climb, 0)!.eleM).toBeCloseTo(100, 6);
    expect(poseAt(climb, 1)!.eleM).toBeCloseTo(100 + 5_000 * 0.25, 6);
  });
});

/**
 * Steadiness, not correctness: every individual pose was right when the camera was strobing.
 * ~300°/s is where a pan reads as a cut, which at 60 fps is 5° between frames.
 */
describe('poseAt — camera steadiness', () => {
  /** Builds a profile from a polyline in metres near the equator, at a constant grade. */
  function fromMetres(xy: readonly (readonly [number, number])[], grade: number) {
    let distM = 0;
    return xy.map(([x, y], i) => {
      const previous = xy[i - 1];
      if (previous) distM += Math.hypot(x - previous[0], y - previous[1]);
      return { distM, eleM: distM * grade, lng: x / 111_320, lat: y / 111_320 };
    }) satisfies ElevationPoint[];
  }

  /** The absolute change from bearing `a` to bearing `b`, wrapped into ±180. */
  function turn(a: number, b: number): number {
    return Math.abs(((b - a + 540) % 360) - 180);
  }

  /** Every frame-to-frame heading change over the whole film, at 60 fps. */
  function turnsPerFrame(plan: FlyoverPlan): number[] {
    const frames = Math.round((plan.durationMs / 1_000) * 60);
    const deltas: number[] = [];
    let previous: number | null = null;
    for (let i = 0; i <= frames; i += 1) {
      const bearing = poseAt(plan, i / frames)?.bearing;
      if (bearing === undefined) continue;
      if (previous !== null) deltas.push(turn(previous, bearing));
      previous = bearing;
    }
    return deltas;
  }

  /**
   * A switchback stack: forty 60 m traverses, each 20 m above the last, at a sustained 28% —
   * the shape of the routes that used to strobe. Two points per leg, as OSM traces one.
   */
  const STACK = fromMetres(
    Array.from({ length: 40 }, (_, leg) => {
      const y = leg * 20;
      return leg % 2 === 0
        ? ([
            [0, y],
            [60, y],
          ] as const)
        : ([
            [60, y],
            [0, y],
          ] as const);
    }).flat(),
    0.28,
  );

  /**
   * A long route at real coarse spacing — 6,000 points 725 m apart, the Pacific Crest Trail's
   * profile spacing — with a segment-to-segment lurch. At 4,349 km the flyover is against its
   * duration ceiling and the camera crosses 966 m per frame, more than a whole segment.
   *
   * Wound into slow loops so the whole fixture stays within a third of a degree of the equator,
   * where a degree of longitude really is the 111,320 m `distM` is accumulated in.
   */
  const COARSE = fromMetres(
    (() => {
      const xy: [number, number][] = [[0, 0]];
      for (let i = 1; i < 6_000; i += 1) {
        const radians = ((i * 1.2 + 40 * Math.sin(i * 2.399_96)) * Math.PI) / 180;
        const [x, y] = xy[i - 1]!;
        xy.push([x + 725 * Math.sin(radians), y + 725 * Math.cos(radians)]);
      }
      return xy;
    })(),
    0,
  );

  it('holds its heading through a stack of switchbacks', () => {
    const plan = planFlyover(STACK)!;
    // The 400 m floor spans five 80 m hairpin cycles, so the legs cancel and what is left is
    // the direction the stack is going: due north.
    for (let i = 0; i <= 40; i += 1) {
      expect(turn(0, poseAt(plan, i / 40)!.bearing)).toBeLessThan(12);
    }
    const deltas = turnsPerFrame(plan);
    expect(Math.max(...deltas)).toBeLessThan(5);
    expect(deltas.reduce((sum, d) => sum + d, 0)).toBeLessThan(720);
  });

  it('stops reading individual segments on a coarsely sampled route', () => {
    const plan = planFlyover(COARSE)!;
    expect(plan.durationMs).toBe(FLYOVER_MAX_MS);
    // Each segment's bearing swings ±40°, but two seconds of film is 116 km here — a hundred
    // and sixty segments — so the noise averages out.
    const deltas = turnsPerFrame(plan);
    expect(deltas.length).toBe(4_500);
    expect(Math.max(...deltas)).toBeLessThan(5);
  });

  it('does not whip on the last frame', () => {
    // Regression: the forward window was clipped to the route remaining, so it narrowed to
    // nothing and the Pacific Crest Trail's last frame turned 118°.
    for (const profile of [FLAT, CLIMB, STACK, COARSE]) {
      const plan = planFlyover(profile)!;
      const frames = Math.round((plan.durationMs / 1_000) * 60);
      const last = poseAt(plan, 1)!.bearing;
      const penultimate = poseAt(plan, (frames - 1) / frames)!.bearing;
      expect(turn(penultimate, last)).toBeLessThan(1);
    }
  });

  it('measures the heading across a floor of tread however slowly the camera is moving', () => {
    // On a short steep route the metre floor does the work, because Tobler puts the camera at
    // walking pace and two seconds of film is back inside the switchback stack.
    const plan = planFlyover(STACK)!;
    const treadPerFilmSecond = plan.lengthM / (plan.durationMs / 1_000);
    expect(treadPerFilmSecond * FLYOVER_HEADING_S).toBeLessThan(FLYOVER_HEADING_MIN_M);
    const long = planFlyover(COARSE)!;
    expect((long.lengthM / (long.durationMs / 1_000)) * FLYOVER_HEADING_S).toBeGreaterThan(
      FLYOVER_HEADING_MIN_M * 100,
    );
  });

  it('is a pure function of progress, so scrubbing and playing agree', () => {
    // True because smoothing is the window's shape, not a filter with a memory.
    const plan = planFlyover(STACK)!;
    const at = [0.1, 0.3, 0.5, 0.7, 0.9];
    const forwards = at.map((t) => poseAt(plan, t)!.bearing);
    const backwards = [...at].reverse().map((t) => poseAt(plan, t)!.bearing);
    expect([...backwards].reverse()).toEqual(forwards);
  });
});

describe('flyoverZoom', () => {
  // 134 km — long enough to hit the duration ceiling, so the zoom lands mid-range, not clamped.
  const LONG = planFlyover(eastward(500, 269, () => 0))!;
  // 12 km climbing 2,000 m: the fixture where the speed rule and the clearance rule disagree
  // by about two zoom levels.
  const MOUNTAIN = planFlyover(eastward(25, 481, (d) => 1_000 + d * (2_000 / 12_000)))!;

  /** A map the shape of the trail page's, so the numbers below are the ones users get. */
  const VIEW = { width: 1_024, height: 512 };

  /**
   * MapLibre's camera model inverted. Restated rather than imported so a change to the module's
   * constants has to be argued with an independent derivation, not just agreed with.
   */
  function cameraHeightM(zoom: number, latDeg: number, heightPx: number): number {
    const mPerPx = (78_271.516_964 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom;
    return 1.5 * heightPx * mPerPx * Math.cos((FLYOVER_PITCH * Math.PI) / 180);
  }

  it('doubling the map width adds exactly one zoom level', () => {
    expect(flyoverZoom(LONG, VIEW)).toBeCloseTo(
      flyoverZoom(LONG, { ...VIEW, width: VIEW.width / 2 }) + 1,
      6,
    );
    expect(flyoverZoom(LONG, VIEW)).toBeGreaterThan(FLYOVER_MIN_ZOOM);
    expect(flyoverZoom(LONG, VIEW)).toBeLessThan(FLYOVER_MAX_ZOOM);
  });

  it('crosses one screen width in the stated time', () => {
    const zoom = flyoverZoom(LONG, VIEW);
    // 78_271, not the 156_543 of the 256-pixel convention: MapLibre's world is 512 px at zoom 0.
    const mPerPx = (78_271.516_964 * Math.cos(0)) / 2 ** zoom;
    const screenSeconds = (VIEW.width * mPerPx) / (LONG.lengthM / (LONG.durationMs / 1_000));
    expect(screenSeconds).toBeCloseTo(FLYOVER_SECONDS_PER_SCREEN, 6);
  });

  it('clears the relief on a route the speed rule would fly into', () => {
    // Unaided, the speed rule asks for zoom 16.6 here — past the ceiling, so the camera would
    // sit ~340 m up over 2,000 m of mountain.
    const zoom = flyoverZoom(MOUNTAIN, VIEW);
    expect(zoom).toBeLessThan(FLYOVER_MAX_ZOOM - 0.5);
    expect(cameraHeightM(zoom, 0, VIEW.height)).toBeCloseTo(2_000 * FLYOVER_RELIEF_CLEARANCE, 0);
  });

  it('flies higher when the renderer is exaggerating the terrain', () => {
    // The profile is real metres but the mesh is drawn at 1.2×, and it is the mesh to clear.
    const plain = flyoverZoom(MOUNTAIN, VIEW);
    const exaggerated = flyoverZoom(MOUNTAIN, VIEW, { exaggeration: 1.2 });
    expect(exaggerated).toBeLessThan(plain);
    expect(cameraHeightM(exaggerated, 0, VIEW.height)).toBeCloseTo(
      2_000 * 1.2 * FLYOVER_RELIEF_CLEARANCE,
      0,
    );
  });

  it('leaves a flat route to the speed rule, whatever the exaggeration', () => {
    expect(flyoverZoom(LONG, VIEW, { exaggeration: 5 })).toBe(flyoverZoom(LONG, VIEW));
  });

  it('reads height for clearance and width for speed, not one for both', () => {
    expect(flyoverZoom(MOUNTAIN, { ...VIEW, height: VIEW.height / 2 })).toBeCloseTo(
      flyoverZoom(MOUNTAIN, VIEW) - 1,
      6,
    );
    expect(flyoverZoom(LONG, { ...VIEW, height: VIEW.height * 2 })).toBe(flyoverZoom(LONG, VIEW));
  });

  it('flies low over a short hike and high over a continent', () => {
    expect(flyoverZoom(planFlyover(eastward(25, 21, () => 0))!, VIEW)).toBe(FLYOVER_MAX_ZOOM);
    expect(flyoverZoom(planFlyover(eastward(500, 8_531, () => 0))!, VIEW)).toBe(FLYOVER_MIN_ZOOM);
  });

  it('pulls back nearer the poles, where a Mercator pixel covers less ground', () => {
    const north = planFlyover(
      Array.from({ length: 269 }, (_, i) => ({
        distM: i * 500,
        eleM: 0,
        lng: (i * 500) / 111_320,
        lat: 60,
      })),
    )!;
    expect(flyoverZoom(north, VIEW)).toBeLessThan(flyoverZoom(LONG, VIEW));
  });

  it('gives a usable zoom rather than a NaN for a viewport that has not been measured', () => {
    // Zero is what `clientWidth` reports before layout, and a NaN zoom reaching `jumpTo` throws
    // inside MapLibre with nothing pointing back here.
    expect(flyoverZoom(LONG, { width: 0, height: 0 })).toBe(FLYOVER_MIN_ZOOM);
    expect(flyoverZoom(LONG, { ...VIEW, height: 0 })).toBe(FLYOVER_MIN_ZOOM);
    expect(flyoverZoom(LONG, { width: Number.NaN, height: Number.NaN })).toBe(FLYOVER_MIN_ZOOM);
  });
});

describe('flyoverOverview', () => {
  it('centres the high point and faces it from the body of the hike', () => {
    const plan = planFlyover(CLIMB)!;
    const pose = flyoverOverview(plan)!;
    expect(pose.distanceM).toBeCloseTo(plan.lengthM, 6);
    expect(pose.bearing).toBeCloseTo(90, 1);
  });

  it('still has a direction to face when the hike starts under the summit', () => {
    // Out and back: start and finish coincide, and the midpoint vantage is the summit itself.
    const there = eastward(25, 81, (d) => d * 0.1);
    const back = there
      .slice(0, -1)
      .reverse()
      .map((p, i) => ({ ...p, distM: 2_000 + (i + 1) * 25 }));
    const pose = flyoverOverview(planFlyover([...there, ...back])!)!;
    expect(pose).not.toBeNull();
    expect(Number.isFinite(pose.bearing)).toBe(true);
    expect(pose.eleM).toBeCloseTo(200, 6);
  });
});
