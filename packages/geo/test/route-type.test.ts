import { describe, expect, it } from 'vitest';
import type { LngLat } from '@switchback/core';
import {
  MAX_SPUR_LENGTH_M,
  MIN_DEAD_END_CLIMB_M,
  MIN_SPUR_LENGTH_M,
  TERMINAL_DESTINATIONS,
  TOP_TOLERANCE_M,
  classifyRouteType,
  climbsToADeadEnd,
  endpointSeparationM,
  hasImpliedReturnLeg,
  isTerminalDestination,
  isTraverse,
  namesACircuit,
  namesAThoroughfare,
  retraceFraction,
  roundTripMultiplier,
  terminusKinds,
} from '@switchback/geo';
import { lineNorth, offset, outAndBack, square } from './helpers';

/** Trailhead → stem → loop → back down the same stem. The classic lollipop. */
function lollipop(origin: LngLat, stemM: number, sideM: number): LngLat[] {
  const stem = lineNorth(origin, stemM, 5);
  const junction = stem[stem.length - 1]!;
  const loop = square(junction, sideM);
  return [...stem, ...loop.slice(1), ...stem.slice(0, -1).reverse()];
}

describe('classifyRouteType', () => {
  it('classifies a circuit as a loop', () => {
    expect(classifyRouteType(square([0, 45], 500))).toBe('loop');
  });

  it('classifies a there-and-back as out_and_back, not as a loop', () => {
    // Regression: closure used to be tested before retracing, which labelled every
    // out-and-back a loop — hiking back to the car closes the line exactly as a
    // circuit does, so the endpoints alone cannot tell the two apart.
    expect(classifyRouteType(outAndBack([0, 45], 2000))).toBe('out_and_back');
  });

  it('classifies a one-way traverse as point_to_point', () => {
    expect(classifyRouteType(lineNorth([0, 45], 3000, 10))).toBe('point_to_point');
  });

  it('classifies a lollipop as a loop — the stem is too short to read as retracing', () => {
    expect(classifyRouteType(lollipop([0, 45], 300, 600))).toBe('loop');
  });

  it('honours the closure threshold for a near-miss circuit', () => {
    const nearlyClosed = square([0, 45], 500).slice(0, -1); // stops ~62 m short
    expect(classifyRouteType(nearlyClosed, 200)).toBe('loop');
    expect(classifyRouteType(nearlyClosed, 10)).toBe('point_to_point');
  });

  it('does not call a short line anything but point_to_point', () => {
    expect(classifyRouteType([])).toBe('point_to_point');
    expect(
      classifyRouteType([
        [0, 45],
        [0, 45.01],
      ]),
    ).toBe('point_to_point');
  });
});

describe('retraceFraction', () => {
  it('is near 1 for an out-and-back', () => {
    // Everything but the turnaround neighbourhood is hiked twice.
    expect(retraceFraction(outAndBack([0, 45], 2000))).toBeGreaterThan(0.8);
  });

  it('is near 0 for a loop, which returns to its start without doubling back', () => {
    expect(retraceFraction(square([0, 45], 500))).toBeLessThan(0.2);
  });

  it('is 0 for a straight line', () => {
    expect(retraceFraction(lineNorth([0, 45], 3000, 40))).toBe(0);
  });

  it('is not fooled by a parallel path 100 m away', () => {
    // Two paths either side of a valley are not one path hiked twice.
    const there = lineNorth([0, 45], 2000, 21);
    const backAcrossTheValley = there
      .slice(0, -1)
      .reverse()
      .map((p) => offset(p, 0, 100));
    expect(retraceFraction([...there, ...backAcrossTheValley])).toBeLessThan(0.2);
  });

  it('is 0 for a line too short to have a non-trivial second visit', () => {
    expect(retraceFraction(lineNorth([0, 45], 100, 10))).toBe(0);
    expect(
      retraceFraction([
        [0, 45],
        [0, 45.01],
      ]),
    ).toBe(0);
  });
});

describe('roundTripMultiplier', () => {
  it('doubles out-and-back figures to match how guidebooks quote them', () => {
    expect(roundTripMultiplier('out_and_back')).toBe(2);
  });

  it('leaves loops and traverses alone', () => {
    expect(roundTripMultiplier('loop')).toBe(1);
    expect(roundTripMultiplier('point_to_point')).toBe(1);
  });
});

describe('endpointSeparationM', () => {
  it('is ~0 for a circuit', () => {
    expect(endpointSeparationM(square([0, 45], 500))).toBeCloseTo(0, 6);
  });

  it('measures the shuttle distance for a traverse', () => {
    expect(endpointSeparationM(lineNorth([0, 45], 3000, 10))).toBeCloseTo(3000, -1);
  });

  it('is 0 when there are not two ends', () => {
    expect(endpointSeparationM([])).toBe(0);
    expect(endpointSeparationM([[0, 45]])).toBe(0);
  });
});

/**
 * The Pyg Track problem: a path drawn once, from a car park to a summit. Geometry alone can
 * only call it point-to-point, and it is hiked out and back by everybody who hikes it.
 *
 * The fixture is that path — 4 km north, with whatever features are named at each end.
 */
const TRAILHEAD: LngLat = [-4.076, 53.079];
const PATH = lineNorth(TRAILHEAD, 4000, 21);
const SUMMIT = PATH[PATH.length - 1]!;

describe('terminusKinds', () => {
  it('finds a summit sitting just off the last vertex', () => {
    // Peak nodes are tagged on the true high point, which is rarely the last point a
    // mapper drew — 40 m off is normal and must still count as "at the end".
    const kinds = terminusKinds(PATH, [{ at: offset(SUMMIT, 30, 25), kind: 'summit' }]);
    expect(kinds.end).toEqual(['summit']);
    expect(kinds.start).toEqual([]);
  });

  it('ignores a peak the path merely passes below', () => {
    const halfway = PATH[10]!;
    const kinds = terminusKinds(PATH, [{ at: offset(halfway, 0, 60), kind: 'summit' }]);
    expect(kinds).toEqual({ start: [], end: [] });
  });

  it('measures straight-line from the endpoint, not along the trail', () => {
    // A car park 100 m from the trailhead is at the start even though the hike never
    // touches it; its along-trail distance would be meaningless here.
    const kinds = terminusKinds(PATH, [{ at: offset(TRAILHEAD, -80, 40), kind: 'parking' }]);
    expect(kinds.start).toEqual(['parking']);
  });

  it('honours a tightened radius', () => {
    const kinds = terminusKinds(PATH, [{ at: offset(SUMMIT, 100, 0), kind: 'summit' }], 50);
    expect(kinds.end).toEqual([]);
  });

  it('has nothing to say about a line with fewer than two points', () => {
    expect(terminusKinds([], [{ at: TRAILHEAD, kind: 'summit' }])).toEqual({ start: [], end: [] });
    expect(terminusKinds([TRAILHEAD], [{ at: TRAILHEAD, kind: 'summit' }])).toEqual({
      start: [],
      end: [],
    });
  });
});

describe('isTerminalDestination', () => {
  it('counts the places a hike finishes', () => {
    expect(TERMINAL_DESTINATIONS.every(isTerminalDestination)).toBe(true);
  });

  it('does not count a feature that says nothing about whether the ground continues', () => {
    // Every one of these is routinely passed through on the way to somewhere else.
    for (const kind of ['parking', 'gate', 'ford', 'junction', 'toilets', 'water'] as const) {
      expect(isTerminalDestination(kind)).toBe(false);
    }
  });

  it('excludes huts and campsites, which are as often a stop as an end', () => {
    expect(isTerminalDestination('shelter')).toBe(false);
    expect(isTerminalDestination('campsite')).toBe(false);
  });
});

describe('namesACircuit', () => {
  it('reads the mapper saying the hike comes back round the other way', () => {
    // Yosemite's Valley Loop Trail is stored as an unclosed 8.3 km line with a viewpoint at
    // one end — every geometric test says "spur", and doubling it would invent a descent.
    expect(namesACircuit('Valley Loop Trail')).toBe(true);
    expect(namesACircuit('Circular Hike')).toBe(true);
    expect(namesACircuit('Rundweg Feldberg')).toBe(true);
    expect(namesACircuit('Boucle du Lac')).toBe(true);
  });

  it('needs the whole word, not a substring of one', () => {
    expect(namesACircuit('Loophole Lane')).toBe(false);
    expect(namesACircuit('Circulation Trail')).toBe(false);
  });

  it('has nothing to say about an unnamed line', () => {
    expect(namesACircuit(undefined)).toBe(false);
    expect(namesACircuit(null)).toBe(false);
    expect(namesACircuit('')).toBe(false);
  });
});

describe('hasImpliedReturnLeg', () => {
  it('calls a car-park-to-summit spur an out-and-back', () => {
    expect(hasImpliedReturnLeg({ start: ['parking'], end: ['summit'] }, 4000)).toBe(true);
  });

  it('does not care which end the destination is on', () => {
    // Ingest reads the termini off the stored line and `orientUphill` may flip it
    // afterwards, so the test has to be symmetric or the answer would depend on which
    // direction a mapper happened to draw in.
    expect(hasImpliedReturnLeg({ start: ['summit'], end: [] }, 4000)).toBe(true);
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, 4000)).toBe(true);
  });

  it('leaves a ridge traverse between two summits alone', () => {
    // Crib Goch to Snowdon. Both ends are somewhere; the hike genuinely ends elsewhere.
    expect(hasImpliedReturnLeg({ start: ['summit'], end: ['summit'] }, 4000)).toBe(false);
  });

  it('leaves a path between two villages alone', () => {
    expect(hasImpliedReturnLeg({ start: ['parking'], end: ['gate'] }, 4000)).toBe(false);
    expect(hasImpliedReturnLeg({ start: [], end: [] }, 4000)).toBe(false);
  });

  it('refuses a line too long to hike twice', () => {
    // A stage of a long-distance route that happens to end near a peak. Doubling it would
    // be a large, confident, and very visible error.
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, MAX_SPUR_LENGTH_M)).toBe(true);
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, MAX_SPUR_LENGTH_M + 1)).toBe(false);
  });

  it('refuses a line too short for the endpoint test to mean anything', () => {
    // At 400 m the 150 m radius covers most of the line, so "at the end" and "near this
    // path" stop being different statements and the verdict would turn on drawing order.
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, MIN_SPUR_LENGTH_M)).toBe(true);
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, MIN_SPUR_LENGTH_M - 1)).toBe(false);
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, 400)).toBe(false);
  });

  it('refuses a length it cannot trust', () => {
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, 0)).toBe(false);
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, -1)).toBe(false);
    expect(hasImpliedReturnLeg({ start: [], end: ['summit'] }, Number.NaN)).toBe(false);
  });

  it('reads through the other things tagged at an endpoint', () => {
    // A summit with a shelter and a guidepost on it is still a summit.
    expect(
      hasImpliedReturnLeg({ start: ['parking', 'toilets'], end: ['shelter', 'summit'] }, 4000),
    ).toBe(true);
  });
});

describe('namesAThoroughfare', () => {
  it('reads the French generic that says "lane", not "path"', () => {
    // The Upper Savoy block the climb rule got wrong on its first pass. A mountain path in
    // France is a *sentier*; these climb from a valley to an alp and genuinely carry on.
    expect(namesAThoroughfare('Chemin de Méry')).toBe(true);
    expect(namesAThoroughfare('Chemin de Gers à Béné')).toBe(true);
    expect(namesAThoroughfare('Route des Lys')).toBe(true);
    expect(namesAThoroughfare('Voie Romaine')).toBe(true);
  });

  it('reads roads named in English and German', () => {
    expect(namesAThoroughfare('Forest Route 1N10')).toBe(true);
    expect(namesAThoroughfare('Old Mine Road')).toBe(true);
    expect(namesAThoroughfare('Forstweg Hinterstein')).toBe(true);
    expect(namesAThoroughfare('Strada del Passo')).toBe(true);
    // A US Forest Service truck trail is a fire road, whatever the second word says.
    expect(namesAThoroughfare('Moss Canyon Truck Trail')).toBe(true);
  });

  it('reads the mapper asserting a through-route in so many words', () => {
    // What `isTraverse` reads off two tagged endpoints, said out loud — and it works on the
    // lines that have nothing tagged at either end, which is where the climb rule operates.
    expect(namesAThoroughfare('Commonwealth Traverse Route')).toBe(true);
    expect(namesAThoroughfare('Mount Morrison Traverse Route')).toBe(true);
  });

  it('leaves a scrambling route alone, which is the whole reason the pattern is anchored', () => {
    // Canadian scrambling puts "Route" at the end, and every one of these is a summit
    // approach hiked out and back — exactly what the climb rule is right about.
    expect(namesAThoroughfare("Read's Tower Route")).toBe(false);
    expect(namesAThoroughfare('Little Sister Route')).toBe(false);
    expect(namesAThoroughfare('Grotto Mountain West Ridge Route')).toBe(false);
  });

  it('needs the whole word, and knows an accented letter is one', () => {
    // `\b` is ASCII-only and would call "Cheminée" a chemin — a chimney is a climbing
    // feature, not a lane. "Broadway" contains "road" and is likewise not a road.
    expect(namesAThoroughfare('Broadway Ledge')).toBe(false);
    expect(namesAThoroughfare('Cheminée du Diable')).toBe(false);
    expect(namesAThoroughfare("Route d'Aussois")).toBe(true);
  });

  it('has nothing to say about an unnamed line', () => {
    expect(namesAThoroughfare(undefined)).toBe(false);
    expect(namesAThoroughfare(null)).toBe(false);
    expect(namesAThoroughfare('')).toBe(false);
  });
});

describe('isTraverse', () => {
  it('recognises a ridge hike between two summits', () => {
    expect(isTraverse({ start: ['summit'], end: ['summit'] })).toBe(true);
    expect(isTraverse({ start: ['parking', 'summit'], end: ['shelter', 'viewpoint'] })).toBe(true);
  });

  it('is not a traverse when only one end is a destination', () => {
    expect(isTraverse({ start: ['parking'], end: ['summit'] })).toBe(false);
    expect(isTraverse({ start: ['summit'], end: [] })).toBe(false);
  });

  it('is not a traverse when OSM has told us nothing', () => {
    // The case `climbsToADeadEnd` exists for. Absence of evidence is not evidence of a
    // traverse, so the veto must not fire here.
    expect(isTraverse({ start: [], end: [] })).toBe(false);
    expect(isTraverse({ start: ['gate'], end: ['junction'] })).toBe(false);
  });
});

describe('climbsToADeadEnd', () => {
  /** Snowdon's Pyg Track: 4.6 km, 623 m of climb, and its last 125 m drop 0.4 m onto the ridge. */
  const PYG = { netGainM: 623, dropFromTopM: 0.4, lengthM: 4624 };

  it('reads a path that climbs hard and stops at the top as a summit approach', () => {
    // The gap the terminus rule leaves: the Pyg Track ends at the ridge junction, several
    // hundred metres from the summit node, so nothing is tagged within the 150 m radius.
    expect(climbsToADeadEnd(PYG)).toBe(true);
    expect(climbsToADeadEnd({ ...PYG, dropFromTopM: 0 })).toBe(true);
  });

  it('leaves a path over a pass alone', () => {
    // The distinguishing shape. A mapper who drew a path over a col drew the descent too,
    // so its high point sits in the middle — and ground that continues is not a destination.
    expect(climbsToADeadEnd({ ...PYG, dropFromTopM: 150 })).toBe(false);
  });

  it('tolerates the few metres a summit plateau and a DEM sample actually wander', () => {
    // Read as exact argmax this rule missed the Pyg Track (0.4 m) and the Snowdon Ranger
    // Path (4.2 m). The Miners' Track drops 42 m to Llyn Llydaw and must still be refused.
    expect(climbsToADeadEnd({ ...PYG, dropFromTopM: 4.2 })).toBe(true);
    expect(climbsToADeadEnd({ ...PYG, dropFromTopM: TOP_TOLERANCE_M })).toBe(true);
    expect(climbsToADeadEnd({ ...PYG, dropFromTopM: TOP_TOLERANCE_M + 0.1 })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, dropFromTopM: 42 })).toBe(false);
  });

  it('needs a mountain, not a hillside', () => {
    // Below the bar are valley paths that climb to a road on a shelf and genuinely carry on.
    expect(climbsToADeadEnd({ ...PYG, netGainM: MIN_DEAD_END_CLIMB_M })).toBe(true);
    expect(climbsToADeadEnd({ ...PYG, netGainM: MIN_DEAD_END_CLIMB_M - 1 })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, netGainM: 0 })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, netGainM: -500 })).toBe(false);
  });

  it('honours the same length band as the terminus rule', () => {
    expect(climbsToADeadEnd({ ...PYG, lengthM: MIN_SPUR_LENGTH_M })).toBe(true);
    expect(climbsToADeadEnd({ ...PYG, lengthM: MIN_SPUR_LENGTH_M - 1 })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, lengthM: MAX_SPUR_LENGTH_M })).toBe(true);
    expect(climbsToADeadEnd({ ...PYG, lengthM: MAX_SPUR_LENGTH_M + 1 })).toBe(false);
  });

  it('refuses numbers it cannot trust', () => {
    expect(climbsToADeadEnd({ ...PYG, lengthM: Number.NaN })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, netGainM: Number.NaN })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, dropFromTopM: Number.NaN })).toBe(false);
  });

  it('takes overrides, so a caller can tighten it without editing this file', () => {
    expect(climbsToADeadEnd({ ...PYG, minClimbM: 700 })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, maxLengthM: 4000 })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, minLengthM: 5000 })).toBe(false);
    expect(climbsToADeadEnd({ ...PYG, topToleranceM: 0 })).toBe(false);
  });
});
