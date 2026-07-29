import { describe, expect, it } from 'vitest';
import type { LngLat } from '@switchback/core';
import {
  assembleTrails,
  bridgeGaps,
  chainWays,
  dedupeVertices,
  pickPrimary,
  wayToCoords,
} from '../src/assemble';
import type { AssembledLine, RawWay } from '../src/assemble';
import type { OverpassElement } from '../src/overpass';

/** ~111.3 km per degree of latitude; enough precision for tolerance assertions. */
const M_PER_DEG_LAT = 111_320;
const m = (metres: number): number => metres / M_PER_DEG_LAT;

function way(id: number, coords: LngLat[], tags: Record<string, string> = {}): RawWay {
  return { id, coords, tags };
}

function line(coords: LngLat[], wayIds: number[] = []): AssembledLine {
  return { coords, wayIds, bridgedM: 0 };
}

describe('wayToCoords', () => {
  it('flips lat/lon into GeoJSON order', () => {
    expect(
      wayToCoords({
        type: 'way',
        id: 1,
        geometry: [
          { lat: 56.8, lon: -4.0 },
          { lat: 56.81, lon: -4.01 },
        ],
      }),
    ).toEqual([
      [-4.0, 56.8],
      [-4.01, 56.81],
    ]);
  });

  it('drops a way clipped by the query bbox rather than inventing the missing span', () => {
    // Overpass omits positions for nodes outside the bbox. The neighbouring tile has them.
    const clipped = {
      type: 'way' as const,
      id: 1,
      geometry: [{ lat: 56.8, lon: -4.0 }, { lon: -4.01 } as { lat: number; lon: number }],
    };
    expect(wayToCoords(clipped)).toBeNull();
    expect(wayToCoords({ type: 'way', id: 1, geometry: [{ lat: 1, lon: 1 }] })).toBeNull();
    expect(wayToCoords({ type: 'way', id: 1 })).toBeNull();
  });
});

describe('chainWays', () => {
  it('orders members and reverses the ones drawn backwards', () => {
    // Three collinear ways handed over shuffled, the middle one drawn south-to-north and
    // the last drawn north-to-south — the ordinary state of a route relation.
    const lines = chainWays([
      way(2, [
        [-4, 56.805],
        [-4, 56.81],
      ]),
      way(3, [
        [-4, 56.815],
        [-4, 56.81],
      ]),
      way(1, [
        [-4, 56.8],
        [-4, 56.805],
      ]),
    ]);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.coords).toEqual([
      [-4, 56.8],
      [-4, 56.805],
      [-4, 56.81],
      [-4, 56.815],
    ]);
    expect(lines[0]!.wayIds).toEqual([1, 2, 3]);
    expect(lines[0]!.bridgedM).toBe(0);
  });

  it('leaves genuinely disconnected ways as separate lines', () => {
    const lines = chainWays([
      way(1, [
        [-4, 56.8],
        [-4, 56.805],
      ]),
      way(2, [
        [-3, 56.9],
        [-3, 56.905],
      ]),
    ]);
    expect(lines).toHaveLength(2);
  });

  it('ignores degenerate single-vertex ways', () => {
    expect(chainWays([way(1, [[-4, 56.8]])])).toHaveLength(0);
  });
});

describe('bridgeGaps', () => {
  it('joins a small gap and records how much was guessed', () => {
    const joined = bridgeGaps(
      [
        line([
          [-4, 56.8],
          [-4, 56.805],
        ]),
        line([
          [-4, 56.805 + m(20)],
          [-4, 56.81],
        ]),
      ],
      40,
    );

    expect(joined).toHaveLength(1);
    // Surfaced, not hidden: a trail whose length is partly straight-line guesswork should
    // be able to say so.
    expect(joined[0]!.bridgedM).toBeGreaterThan(15);
    expect(joined[0]!.bridgedM).toBeLessThan(25);
  });

  it('refuses to connect two trails that merely end near each other', () => {
    const apart = bridgeGaps(
      [
        line([
          [-4, 56.8],
          [-4, 56.805],
        ]),
        line([
          [-4, 56.805 + m(500)],
          [-4, 56.81],
        ]),
      ],
      40,
    );
    expect(apart).toHaveLength(2);
  });

  it('reverses whichever line needs it to make the join', () => {
    // Both lines drawn away from the shared point, so the first must be flipped.
    const joined = bridgeGaps(
      [
        line([
          [-4, 56.805],
          [-4, 56.8],
        ]),
        line([
          [-4, 56.805 + m(5)],
          [-4, 56.81],
        ]),
      ],
      40,
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]!.coords[0]).toEqual([-4, 56.8]);
    expect(joined[0]!.coords[joined[0]!.coords.length - 1]).toEqual([-4, 56.81]);
  });
});

describe('pickPrimary', () => {
  it('keeps the main route rather than the spur', () => {
    const primary = pickPrimary([
      line([
        [-4, 56.8],
        [-4, 56.801],
      ]),
      line([
        [-4, 56.8],
        [-4, 56.85],
      ]),
    ]);
    expect(primary!.coords[1]).toEqual([-4, 56.85]);
  });

  it('returns null for nothing', () => {
    expect(pickPrimary([])).toBeNull();
  });
});

describe('dedupeVertices', () => {
  it('removes consecutive duplicates that would divide by zero in the grade calc', () => {
    expect(
      dedupeVertices([
        [-4, 56.8],
        [-4, 56.8],
        [-4, 56.81],
        [-4, 56.81],
      ]),
    ).toEqual([
      [-4, 56.8],
      [-4, 56.81],
    ]);
  });

  it('keeps a revisited vertex that is not consecutive, because a loop is legitimate', () => {
    expect(
      dedupeVertices([
        [-4, 56.8],
        [-4, 56.81],
        [-4, 56.8],
      ]),
    ).toHaveLength(3);
  });
});

describe('assembleTrails', () => {
  const relationMembers = [
    {
      type: 'way' as const,
      ref: 1,
      role: '',
      geometry: [
        { lat: 56.8, lon: -4 },
        { lat: 56.805, lon: -4 },
      ],
    },
    {
      type: 'way' as const,
      ref: 2,
      role: '',
      geometry: [
        { lat: 56.805, lon: -4 },
        { lat: 56.81, lon: -4 },
      ],
    },
    {
      type: 'way' as const,
      ref: 3,
      role: '',
      geometry: [
        { lat: 56.815, lon: -4 },
        { lat: 56.81, lon: -4 },
      ],
    },
  ];

  const elements: OverpassElement[] = [
    {
      type: 'relation',
      id: 100,
      members: relationMembers,
      tags: { route: 'hiking', name: 'Glen Ridge Path', sac_scale: 'mountain_hiking' },
    },
    {
      type: 'way',
      id: 1,
      tags: { highway: 'path', name: 'Lower Section', surface: 'wood', sac_scale: 'alpine_hiking' },
    },
    { type: 'way', id: 2, tags: { highway: 'path', surface: 'rock' } },
    { type: 'way', id: 3, tags: { highway: 'path', surface: 'rock' } },
  ];

  it('produces one trail per relation, in order and with a bbox', () => {
    const trails = assembleTrails(elements);
    expect(trails).toHaveLength(1);

    const trail = trails[0]!;
    expect(trail.osmType).toBe('relation');
    expect(trail.osmId).toBe(100);
    expect(trail.name).toBe('Glen Ridge Path');
    expect(trail.coords[0]).toEqual([-4, 56.8]);
    expect(trail.coords[trail.coords.length - 1]).toEqual([-4, 56.815]);
    expect(trail.lengthM).toBeGreaterThan(1600);
    expect(trail.bbox).toEqual([-4, 56.8, -4, 56.815]);
  });

  it('does not also emit relation member ways as their own trails', () => {
    // Otherwise the map draws the same path twice, once named for the route and once for
    // the segment.
    const names = assembleTrails(elements).map((t) => t.name);
    expect(names).not.toContain('Lower Section');
  });

  it('takes the majority tag from members but lets the relation win outright', () => {
    const trail = assembleTrails(elements)[0]!;
    // Two ways say rock, one says wood: one boardwalk does not relabel the mountain.
    expect(trail.tags.surface).toBe('rock');
    // The relation asserted mountain_hiking; one member way claiming alpine does not win.
    expect(trail.tags.sac_scale).toBe('mountain_hiking');
  });

  it('skips an unnamed relation — there is nothing to put on a card', () => {
    const unnamed: OverpassElement[] = [
      { type: 'relation', id: 101, members: relationMembers, tags: { route: 'hiking' } },
    ];
    expect(assembleTrails(unnamed)).toHaveLength(0);
  });

  it('groups standalone named ways by name into one trail', () => {
    const standalone: OverpassElement[] = [
      {
        type: 'way',
        id: 11,
        tags: { highway: 'path', name: 'Corrie Loop' },
        geometry: [
          { lat: 56.905, lon: -4.1 },
          { lat: 56.91, lon: -4.1 },
        ],
      },
      {
        type: 'way',
        id: 10,
        tags: { highway: 'path', name: 'Corrie Loop' },
        geometry: [
          { lat: 56.9, lon: -4.1 },
          { lat: 56.905, lon: -4.1 },
        ],
      },
    ];

    const trails = assembleTrails(standalone);
    expect(trails).toHaveLength(1);
    // The lowest way id is stable across ingests, which is what makes re-ingest an update.
    expect(trails[0]!.osmId).toBe(10);
    expect(trails[0]!.memberWayIds.sort()).toEqual([10, 11]);
  });

  it('drops fragments below the minimum length', () => {
    const stub: OverpassElement[] = [
      {
        type: 'way',
        id: 20,
        tags: { highway: 'footway', name: 'Car Park Link' },
        geometry: [
          { lat: 56.9, lon: -4.1 },
          { lat: 56.9 + m(50), lon: -4.1 },
        ],
      },
    ];
    expect(assembleTrails(stub)).toHaveLength(0);
  });
});
