import { describe, expect, it } from 'vitest';
import type { ElevationPoint, LngLat } from '@switchback/core';
import {
  centroidOf,
  deriveActivityTypes,
  deriveDescription,
  deriveTrail,
  orientUphill,
  parseFee,
  parseSacScale,
  parseTriState,
  searchDocument,
  slugify,
} from '../src/derive';
import { terminusFeatures } from '../src/enrich';

/** A straight north-bound line climbing at a constant rate. */
function ramp(
  pointCount: number,
  spacingM: number,
  gradient: number,
): {
  coords: LngLat[];
  profile: ElevationPoint[];
} {
  const coords: LngLat[] = [];
  const profile: ElevationPoint[] = [];
  for (let i = 0; i < pointCount; i++) {
    const lat = 56.8 + (i * spacingM) / 111_320;
    coords.push([-4, lat]);
    profile.push({ distM: i * spacingM, eleM: 200 + i * spacingM * gradient, lng: -4, lat });
  }
  return { coords, profile };
}

/** Any bbox — every assertion here is about elevation ordering, not extent. */
const BOX: [number, number, number, number] = [-4.1, 56.7, -3.9, 56.9];

/**
 * A climb to a pass and a short drop down the far side.
 *
 * The baseline fixture for `deriveTrail` below, and it crosses rather than stops on purpose.
 * A line that ends at its own high point is read as an implied out-and-back — see
 * `climbsToADeadEnd` — which would double every number those tests assert, for reasons that
 * have nothing to do with what they are checking. Descending the far side also makes it a
 * better arithmetic fixture: gain and loss come out as genuinely different numbers, and the
 * high point lands in the middle where `highPointIndex` has to actually find it.
 */
function overAPass(): { coords: LngLat[]; profile: ElevationPoint[] } {
  const up = ramp(201, 25, 0.15); // 5 km at 15%, 750 m of gain
  const coords = [...up.coords];
  const profile = [...up.profile];
  const top = profile[profile.length - 1]!;
  for (let i = 1; i <= 40; i++) {
    const distM = top.distM + i * 25; // 1 km down the far side, losing 150 m
    const lat = 56.8 + distM / 111_320;
    coords.push([-4, lat]);
    profile.push({ distM, eleM: top.eleM - i * 25 * 0.15, lng: -4, lat });
  }
  return { coords, profile };
}

describe('parseSacScale', () => {
  it('accepts the published scale, in any casing or spacing', () => {
    expect(parseSacScale('mountain_hiking')).toBe('mountain_hiking');
    expect(parseSacScale('  Alpine Hiking ')).toBe('alpine_hiking');
  });

  it('rejects anything off the scale rather than guessing', () => {
    // "T3" is the informal shorthand, not the tag value. Mapping it ourselves would be
    // inventing a difficulty rating.
    expect(parseSacScale('T3')).toBeNull();
    expect(parseSacScale('hard')).toBeNull();
    expect(parseSacScale(undefined)).toBeNull();
    expect(parseSacScale('')).toBeNull();
  });
});

describe('parseTriState', () => {
  it('reads the many spellings of yes', () => {
    for (const v of ['yes', 'designated', 'permissive', 'official', 'leashed', 'leashed_only']) {
      expect(parseTriState(v)).toBe(true);
    }
  });

  it('reads the many spellings of no', () => {
    for (const v of ['no', 'private', 'prohibited', 'restricted']) {
      expect(parseTriState(v)).toBe(false);
    }
  });

  it('returns null for untagged and unrecognised, never false', () => {
    // "Nobody tagged this" and "dogs are banned" are different facts. Collapsing them is
    // how a product loses trust on the one thing somebody checked before a two-hour drive.
    expect(parseTriState(undefined)).toBeNull();
    expect(parseTriState('customers')).toBeNull();
  });
});

describe('parseFee', () => {
  it('prefers fee over the legacy charge tag', () => {
    expect(parseFee({ fee: 'no', charge: '5 EUR' })).toBe(false);
  });

  it('treats a charge amount as implying a fee', () => {
    expect(parseFee({ charge: '5 EUR' })).toBe(true);
  });

  it('stays null when neither is tagged', () => {
    expect(parseFee({})).toBeNull();
  });
});

describe('deriveActivityTypes', () => {
  it('always includes hiking', () => {
    expect(deriveActivityTypes({}, null)).toContain('hiking');
  });

  it('swaps running for scrambling on a route that needs hands', () => {
    const technical = deriveActivityTypes({}, 'demanding_mountain_hiking');
    expect(technical).toContain('scrambling');
    expect(technical).not.toContain('trail_running');
    // Hiking stays. It is the floor for anything that reached assembly, and a scramble is
    // still reached on foot — what the sac_scale removes is the claim that you can run it.
    expect(technical).toContain('hiking');
  });

  it('keeps running on an ordinary mountain path', () => {
    expect(deriveActivityTypes({}, 'mountain_hiking')).toContain('trail_running');
  });

  it('adds biking and riding on positive evidence only', () => {
    expect(deriveActivityTypes({ 'mtb:scale': '2' }, null)).toContain('mountain_biking');
    expect(deriveActivityTypes({ bicycle: 'designated' }, null)).toContain('mountain_biking');
    expect(deriveActivityTypes({ bicycle: 'no' }, null)).not.toContain('mountain_biking');
    expect(deriveActivityTypes({ highway: 'bridleway' }, null)).toContain('horseback_riding');
    expect(deriveActivityTypes({}, null)).not.toContain('horseback_riding');
  });

  it('marks long-distance networks as backpacking and local ones as not', () => {
    expect(deriveActivityTypes({ route: 'hiking', network: 'nwn' }, null)).toContain('backpacking');
    expect(deriveActivityTypes({ route: 'hiking', network: 'lwn' }, null)).not.toContain(
      'backpacking',
    );
    // The common case: no network tag at all. This must not be backpacking.
    expect(deriveActivityTypes({ route: 'hiking' }, null)).not.toContain('backpacking');
  });

  it('picks up via ferrata and piste tags', () => {
    expect(deriveActivityTypes({ via_ferrata_scale: 'B' }, null)).toContain('via_ferrata');
    expect(deriveActivityTypes({ piste_type: 'nordic' }, null)).toContain('skiing');
  });
});

describe('deriveDescription', () => {
  it('keeps prose and drops fragments', () => {
    const prose = 'A steep zigzag ascent from the glen to the summit cairn.';
    expect(deriveDescription({ description: prose })).toBe(prose);
    expect(deriveDescription({ description: 'nice path' })).toBeNull();
  });

  it('ignores mapper-facing notes', () => {
    expect(
      deriveDescription({ note: 'check this junction, survey 2019 needs redoing' }),
    ).toBeNull();
  });
});

describe('centroidOf', () => {
  it('sits on the trail, at the halfway point by distance', () => {
    const { coords, profile } = ramp(101, 25, 0.1);
    const [, lat] = centroidOf(profile, coords);
    // Not the bbox centre — for a horseshoe that would land in the valley, off the trail.
    expect(lat).toBeCloseTo(profile[50]!.lat, 6);
  });

  it('falls back to the middle coordinate when there is no profile', () => {
    expect(
      centroidOf(
        [],
        [
          [-4, 56.8],
          [-4, 56.9],
          [-4, 57],
        ],
      ),
    ).toEqual([-4, 56.9]);
  });
});

describe('deriveTrail', () => {
  const { coords, profile } = overAPass(); // 6 km, 750 m up then 150 m down

  it('derives stats a user would read as fact', () => {
    const derived = deriveTrail({ coords, profile, bbox: [-4, 56.8, -4, 56.85], tags: {} });

    expect(derived.stats.lengthM).toBe(6000);
    expect(derived.stats.gainM).toBe(750);
    expect(derived.stats.lossM).toBe(150);
    expect(derived.stats.minEleM).toBe(200);
    expect(derived.stats.maxEleM).toBe(950);
    expect(derived.stats.estimatedTimeS).toBeGreaterThan(0);
    // The pass, not the far end — which is what makes this index worth storing.
    expect(derived.highPointIndex).toBe(200);
  });

  it('rates 750 m of gain over 6 km as hard', () => {
    const derived = deriveTrail({ coords, profile, bbox: [-4, 56.8, -4, 56.85], tags: {} });
    expect(derived.difficulty).toBe('hard');
    expect(derived.difficultyScore).toBeGreaterThan(100);
  });

  it('slows the pace estimate on technical ground', () => {
    const easy = deriveTrail({ coords, profile, bbox: [-4, 56.8, -4, 56.85], tags: {} });
    const technical = deriveTrail({
      coords,
      profile,
      bbox: [-4, 56.8, -4, 56.85],
      tags: { sac_scale: 'alpine_hiking' },
    });
    expect(technical.stats.estimatedTimeS).toBeGreaterThan(easy.stats.estimatedTimeS);
    // Same ground, so distance and climb are unchanged — only the time moves.
    expect(technical.stats.lengthM).toBe(easy.stats.lengthM);
  });

  it('reads permissions as a tri-state', () => {
    const derived = deriveTrail({
      coords,
      profile,
      bbox: [-4, 56.8, -4, 56.85],
      tags: { dog: 'leashed', wheelchair: 'no' },
    });
    expect(derived.dogsAllowed).toBe(true);
    expect(derived.wheelchairAccessible).toBe(false);
    expect(derived.feeRequired).toBeNull();
  });

  it('does not double stats that the geometry already contains', () => {
    // A there-and-back line: out along the ramp, then straight back down it. Both legs are
    // drawn, so the profile already describes the whole hike.
    const there = ramp(101, 25, 0.15); // 2.5 km up
    const outAndBack = [...there.coords, ...[...there.coords].reverse().slice(1)];
    const total = there.profile[there.profile.length - 1]!.distM;
    const fullProfile = [
      ...there.profile,
      ...[...there.profile]
        .reverse()
        .slice(1)
        .map((p) => ({ ...p, distM: 2 * total - p.distM })),
    ];

    const derived = deriveTrail({
      coords: outAndBack,
      profile: fullProfile,
      bbox: [-4, 56.8, -4, 56.83],
      tags: {},
    });

    expect(derived.routeType).toBe('out_and_back');
    // 5 km total, not 10. Doubling here would be the most visible lie the pipeline could tell.
    expect(derived.stats.lengthM).toBe(5000);
    expect(derived.stats.gainM).toBe(375);
    expect(derived.stats.lossM).toBe(375);
  });

  it('accounts for the return leg when roundtrip=yes but only one leg is drawn', () => {
    // The common OSM case: the relation says it is a round trip, the geometry is one way.
    const oneLeg = ramp(101, 25, 0.15); // 2.5 km up, 375 m of gain
    const derived = deriveTrail({
      coords: oneLeg.coords,
      profile: oneLeg.profile,
      bbox: [-4, 56.8, -4, 56.83],
      tags: { roundtrip: 'yes' },
    });

    expect(derived.routeType).toBe('out_and_back');
    expect(derived.stats.lengthM).toBe(5000);
    // You climb 375 m and descend the same 375 m, so both totals are the full climb.
    expect(derived.stats.gainM).toBe(375);
    expect(derived.stats.lossM).toBe(375);
    // The stored profile is still the single leg — the high point indexes into that.
    expect(derived.highPointIndex).toBe(oneLeg.profile.length - 1);
  });

  it('accounts for the return leg when a short path dead-ends at a summit', () => {
    // The Pyg Track case, and the reason 91% of a fresh catalogue used to read "Point to
    // point": the path is drawn once, from a road to a summit, and nobody hikes it one way.
    const oneLeg = ramp(101, 25, 0.15);
    const summit = oneLeg.coords[oneLeg.coords.length - 1]!;
    const derived = deriveTrail({
      coords: oneLeg.coords,
      profile: oneLeg.profile,
      bbox: [-4, 56.8, -4, 56.83],
      tags: {},
      termini: terminusFeatures(oneLeg.coords, [
        { type: 'node', id: 1, lon: summit[0], lat: summit[1], tags: { natural: 'peak' } },
        {
          type: 'node',
          id: 2,
          lon: oneLeg.coords[0]![0],
          lat: oneLeg.coords[0]![1],
          tags: { amenity: 'parking' },
        },
      ]),
    });

    expect(derived.routeType).toBe('out_and_back');
    expect(derived.stats.lengthM).toBe(5000);
  });

  it('leaves the route type alone when a natural=hill sits at one end', () => {
    // `classifyWaypoint` calls a hill a summit so it can *name* a trail, and
    // `TERMINAL_DESTINATIONS` holds `summit`. Wire the two together and this 2.5 km path
    // publishes as a 5 km one, on a feature class the classifier was never tuned against.
    const oneLeg = ramp(101, 25, 0.15);
    const top = oneLeg.coords[oneLeg.coords.length - 1]!;
    const withKind = (natural: string) =>
      deriveTrail({
        coords: oneLeg.coords,
        profile: oneLeg.profile,
        bbox: [-4, 56.8, -4, 56.83],
        tags: {},
        termini: terminusFeatures(oneLeg.coords, [
          { type: 'node', id: 1, lon: top[0], lat: top[1], tags: { natural } },
        ]),
      });

    expect(withKind('hill').routeType).toBe('point_to_point');
    expect(withKind('hill').stats.lengthM).toBe(2500);
    // The same node tagged as a peak is evidence, and does imply the return leg.
    expect(withKind('peak').routeType).toBe('out_and_back');
    expect(withKind('peak').stats.lengthM).toBe(5000);
  });

  it('does not let a hill at the far end veto an out-and-back into half of one', () => {
    // The inverse: two terminal destinations read as a traverse, which vetoes the climb
    // test — so a summit spur that happens to start beside a hillock loses its return leg.
    const oneLeg = ramp(101, 25, 0.2);
    const top = oneLeg.coords[oneLeg.coords.length - 1]!;
    const start = oneLeg.coords[0]!;
    const derived = deriveTrail({
      coords: oneLeg.coords,
      profile: oneLeg.profile,
      bbox: [-4, 56.8, -4, 56.83],
      tags: {},
      termini: terminusFeatures(oneLeg.coords, [
        { type: 'node', id: 1, lon: top[0], lat: top[1], tags: { natural: 'peak' } },
        { type: 'node', id: 2, lon: start[0], lat: start[1], tags: { natural: 'hill' } },
      ]),
    });

    expect(derived.routeType).toBe('out_and_back');
    expect(derived.stats.lengthM).toBe(5000);
  });

  it('accounts for the return leg when a path climbs hard and stops, with nothing tagged', () => {
    // The Snowdon gap. The Pyg Track, the Miners' Track and the Watkin Path all stop where
    // they meet the Llanberis Path on the ridge — several hundred metres from the summit
    // node, so no terminus test can see it. What is left is the shape: 500 m of climb whose
    // highest sample is its last. Ground that continued would have been drawn continuing.
    const oneLeg = ramp(101, 25, 0.2); // 2.5 km up, 500 m of gain
    const derived = deriveTrail({
      coords: oneLeg.coords,
      profile: oneLeg.profile,
      bbox: BOX,
      tags: {},
    });

    expect(derived.routeType).toBe('out_and_back');
    expect(derived.stats.lengthM).toBe(5000);
    expect(derived.stats.gainM).toBe(500);
    expect(derived.stats.lossM).toBe(500);
  });

  it('leaves a hillside path that climbs a little and carries on alone', () => {
    // 250 m of climb over the same ground. Below the bar are paths that top out on a shelf
    // and genuinely continue as somebody's route between two places, and doubling one of
    // those would be the visible kind of wrong.
    const derived = deriveTrail({
      ...ramp(101, 25, 0.1),
      bbox: BOX,
      tags: {},
    });

    expect(derived.routeType).toBe('point_to_point');
    expect(derived.stats.lengthM).toBe(2500);
  });

  it('leaves an Alpine farm lane alone however steeply it climbs', () => {
    // Chemin du Maquis climbs at 29%, steeper than every path on Snowdon, and still ends at
    // a hamlet with the track carrying on. Steepness cannot tell the two apart; the French
    // generic can, because a mountain path there is a *sentier*.
    const oneLeg = ramp(101, 25, 0.2);
    const derived = deriveTrail({
      coords: oneLeg.coords,
      profile: oneLeg.profile,
      bbox: BOX,
      tags: { name: 'Chemin du Maquis' },
    });

    expect(derived.routeType).toBe('point_to_point');
    expect(derived.stats.lengthM).toBe(2500);
  });

  it('leaves a traverse between two summits alone', () => {
    // Crib Goch to Snowdon: it climbs 500 m and finishes on its high point, so the shape
    // alone would read as a summit approach. A summit at *both* ends is positive evidence
    // that the hike really does end somewhere else, and it beats the shape.
    const oneLeg = ramp(101, 25, 0.2);
    const derived = deriveTrail({
      coords: oneLeg.coords,
      profile: oneLeg.profile,
      bbox: [-4, 56.8, -4, 56.83],
      tags: {},
      termini: terminusFeatures(oneLeg.coords, [
        {
          type: 'node',
          id: 1,
          lon: oneLeg.coords[0]![0],
          lat: oneLeg.coords[0]![1],
          tags: { natural: 'peak' },
        },
        {
          type: 'node',
          id: 2,
          lon: oneLeg.coords[oneLeg.coords.length - 1]![0],
          lat: oneLeg.coords[oneLeg.coords.length - 1]![1],
          tags: { natural: 'peak' },
        },
      ]),
    });

    expect(derived.routeType).toBe('point_to_point');
    expect(derived.stats.lengthM).toBe(2500);
  });

  it('refuses to double a trail the mapper named a loop', () => {
    // Yosemite's Valley Loop Trail: half a circuit, stored as a line that does not close,
    // with a viewpoint at one end. Every geometric test says spur; the name says otherwise,
    // and the missing half is a circle rather than a retrace.
    const oneLeg = ramp(101, 25, 0.15);
    const derived = deriveTrail({
      coords: oneLeg.coords,
      profile: oneLeg.profile,
      bbox: BOX,
      tags: { name: 'Valley Loop Trail', roundtrip: 'yes' },
      termini: { start: [], end: ['summit'] },
    });

    expect(derived.routeType).toBe('point_to_point');
    expect(derived.stats.lengthM).toBe(2500);
  });

  it('ignores roundtrip=yes when the geometry already retraces', () => {
    const there = ramp(101, 25, 0.15);
    const outAndBack = [...there.coords, ...[...there.coords].reverse().slice(1)];
    const total = there.profile[there.profile.length - 1]!.distM;
    const fullProfile = [
      ...there.profile,
      ...[...there.profile]
        .reverse()
        .slice(1)
        .map((p) => ({ ...p, distM: 2 * total - p.distM })),
    ];

    const derived = deriveTrail({
      coords: outAndBack,
      profile: fullProfile,
      bbox: [-4, 56.8, -4, 56.83],
      tags: { roundtrip: 'yes' },
    });
    expect(derived.stats.lengthM).toBe(5000);
  });
});

describe('slugify', () => {
  it('strips diacritics rather than dropping the letter', () => {
    expect(slugify('Åreskutan')).toBe('areskutan');
    expect(slugify('Sentier des Crêtes')).toBe('sentier-des-cretes');
  });

  it('qualifies with the region when given one', () => {
    expect(slugify('Summit Trail', 'Colorado')).toBe('summit-trail-colorado');
  });

  it('collapses punctuation and never leaves a trailing dash', () => {
    expect(slugify('Ben Nevis — Mountain Track!!')).toBe('ben-nevis-mountain-track');
  });

  it('caps length without leaving a dangling separator', () => {
    const slug = slugify('a'.repeat(60) + ' ' + 'b'.repeat(60));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('always yields something routable', () => {
    expect(slugify('小径')).toBe('trail');
    expect(slugify('')).toBe('trail');
  });
});

describe('searchDocument', () => {
  it('weights name above region above description', () => {
    const doc = searchDocument({
      name: 'Ben Nevis',
      regionName: 'Highland',
      description: 'Near Ben Nevis',
    });
    expect(doc).toEqual({ a: 'Ben Nevis', b: 'Highland', c: 'Near Ben Nevis' });
  });

  it('tolerates missing fields and bounds the description', () => {
    const doc = searchDocument({ name: 'X', regionName: null, description: 'y'.repeat(5000) });
    expect(doc.b).toBe('');
    expect(doc.c).toHaveLength(2000);
  });
});

describe('orientUphill', () => {
  /** The Watkin Path case: OSM drew it summit-first, so the stored line descends. */
  function descending() {
    const { coords, profile } = ramp(9, 100, 0.1); // 0 → 800 m over 800 m
    return { coords: [...coords].reverse(), profile: reverseForTest(profile) };
  }

  /** Reverse a profile the way OSM would have stored it, distances re-measured from the new start. */
  function reverseForTest(profile: ElevationPoint[]): ElevationPoint[] {
    const total = profile[profile.length - 1]!.distM;
    return profile.map((p) => ({ ...p, distM: total - p.distM })).reverse();
  }

  it('flips a line that runs downhill', () => {
    const { coords, profile } = descending();
    expect(profile[0]!.eleM).toBeGreaterThan(profile[profile.length - 1]!.eleM);

    const oriented = orientUphill(coords, profile);

    expect(oriented.reversed).toBe(true);
    expect(oriented.profile[0]!.eleM).toBeLessThan(
      oriented.profile[oriented.profile.length - 1]!.eleM,
    );
    expect(oriented.coords[0]).toEqual(coords[coords.length - 1]);
  });

  it('re-measures distance from the new start, so the profile still runs 0 → length', () => {
    const { coords, profile } = descending();
    const oriented = orientUphill(coords, profile);

    expect(oriented.profile[0]!.distM).toBe(0);
    expect(oriented.profile[oriented.profile.length - 1]!.distM).toBe(800);
    // Strictly increasing — a chart plotted against these must not fold back on itself.
    const distances = oriented.profile.map((p) => p.distM);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(new Set(distances).size).toBe(distances.length);
  });

  it('keeps each sample married to its own coordinate', () => {
    const { coords, profile } = descending();
    const oriented = orientUphill(coords, profile);

    // The elevation that was at the far end is now at the near end, still at its own lat.
    const last = profile[profile.length - 1]!;
    expect(oriented.profile[0]!.eleM).toBe(last.eleM);
    expect(oriented.profile[0]!.lat).toBe(last.lat);
  });

  it('leaves an uphill line alone', () => {
    const { coords, profile } = ramp(9, 100, 0.1);
    const oriented = orientUphill(coords, profile);

    expect(oriented.reversed).toBe(false);
    expect(oriented.coords).toBe(coords);
    expect(oriented.profile).toBe(profile);
  });

  it('leaves a loop alone — its endpoints are level and its start is the mapper’s choice', () => {
    const { coords, profile } = ramp(9, 100, 0.1);
    // Up and back down to where it started.
    const loopProfile = [
      ...profile,
      ...reverseForTest(profile).map((p, i) => ({
        ...p,
        distM: 800 + i * 100,
      })),
    ];
    const loopCoords = [...coords, ...[...coords].reverse()];

    expect(orientUphill(loopCoords, loopProfile).reversed).toBe(false);
  });

  it('ignores DEM noise on a flat traverse', () => {
    // 12 m of net drop over 800 m is under the threshold: real, but not a descent, and
    // flipping on it would make the direction depend on which DEM tile the line landed on.
    const { coords, profile } = ramp(9, 100, 0);
    const noisy = profile.map((p, i) => ({ ...p, eleM: p.eleM - i * 1.5 }));

    expect(orientUphill(coords, noisy).reversed).toBe(false);
  });

  it('is what makes gain describe the hike rather than the drawing direction', () => {
    // The regression this exists for. Same physical trail, drawn both ways; the published
    // gain must not depend on which way the mapper happened to draw it.
    const uphill = ramp(9, 100, 0.1);
    const { coords, profile } = descending();

    const up = deriveTrail({ coords: uphill.coords, profile: uphill.profile, bbox: BOX, tags: {} });
    const down = deriveTrail({ coords, profile, bbox: BOX, tags: {} });

    expect(down.stats.gainM).toBeCloseTo(up.stats.gainM, 1);
    // A 10% grade over 800 m, read as a climb from either drawing direction.
    expect(down.stats.gainM).toBeCloseTo(80, 0);
    expect(down.stats.lossM).toBeLessThan(1);
    expect(down.reversed).toBe(true);
  });

  it('hands the caller the geometry the stats were computed from', () => {
    const { coords, profile } = descending();
    const derived = deriveTrail({ coords, profile, bbox: BOX, tags: {} });

    // The contract `commitTrail` depends on: persist `derived.coords`/`derived.profile`,
    // never the inputs, or the stored line disagrees with the stored numbers.
    expect(derived.coords[0]).toEqual(coords[coords.length - 1]);
    expect(derived.profile[0]!.distM).toBe(0);
    expect(derived.profile[0]!.eleM).toBeLessThan(
      derived.profile[derived.profile.length - 1]!.eleM,
    );
  });
});
