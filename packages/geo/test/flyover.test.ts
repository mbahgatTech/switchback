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

/**
 * The thing worth protecting is the pacing.
 *
 * A flyover that advanced at constant metres per second would pass every test you would
 * think to write about poses — it starts at the start, ends at the end, faces along the
 * route. What it would not do is slow down on the climb, which is the entire reason this
 * module exists rather than a `for` loop over the coordinate list. So the load-bearing tests
 * below are the ones that compare a flat half against a steep half and insist the camera
 * spends more of its running time on the steep one.
 *
 * Bearings are checked on a synthetic route that runs due east, where the right answer is 90
 * and any smoothing bug shows up as a number that is not 90.
 */

/** `count` points at `spacingM` apart, running due east along the equator. */
function eastward(spacingM: number, count: number, eleAt: (distM: number) => number) {
  // A degree of longitude at the equator is 111_320 m by the same constant the rest of the
  // package uses, so `distM` and the coordinates describe the same line rather than two.
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
    // Two points at the same place: a real row in the database when an ingest pass has
    // written a degenerate geometry, and a zero-length flyover would divide by it.
    expect(
      planFlyover([
        { distM: 0, eleM: 10, lng: 0, lat: 0 },
        { distM: 0, eleM: 10, lng: 0, lat: 0 },
      ]),
    ).toBeNull();
  });

  it('runs for twelve screen seconds per modelled hour, inside the clamps', () => {
    const plan = planFlyover(FLAT)!;
    // 10 km of level ground is a shade under two hours at Tobler's flat pace.
    expect(plan.hikingTimeS / 3600).toBeCloseTo(1.99, 1);
    expect(plan.durationMs).toBeCloseTo((plan.hikingTimeS / 3600) * FLYOVER_MS_PER_HIKING_HOUR, -1);
    expect(plan.durationMs).toBeGreaterThan(FLYOVER_MIN_MS);
    expect(plan.durationMs).toBeLessThan(FLYOVER_MAX_MS);
  });

  it('floors a stroll and caps a thru-hike', () => {
    expect(planFlyover(eastward(25, 21, () => 0))!.durationMs).toBe(FLYOVER_MIN_MS);
    // Roughly the Pacific Crest Trail's 4,265 km, which is the row that forced the ceiling.
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
    // Halfway through a flat hike is halfway along it, which is the baseline the climb case
    // below has to differ from for the pacing to be doing anything at all.
    expect(distanceAtTimeS(plan, plan.hikingTimeS / 2)).toBeCloseTo(plan.lengthM / 2, 0);
  });

  it('labours on the climb — the whole reason progress is not linear in distance', () => {
    const plan = planFlyover(CLIMB)!;
    // CLIMB is level for 5 km and then a 25% grade for 5 km. At the halfway point of the
    // running time the camera should be well short of halfway along, because the second half
    // of the route costs far more time than the first.
    const halfway = distanceAtTimeS(plan, plan.hikingTimeS / 2);
    expect(halfway).toBeGreaterThan(plan.lengthM * 0.6);
    // And by the time it reaches the foot of the climb, most of the film is still to come.
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
    // There is no ground ahead of the last point to measure a heading across, so the window
    // slides back off the end rather than narrowing against it, and the camera lands facing
    // the way it came in. Narrow it instead and the last frames read finer and finer geometry
    // until the final one whips — which is what they used to do.
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

    // Where the turn happens, exactly, and it is not at the corner.
    //
    // A 2 km stroll runs at the minimum duration, so two seconds of film is only 267 m of
    // tread and FLYOVER_HEADING_MIN_M wins: the heading here is measured across 400 m, as
    // the displacement from the mean of the first 200 m to the mean of the second. Those two
    // halves straddle the corner evenly when the window starts one half-width short of it —
    // 800 m in — where the near half is due east and the far half due north and the answer
    // is exactly 45°. The route is level, so progress is linear in distance and that is
    // 800/2000 of the film.
    expect(poseAt(turn, 800 / 2_000)!.bearing).toBeCloseTo(45, 1);
    // Half a window earlier the turn has begun but is nowhere near through it...
    expect(poseAt(turn, 600 / 2_000)!.bearing).toBeGreaterThan(70);
    // ...and by the corner itself it has finished, rather than starting to.
    expect(poseAt(turn, 0.5)!.bearing).toBeCloseTo(0, 1);
  });

  it('reports the ground height, which is what a camera has to clear', () => {
    const climb = planFlyover(CLIMB)!;
    expect(poseAt(climb, 0)!.eleM).toBeCloseTo(100, 6);
    expect(poseAt(climb, 1)!.eleM).toBeCloseTo(100 + 5_000 * 0.25, 6);
  });
});

/**
 * How steady the camera is, which is a different question from where it is pointing.
 *
 * Every test above asks whether a pose is right. None of them would have caught what was
 * actually wrong with this module, because every individual pose *was* right: the camera
 * faced along the trail at every instant, and the trail changed direction eight times a
 * second. The complaint that produced these tests was "the camera angle switches too much",
 * and the only way to state that as an assertion is to sample the whole film at the frame
 * rate it is played back at and look at the differences.
 *
 * The threshold worth knowing: about 300°/s is where a pan stops reading as a pan and starts
 * reading as a cut, and at 60 fps that is 5° between one frame and the next. Measured across
 * the two hundred steepest trails in the database, the old single-point heading put 2.8% of
 * all frames over that line and turned a total of 552,685° — the model here turns 228,976°
 * over the same geometry with 0.4% of frames over it, and its worst single frame anywhere in
 * the corpus is 21° against the old model's 180°.
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
   * A switchback stack: forty 60 m traverses up a hillside, each 20 m above the last, at a
   * sustained 28% — which is `mad-river-trail` and `comfortably-numb-secret-trail` and every
   * other route at the top of the corpus by gain per metre, all of which used to strobe. Two
   * points per leg, because that is how OSM traces a switchback and the sparseness is part
   * of the problem.
   *
   * The route climbs due north overall and reverses its heading through 180° every 80 m.
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
   * A long route sampled as coarsely as a real one — 6,000 points 725 m apart, which is the
   * Pacific Crest Trail's actual profile spacing in this database — with a heading that
   * lurches segment to segment the way a way traced from aerial imagery does. 4,349 km, so
   * the flyover is pinned against its duration ceiling and the camera crosses 966 m between
   * one frame and the next: more than a whole segment. That is the regime a heading taken
   * from a point 150 m ahead could not survive at all, because 150 m never left the segment
   * the camera was standing on and so reported its raw OSM bearing, a new one every frame.
   *
   * It is wound into slow loops rather than sent off in one direction so the whole of it
   * stays within a third of a degree of the equator, where a degree of longitude really is
   * the 111,320 m that `distM` is accumulated in. A fixture that marched 4,000 km north
   * would be one whose coordinates and whose distances described two different lines.
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
    // The window is the 400 m floor here, which spans five of the 80 m hairpin cycles, so
    // the legs cancel against each other and what is left is the direction the stack is
    // going: due north. It wanders a few degrees either side as the window slides across
    // the half-cycle it cannot pair off, and that is the whole of the motion.
    for (let i = 0; i <= 40; i += 1) {
      expect(turn(0, poseAt(plan, i / 40)!.bearing)).toBeLessThan(12);
    }
    // Nowhere near the 300°/s that reads as a cut rather than a pan. And the film as a whole
    // turns through less than two revolutions of slow drift: the real route this fixture is
    // modelled on, `comfortably-numb-secret-trail`, used to turn 7,293° — twenty revolutions
    // in forty-nine seconds, with 392 of its frames over the 300°/s line.
    const deltas = turnsPerFrame(plan);
    expect(Math.max(...deltas)).toBeLessThan(5);
    expect(deltas.reduce((sum, d) => sum + d, 0)).toBeLessThan(720);
  });

  it('stops reading individual segments on a coarsely sampled route', () => {
    const plan = planFlyover(COARSE)!;
    expect(plan.durationMs).toBe(FLYOVER_MAX_MS);
    // Each segment's own bearing swings ±40° against its neighbours'. The heading is measured
    // across two seconds of film, which at this ground speed is 116 km — a hundred and sixty
    // segments — so the noise averages out and what is left is the shape of the route.
    const deltas = turnsPerFrame(plan);
    expect(deltas.length).toBe(4_500);
    expect(Math.max(...deltas)).toBeLessThan(5);
  });

  it('does not whip on the last frame', () => {
    // The regression this test exists for: the forward window used to be clipped to whatever
    // route remained, so it narrowed to nothing over the final stretch and the heading read
    // finer and finer geometry as the film ended. On the Pacific Crest Trail the last frame
    // alone turned 118°, at the exact moment the reader is looking at the summit.
    for (const profile of [FLAT, CLIMB, STACK, COARSE]) {
      const plan = planFlyover(profile)!;
      const frames = Math.round((plan.durationMs / 1_000) * 60);
      const last = poseAt(plan, 1)!.bearing;
      const penultimate = poseAt(plan, (frames - 1) / frames)!.bearing;
      expect(turn(penultimate, last)).toBeLessThan(1);
    }
  });

  it('measures the heading across a floor of tread however slowly the camera is moving', () => {
    // Tobler puts the camera at walking pace on a headwall, where two seconds of film is a
    // couple of hundred metres — back inside the switchback stack the window exists to
    // average over. So the width is a span in seconds *or* a floor in metres, whichever is
    // more, and on a short steep route it is the floor doing the work.
    const plan = planFlyover(STACK)!;
    const treadPerFilmSecond = plan.lengthM / (plan.durationMs / 1_000);
    expect(treadPerFilmSecond * FLYOVER_HEADING_S).toBeLessThan(FLYOVER_HEADING_MIN_M);
    // And on the long route it is the span, by two orders of magnitude.
    const long = planFlyover(COARSE)!;
    expect((long.lengthM / (long.durationMs / 1_000)) * FLYOVER_HEADING_S).toBeGreaterThan(
      FLYOVER_HEADING_MIN_M * 100,
    );
  });

  it('is a pure function of progress, so scrubbing and playing agree', () => {
    // Smoothing by the shape of the window rather than by a filter with a memory is what
    // makes this true. An exponential average over previous frames would be fewer lines and
    // would make seeking to the middle of the film give a different heading from playing to
    // it — the scrub handle and the play button would disagree about where the camera faces.
    const plan = planFlyover(STACK)!;
    const at = [0.1, 0.3, 0.5, 0.7, 0.9];
    const forwards = at.map((t) => poseAt(plan, t)!.bearing);
    const backwards = [...at].reverse().map((t) => poseAt(plan, t)!.bearing);
    expect([...backwards].reverse()).toEqual(forwards);
  });
});

describe('flyoverZoom', () => {
  // 134 km — long enough to hit the duration ceiling, so the ground speed is high enough that
  // the zoom lands in the open middle of the range rather than against a clamp.
  const LONG = planFlyover(eastward(500, 269, () => 0))!;
  // 12 km climbing 2,000 m. Slow enough that the speed rule would put the camera on the deck,
  // and steep enough that doing so would bury it — this is the fixture the clearance rule is
  // for, and the two rules disagree by about two zoom levels on it.
  const MOUNTAIN = planFlyover(eastward(25, 481, (d) => 1_000 + d * (2_000 / 12_000)))!;

  /** A map the shape of the trail page's, so the numbers below are the ones users get. */
  const VIEW = { width: 1_024, height: 512 };

  /**
   * MapLibre's camera model, inverted: how far above the point it is looking at does a given
   * zoom put the camera? Restated here rather than imported so that a change to the module's
   * own constants has to be argued with an independent derivation, not just agreed with.
   */
  function cameraHeightM(zoom: number, latDeg: number, heightPx: number): number {
    const mPerPx = (78_271.516_964 * Math.cos((latDeg * Math.PI) / 180)) / 2 ** zoom;
    return 1.5 * heightPx * mPerPx * Math.cos((FLYOVER_PITCH * Math.PI) / 180);
  }

  it('doubling the map width adds exactly one zoom level', () => {
    // Which is the rule restated: one screen width of ground every FLYOVER_SECONDS_PER_SCREEN,
    // whatever the screen. If this drifts, a phone and a desktop are showing the same route at
    // different apparent speeds.
    expect(flyoverZoom(LONG, VIEW)).toBeCloseTo(
      flyoverZoom(LONG, { ...VIEW, width: VIEW.width / 2 }) + 1,
      6,
    );
    expect(flyoverZoom(LONG, VIEW)).toBeGreaterThan(FLYOVER_MIN_ZOOM);
    expect(flyoverZoom(LONG, VIEW)).toBeLessThan(FLYOVER_MAX_ZOOM);
  });

  it('crosses one screen width in the stated time', () => {
    const zoom = flyoverZoom(LONG, VIEW);
    // 78_271, not the 156_543 of the 256-pixel slippy-map convention: MapLibre's world is 512
    // pixels square at zoom 0, and getting this wrong flies every route one level too low.
    const mPerPx = (78_271.516_964 * Math.cos(0)) / 2 ** zoom;
    const screenSeconds = (VIEW.width * mPerPx) / (LONG.lengthM / (LONG.durationMs / 1_000));
    expect(screenSeconds).toBeCloseTo(FLYOVER_SECONDS_PER_SCREEN, 6);
  });

  it('clears the relief on a route the speed rule would fly into', () => {
    // Left to itself the speed rule asks for zoom 16.6 here — past the ceiling, so the camera
    // would sit at FLYOVER_MAX_ZOOM, which on this map is about 340 m up over 2,000 m of
    // mountain. The clearance rule is what pulls it back to something that can see a skyline.
    const zoom = flyoverZoom(MOUNTAIN, VIEW);
    expect(zoom).toBeLessThan(FLYOVER_MAX_ZOOM - 0.5);
    expect(cameraHeightM(zoom, 0, VIEW.height)).toBeCloseTo(2_000 * FLYOVER_RELIEF_CLEARANCE, 0);
  });

  it('flies higher when the renderer is exaggerating the terrain', () => {
    // The profile is in real metres but the mesh is drawn at 1.2×, and it is the mesh the
    // camera has to clear. Ignoring this is how the flight ends up inside a hillside that the
    // elevation section swears is 600 m below it.
    const plain = flyoverZoom(MOUNTAIN, VIEW);
    const exaggerated = flyoverZoom(MOUNTAIN, VIEW, { exaggeration: 1.2 });
    expect(exaggerated).toBeLessThan(plain);
    expect(cameraHeightM(exaggerated, 0, VIEW.height)).toBeCloseTo(
      2_000 * 1.2 * FLYOVER_RELIEF_CLEARANCE,
      0,
    );
  });

  it('leaves a flat route to the speed rule, whatever the exaggeration', () => {
    // Nothing to clear means nothing to answer for: a towpath is framed by how fast it goes
    // past and by nothing else, and exaggerating flat ground exaggerates nothing.
    expect(flyoverZoom(LONG, VIEW, { exaggeration: 5 })).toBe(flyoverZoom(LONG, VIEW));
  });

  it('reads height for clearance and width for speed, not one for both', () => {
    // A taller map holds the camera further from what it is looking at, so the same clearance
    // is bought a level closer in; a wider one is what changes the ground speed. A short, wide
    // map and a tall, narrow one of the same area are not the same flight.
    expect(flyoverZoom(MOUNTAIN, { ...VIEW, height: VIEW.height / 2 })).toBeCloseTo(
      flyoverZoom(MOUNTAIN, VIEW) - 1,
      6,
    );
    // ...and a speed-bound route does not care about the height at all.
    expect(flyoverZoom(LONG, { ...VIEW, height: VIEW.height * 2 })).toBe(flyoverZoom(LONG, VIEW));
  });

  it('flies low over a short hike and high over a continent', () => {
    // A 500 m stroll floors at the minimum duration, so it crawls — get close to the ground.
    expect(flyoverZoom(planFlyover(eastward(25, 21, () => 0))!, VIEW)).toBe(FLYOVER_MAX_ZOOM);
    // And the PCT caps at the maximum duration, so it bolts — pull back as far as the DEM is
    // worth rendering, and no further.
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
    // Zero is what `clientWidth` reports for a container that has not laid out yet, and a NaN
    // zoom reaching `jumpTo` throws inside MapLibre with nothing pointing back here.
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
    // The summit is at the east end and the mid-route vantage is west of it, so the camera
    // looks east. A bearing taken from the trailhead would give the same answer here — the
    // reason for the mid-route rule is the out-and-back below.
    expect(pose.bearing).toBeCloseTo(90, 1);
  });

  it('still has a direction to face when the hike starts under the summit', () => {
    // Out and back: up to a top 2 km east, then straight home. Start and finish coincide, so
    // a bearing measured from the trailhead to the high point and one measured from the
    // finish are the same — but a vantage taken at the *midpoint* is on the summit itself.
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
