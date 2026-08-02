import { describe, expect, it } from 'vitest';
import {
  FAR_END_FRACTION,
  MAX_APPROACH_M,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_SUMMIT_CLIMB_M,
  SUMMIT_TOP_TOLERANCE_M,
  deriveDisplayName,
  describeDisplayName,
  distinctiveWords,
  namesTheDestination,
  trailTitle,
  turnaroundM,
} from '@switchback/core';
import type { DestinationCandidate, DisplayNameInput } from '@switchback/core';

/** A trailhead sits on every trail ingest commits, so every fixture carries one. */
const TRAILHEAD: DestinationCandidate = { kind: 'trailhead', name: null, distM: 0, eleM: 400 };

function trail(over: Partial<DisplayNameInput> = {}): DisplayNameInput {
  return {
    name: 'Headlee Pass Trail',
    routeType: 'out_and_back',
    lengthM: 8000,
    gainM: 1200,
    maxEleM: 1850,
    waypoints: [TRAILHEAD],
    ...over,
  };
}

function summit(over: Partial<DestinationCandidate> = {}): DestinationCandidate {
  return { kind: 'summit', name: 'Vesper Peak', distM: 4000, eleM: 1850, ...over };
}

describe('deriveDisplayName — the name we would defend', () => {
  it('names an out-and-back for the summit at its high point', () => {
    expect(deriveDisplayName(trail({ waypoints: [TRAILHEAD, summit()] }))).toBe(
      'Vesper Peak via Headlee Pass Trail',
    );
  });

  it('reports which rule fired', () => {
    expect(describeDisplayName(trail({ waypoints: [TRAILHEAD, summit()] }))).toEqual({
      displayName: 'Vesper Peak via Headlee Pass Trail',
      destination: 'Vesper Peak',
      rule: 'summit',
    });
  });

  it('leaves a trail whose own name already contains the summit', () => {
    const input = trail({
      name: 'Mount Si Trail',
      waypoints: [TRAILHEAD, summit({ name: 'Mount Si' })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('leaves a trail the summit name contains, which plain containment misses', () => {
    const input = trail({
      name: 'Burroughs Mountain Trail',
      waypoints: [TRAILHEAD, summit({ name: '3rd Burroughs Mountain' })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('reads "Mt." and "Mount" as the same word', () => {
    const input = trail({
      name: 'Mt. Daniel',
      waypoints: [TRAILHEAD, summit({ name: 'Mount Daniel' })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('never emits "X via X"', () => {
    const input = trail({
      name: 'Spur Line Trail',
      waypoints: [TRAILHEAD, summit({ name: 'Spur Line Trail' })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('refuses a summit 400 m below the high point, however close to the trail', () => {
    const input = trail({
      maxEleM: 1850,
      waypoints: [TRAILHEAD, summit({ eleM: 1450 })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('accepts a summit within the tolerance and refuses one just outside it', () => {
    const at = (dropM: number) =>
      deriveDisplayName(trail({ waypoints: [TRAILHEAD, summit({ eleM: 1850 - dropM })] }));
    expect(at(SUMMIT_TOP_TOLERANCE_M)).toBe('Vesper Peak via Headlee Pass Trail');
    expect(at(SUMMIT_TOP_TOLERANCE_M + 1)).toBeNull();
  });

  it('refuses a long point-to-point that merely passes a peak', () => {
    // The Mid Wilts Way: 54 km of chalk downland that crosses Milk Hill at km 18.
    const input = trail({
      name: 'Mid Wilts Way',
      routeType: 'point_to_point',
      lengthM: 54_300,
      gainM: 734,
      maxEleM: 284,
      waypoints: [TRAILHEAD, summit({ name: 'Milk Hill', distM: 17_797, eleM: 276 })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('refuses a peak passed mid-walk even on a short trail', () => {
    const input = trail({
      name: 'Gunsight Trail',
      routeType: 'point_to_point',
      lengthM: 7978,
      gainM: 331,
      maxEleM: 1806,
      waypoints: [TRAILHEAD, summit({ name: 'Gunsight Butte', distM: 2366, eleM: 1806 })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('refuses when several named summits share the high point', () => {
    // French Creek Trail crosses three tops within 14 m of each other; nothing says which.
    const input = trail({
      name: 'French Creek Trail #3349',
      routeType: 'point_to_point',
      lengthM: 10_571,
      gainM: 470,
      maxEleM: 1519,
      waypoints: [
        TRAILHEAD,
        summit({ name: 'Boulder Peak', distM: 10_100, eleM: 1510 }),
        summit({ name: 'Byars Peak', distM: 10_400, eleM: 1506 }),
      ],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('refuses a summit on a walk with no real climb', () => {
    const under = trail({ gainM: MIN_SUMMIT_CLIMB_M - 1, waypoints: [TRAILHEAD, summit()] });
    const over = trail({ gainM: MIN_SUMMIT_CLIMB_M, waypoints: [TRAILHEAD, summit()] });
    expect(deriveDisplayName(under)).toBeNull();
    expect(deriveDisplayName(over)).toBe('Vesper Peak via Headlee Pass Trail');
  });

  it('names a loop for the summit it tops out on, with no position test', () => {
    const input = trail({
      name: 'Iller Creek Loop',
      routeType: 'loop',
      lengthM: 7958,
      gainM: 362,
      maxEleM: 1120,
      waypoints: [TRAILHEAD, summit({ name: 'Rocks of Sharon', distM: 2500, eleM: 1120 })],
    });
    expect(deriveDisplayName(input)).toBe('Rocks of Sharon via Iller Creek Loop');
  });

  it('refuses a circuit longer than the approach cap', () => {
    const input = trail({
      name: 'Buck Creek Trail',
      routeType: 'loop',
      lengthM: 2 * MAX_APPROACH_M,
      gainM: 1938,
      maxEleM: 1900,
      waypoints: [TRAILHEAD, summit({ name: 'Monte Carlo', distM: 12_000, eleM: 1900 })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });
});

describe('deriveDisplayName — destinations that are not summits', () => {
  const lake = (over: Partial<DestinationCandidate> = {}): DestinationCandidate => ({
    kind: 'lake',
    name: 'Snow Lake',
    distM: 3400,
    eleM: 1240,
    ...over,
  });

  it('names an out-and-back for the named lake at its far end', () => {
    const input = trail({
      name: 'Rock Creek Trail',
      lengthM: 7000,
      gainM: 400,
      waypoints: [TRAILHEAD, lake()],
    });
    expect(describeDisplayName(input)).toEqual({
      displayName: 'Snow Lake via Rock Creek Trail',
      destination: 'Snow Lake',
      rule: 'destination',
    });
  });

  it('refuses a lake passed a third of the way along', () => {
    const input = trail({
      name: 'Rock Creek Trail',
      lengthM: 7000,
      gainM: 400,
      waypoints: [TRAILHEAD, lake({ distM: 1100 })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('prefers the lake over the viewpoint beside it rather than calling it ambiguous', () => {
    const input = trail({
      name: 'Rock Creek Trail',
      lengthM: 7000,
      gainM: 400,
      waypoints: [
        TRAILHEAD,
        lake(),
        { kind: 'viewpoint', name: 'Snow Lake Overlook', distM: 3300, eleM: 1230 },
      ],
    });
    expect(deriveDisplayName(input)).toBe('Snow Lake via Rock Creek Trail');
  });

  it('refuses two waterfalls at the same far end', () => {
    const input = trail({
      name: 'Naturaland Trust Trail #14',
      lengthM: 8015,
      gainM: 580,
      waypoints: [
        TRAILHEAD,
        { kind: 'waterfall', name: 'Rock Cliff Falls', distM: 3250, eleM: 700 },
        { kind: 'waterfall', name: 'Firewater Falls', distM: 4080, eleM: 720 },
      ],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('refuses a point-to-point, which our own classifier declined to call a dead end', () => {
    const input = trail({
      name: 'Las Torres a Los Cuernos',
      routeType: 'point_to_point',
      lengthM: 10_233,
      gainM: 374,
      waypoints: [
        TRAILHEAD,
        { kind: 'waterfall', name: 'Cascada del Viajero', distM: 9100, eleM: 500 },
      ],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('refuses a destination whose name says nothing — "Viewpoint 630\'"', () => {
    const input = trail({
      name: 'Goldeneye',
      lengthM: 1231,
      gainM: 41,
      waypoints: [TRAILHEAD, { kind: 'viewpoint', name: "Viewpoint 630'", distM: 615, eleM: 200 }],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });

  it('refuses an OSM name that opens with a bracket or a quote', () => {
    const input = trail({
      name: 'Pazagnou',
      lengthM: 2500,
      gainM: 400,
      waypoints: [TRAILHEAD, summit({ name: '(Les Otanes)', distM: 1240 })],
    });
    expect(deriveDisplayName(input)).toBeNull();
  });
});

describe('deriveDisplayName — trails with no name of their own', () => {
  it('titles an unnamed trail with the destination alone', () => {
    const input = trail({ name: '', waypoints: [TRAILHEAD, summit()] });
    expect(deriveDisplayName(input)).toBe('Vesper Peak');
  });

  it('treats a bare classification as unnamed', () => {
    const input = trail({ name: 'footpath', waypoints: [TRAILHEAD, summit()] });
    expect(deriveDisplayName(input)).toBe('Vesper Peak');
  });

  it('keeps a name made only of landforms, which is still what the route is called', () => {
    const ridge = trail({ name: 'East Ridge Trail', waypoints: [TRAILHEAD, summit()] });
    expect(deriveDisplayName(ridge)).toBe('Vesper Peak via East Ridge Trail');
    const chemin = trail({
      name: 'Chemin de la Cascade',
      waypoints: [TRAILHEAD, { kind: 'waterfall', name: 'Pissevache', distM: 4000, eleM: 900 }],
    });
    expect(deriveDisplayName(chemin)).toBe('Pissevache via Chemin de la Cascade');
  });

  it('keeps a reference number, which is what locals call the trail', () => {
    const input = trail({ name: 'Trail 140', waypoints: [TRAILHEAD, summit()] });
    expect(deriveDisplayName(input)).toBe('Vesper Peak via Trail 140');
  });
});

describe('deriveDisplayName — refusals that are not about the destination', () => {
  it('returns null when there are no waypoints at all', () => {
    expect(deriveDisplayName(trail({ waypoints: [] }))).toBeNull();
  });

  it('ignores an unnamed summit', () => {
    expect(deriveDisplayName(trail({ waypoints: [TRAILHEAD, summit({ name: null })] }))).toBeNull();
  });

  it('ignores a summit with no distance along the trail', () => {
    expect(
      deriveDisplayName(trail({ waypoints: [TRAILHEAD, summit({ distM: null })] })),
    ).toBeNull();
  });

  it('ignores a summit with no elevation', () => {
    expect(deriveDisplayName(trail({ waypoints: [TRAILHEAD, summit({ eleM: null })] }))).toBeNull();
  });

  it('survives NaN lengths and elevations rather than emitting a name from them', () => {
    expect(
      deriveDisplayName(trail({ lengthM: Number.NaN, waypoints: [TRAILHEAD, summit()] })),
    ).toBeNull();
    expect(
      deriveDisplayName(trail({ maxEleM: Number.NaN, waypoints: [TRAILHEAD, summit()] })),
    ).toBeNull();
  });

  it('refuses a name too long to read', () => {
    const long = 'National Forest Development Road 755 in the Umpqua National Forest';
    const input = trail({ name: long, waypoints: [TRAILHEAD, summit()] });
    expect(`Vesper Peak via ${long}`.length).toBeGreaterThan(MAX_DISPLAY_NAME_LENGTH);
    expect(deriveDisplayName(input)).toBeNull();
  });
});

describe('turnaroundM', () => {
  it('halves an out-and-back, because its published length is the round trip', () => {
    expect(turnaroundM('out_and_back', 8000)).toBe(4000);
    expect(turnaroundM('point_to_point', 8000)).toBe(8000);
    expect(turnaroundM('loop', 8000)).toBe(8000);
  });

  it('puts the far-end threshold three quarters of the way out', () => {
    const end = turnaroundM('out_and_back', 8000);
    const just = (distM: number) =>
      deriveDisplayName(
        trail({ name: 'Rock Creek Trail', waypoints: [TRAILHEAD, summit({ distM })] }),
      );
    expect(just(FAR_END_FRACTION * end)).toBe('Vesper Peak via Rock Creek Trail');
    expect(just(FAR_END_FRACTION * end - 1)).toBeNull();
  });
});

describe('namesTheDestination', () => {
  it('is true when the trail repeats a distinctive word of the destination', () => {
    expect(namesTheDestination('Snowball Trail', 'Snowball Mountain')).toBe(true);
    expect(namesTheDestination('Indian Head Peak Bootpath', 'Indian Head Peak-West')).toBe(true);
    expect(namesTheDestination("Gobbler's Knob Trail", 'Gobblers Knob')).toBe(true);
  });

  it('is false when they share only the words every summit shares', () => {
    expect(namesTheDestination('Mount Jumbo Trail', 'Mount Bradley')).toBe(false);
    expect(namesTheDestination('Bluff Mountain Trail', 'Silver Star Mountain')).toBe(false);
    expect(namesTheDestination('Mist Trail', 'Nevada Fall')).toBe(false);
  });

  it('does not let a one-letter trail name match every destination', () => {
    expect(namesTheDestination('A', "Camel's Hump")).toBe(false);
  });
});

describe('distinctiveWords', () => {
  it('drops the classification, the articles and the landform', () => {
    expect(distinctiveWords('Mount Si')).toEqual(['si']);
    expect(distinctiveWords('Chemin de la Cascade')).toEqual([]);
    expect(distinctiveWords('Snow Lake')).toEqual(['snow']);
  });

  it('folds diacritics so a name compares the same either way it is typed', () => {
    expect(distinctiveWords('Åreskutan')).toEqual(distinctiveWords('Areskutan'));
  });
});

describe('trailTitle', () => {
  it('shows the derived name when there is one', () => {
    expect(
      trailTitle({ name: 'Headlee Pass Trail', displayName: 'Vesper Peak via Headlee Pass Trail' }),
    ).toBe('Vesper Peak via Headlee Pass Trail');
  });

  it('falls back to the OSM name, which is the ordinary case', () => {
    expect(trailTitle({ name: 'Mount Si Trail', displayName: null })).toBe('Mount Si Trail');
    expect(trailTitle({ name: 'Mount Si Trail' })).toBe('Mount Si Trail');
  });

  it('treats a blank derived name as no name — an offline row or a hand-edited column', () => {
    expect(trailTitle({ name: 'Mount Si Trail', displayName: '   ' })).toBe('Mount Si Trail');
  });
});
