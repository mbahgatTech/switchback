import { describe, expect, it } from 'vitest';
import { TileStatus } from '@switchback/db';
import type { PathSegment } from '@switchback/core';
import { TERRARIUM_ZOOM, requiredTiles, tileKey } from '@switchback/geo';
import type { TerrariumTile } from '@switchback/geo';
import {
  MAX_TILE_BYTES,
  ROUTING_TILE_TTL_MS,
  ROUTING_ZOOM,
  buildNetworkQuery,
  classifyWay,
  countNodes,
  elevateSegments,
  isRoutingTileFresh,
  padBBox,
  processNetworkTile,
  segmentsBytes,
  trimForBudget,
  waysToSegments,
} from '../src/network';
import type { TerrainSource } from '../src/elevate';
import { networkJobKey, tileJobKey } from '../src/jobs';
import type { OverpassClient, OverpassElement } from '../src/overpass';

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** A way as Overpass returns it under `out body geom`. */
function way(
  id: number,
  tags: Record<string, string>,
  geometry: ReadonlyArray<{ lat: number; lon: number } | null>,
): OverpassElement {
  return {
    type: 'way',
    id,
    tags,
    geometry: geometry.map((point) => point ?? ({} as { lat: number; lon: number })),
  };
}

// ---------------------------------------------------------------------------
// buildNetworkQuery
// ---------------------------------------------------------------------------

describe('buildNetworkQuery', () => {
  const query = buildNetworkQuery([-115.7, 50.8, -115.6, 50.9]);

  it('transposes the bbox into Overpass order', () => {
    // GeoJSON is (w,s,e,n); Overpass is (s,w,n,e). Getting this backwards fetches a box
    // somewhere else entirely — and usually a valid one, so it fails silently.
    expect(query).toContain('(50.8,-115.7,50.9,-115.6)');
  });

  it('asks for geometry, not merely tags', () => {
    expect(query).toContain('out body geom');
    expect(query).not.toContain('out tags');
  });

  it('carries no name filter — the connectors that make loops possible are unnamed', () => {
    expect(query).not.toContain('["name"]');
  });

  it('stops at tertiary, so nobody is routed along a trunk road', () => {
    for (const banned of ['primary', 'secondary', 'trunk', 'motorway']) {
      expect(query).not.toContain(banned);
    }
  });

  it('includes both ends of the range: footpaths and the roads that reach them', () => {
    expect(query).toContain('path');
    expect(query).toContain('service');
  });

  it('excludes ways closed to the public, server-side', () => {
    expect(query).toContain('["access"!~"^(private|no)$"]');
    expect(query).toContain('["foot"!~"^(private|no|use_sidepath)$"]');
  });

  it('guards the request with a timeout and a size cap', () => {
    const guarded = buildNetworkQuery([0, 0, 1, 1], { timeoutS: 30, maxSizeBytes: 1024 });

    expect(guarded).toContain('[timeout:30]');
    expect(guarded).toContain('[maxsize:1024]');
  });
});

// ---------------------------------------------------------------------------
// classifyWay
// ---------------------------------------------------------------------------

describe('classifyWay', () => {
  it('maps a highway value onto a path kind', () => {
    expect(classifyWay({ highway: 'footway' })?.kind).toBe('footway');
    expect(classifyWay({ highway: 'steps' })?.kind).toBe('steps');
  });

  it('folds every drivable class into one "road" kind', () => {
    // The planner's cost model does not care whether tarmac is residential or tertiary; it
    // cares that it is tarmac. One kind means one penalty to reason about.
    for (const highway of ['residential', 'unclassified', 'tertiary', 'service', 'living_street']) {
      expect(classifyWay({ highway })?.kind).toBe('road');
    }
  });

  it('rejects a way with no highway tag at all', () => {
    expect(classifyWay({ name: 'River Kent' })).toBeNull();
    expect(classifyWay(undefined)).toBeNull();
  });

  it('rejects a way the public may not use', () => {
    expect(classifyWay({ highway: 'track', access: 'private' })).toBeNull();
    expect(classifyWay({ highway: 'path', foot: 'no' })).toBeNull();
    expect(classifyWay({ highway: 'path', access: 'permit' })).toBeNull();
  });

  it('rejects a footway a hiker is legally required to leave', () => {
    // `foot=use_sidepath` means "not this one, the parallel one". Routing over it produces a
    // legal-looking line down the carriageway.
    expect(classifyWay({ highway: 'residential', foot: 'use_sidepath' })).toBeNull();
  });

  it('keeps an untagged way, because OSM’s default is that you may hike it', () => {
    expect(classifyWay({ highway: 'path' })?.kind).toBe('path');
  });

  it('separates a forest track from a driveway on the service value', () => {
    expect(classifyWay({ highway: 'service', service: 'driveway' })).toBeNull();
    expect(classifyWay({ highway: 'service', service: 'parking_aisle' })).toBeNull();
    expect(classifyWay({ highway: 'service' })?.kind).toBe('road');
  });

  it('rejects a way that does not exist yet', () => {
    expect(classifyWay({ highway: 'construction' })).toBeNull();
    expect(classifyWay({ highway: 'proposed' })).toBeNull();
  });

  it('carries the tags the cost model reads', () => {
    const classified = classifyWay({
      highway: 'path',
      name: 'Nub Ridge',
      surface: 'gravel',
      sac_scale: 'alpine_hiking',
    });

    expect(classified).toEqual({
      kind: 'path',
      name: 'Nub Ridge',
      surface: 'gravel',
      sacScale: 'alpine_hiking',
    });
  });

  it('drops a sac_scale outside the published six rather than passing it through', () => {
    // `terrainFactorFor` looks the value up in a table; an unrecognised string would fall
    // through to a factor of 1 and quietly rate an unmapped scramble as a park path.
    expect(classifyWay({ highway: 'path', sac_scale: 'extreme' })?.sacScale).toBeNull();
  });

  it('reports no name rather than an empty one', () => {
    expect(classifyWay({ highway: 'path' })?.name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// waysToSegments
// ---------------------------------------------------------------------------

describe('waysToSegments', () => {
  it('flattens a way into coordinate pairs with elevations left for later', () => {
    const [segment] = waysToSegments([
      way(7, { highway: 'path' }, [
        { lon: 0, lat: 0 },
        { lon: 0.001, lat: 0 },
        { lon: 0.002, lat: 0 },
      ]),
    ]);

    expect(segment?.wayId).toBe(7);
    expect(segment?.coords).toEqual([0, 0, 0.001, 0, 0.002, 0]);
    expect(segment?.eleM).toEqual([0, 0, 0]);
  });

  it('splits a way at a hole instead of dropping it', () => {
    // The catalogue drops a clipped way whole, because a neighbour will supply a correct
    // one. A graph cannot: dropping removes a connection, and the dead end it leaves is
    // indistinguishable from real topology.
    const segments = waysToSegments([
      way(7, { highway: 'path' }, [
        { lon: 0, lat: 0 },
        { lon: 0.001, lat: 0 },
        null,
        { lon: 0.003, lat: 0 },
        { lon: 0.004, lat: 0 },
      ]),
    ]);

    expect(segments).toHaveLength(2);
    expect(segments[0]?.coords).toEqual([0, 0, 0.001, 0]);
    expect(segments[1]?.coords).toEqual([0.003, 0, 0.004, 0]);
  });

  it('discards a run left with a single vertex, which is not an edge', () => {
    const segments = waysToSegments([
      way(7, { highway: 'path' }, [
        { lon: 0, lat: 0 },
        null,
        { lon: 0.003, lat: 0 },
        { lon: 0.004, lat: 0 },
      ]),
    ]);

    expect(segments).toHaveLength(1);
    expect(segments[0]?.coords).toEqual([0.003, 0, 0.004, 0]);
  });

  it('ignores nodes, relations, and ways that came back without geometry', () => {
    const segments = waysToSegments([
      { type: 'node', id: 1, lat: 0, lon: 0 },
      { type: 'way', id: 2, tags: { highway: 'path' } },
      { type: 'relation', id: 3, members: [] },
    ]);

    expect(segments).toHaveLength(0);
  });

  it('applies the access rules a second time, for segments arriving from an older cache', () => {
    const segments = waysToSegments([
      way(7, { highway: 'path', access: 'private' }, [
        { lon: 0, lat: 0 },
        { lon: 0.001, lat: 0 },
      ]),
    ]);

    expect(segments).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// elevateSegments
// ---------------------------------------------------------------------------

/** A terrarium tile that reads the same elevation everywhere. */
function flatTile(t: { z: number; x: number; y: number }, elevationM: number): TerrariumTile {
  const value = elevationM + 32768;
  const r = Math.floor(value / 256);
  const g = Math.floor(value) % 256;
  const data = new Uint8Array(4 * 4 * 3);
  for (let i = 0; i < data.length; i += 3) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = 0;
  }
  return { ...t, width: 4, height: 4, channels: 3, data };
}

/** A terrain source at a constant elevation; `holes` names tiles it refuses to answer for. */
function flatTerrain(elevationM: number, holes: ReadonlySet<string> = new Set()): TerrainSource {
  return {
    tilesFor: (coords: ReadonlyArray<readonly [number, number]>, z = TERRARIUM_ZOOM) => {
      const tiles = new Map<string, TerrariumTile>();
      for (const t of requiredTiles(coords, z)) {
        const key = tileKey(t.z, t.x, t.y);
        if (!holes.has(key)) tiles.set(key, flatTile(t, elevationM));
      }
      return Promise.resolve(tiles);
    },
  } as unknown as TerrainSource;
}

function segment(wayId: number, coords: number[]): PathSegment {
  return {
    wayId,
    kind: 'path',
    name: null,
    surface: null,
    sacScale: null,
    coords,
    eleM: Array.from({ length: coords.length >> 1 }, () => 0),
  };
}

describe('elevateSegments', () => {
  it('samples every vertex where it lies, without resampling the line', async () => {
    // The property the whole graph rests on. `elevateLine` would resample to 25 m, and the
    // resampled points are not OSM nodes — two ways sharing a junction would stop sharing a
    // coordinate and the network would shatter into disconnected fragments.
    const input = [segment(1, [0.1, 0.1, 0.1004, 0.1, 0.1008, 0.1])];
    const { segments } = await elevateSegments(input, flatTerrain(100));

    expect(segments[0]?.coords).toEqual(input[0]?.coords);
    expect(segments[0]?.eleM).toHaveLength(3);
    for (const ele of segments[0]?.eleM ?? []) expect(ele).toBeCloseTo(100, 0);
  });

  it('hands each segment back its own slice of the batched sample', async () => {
    const { segments } = await elevateSegments(
      [segment(1, [0.1, 0.1, 0.1004, 0.1]), segment(2, [0.2, 0.2, 0.2004, 0.2, 0.2008, 0.2])],
      flatTerrain(250),
    );

    expect(segments[0]?.eleM).toHaveLength(2);
    expect(segments[1]?.eleM).toHaveLength(3);
    expect(segments[1]?.eleM[2]).toBeCloseTo(250, 0);
  });

  it('reports how many vertices the terrain could not answer for', async () => {
    const coords: [number, number][] = [[0.1, 0.1]];
    const missing = requiredTiles(coords).map((t) => tileKey(t.z, t.x, t.y));
    const { gapCount } = await elevateSegments(
      [segment(1, [0.1, 0.1, 0.1004, 0.1])],
      flatTerrain(100, new Set(missing)),
    );

    expect(gapCount).toBeGreaterThan(0);
  });

  it('returns nothing for nothing, without asking the terrain source', async () => {
    let asked = false;
    const terrain = {
      tilesFor: () => {
        asked = true;
        return Promise.resolve(new Map<string, TerrariumTile>());
      },
    } as unknown as TerrainSource;

    expect(await elevateSegments([], terrain)).toEqual({ segments: [], gapCount: 0 });
    expect(asked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// padBBox
// ---------------------------------------------------------------------------

describe('padBBox', () => {
  it('grows the box on all four sides', () => {
    const [w, s, e, n] = padBBox([0, 0, 1, 1]);

    expect(w).toBeLessThan(0);
    expect(s).toBeLessThan(0);
    expect(e).toBeGreaterThan(1);
    expect(n).toBeGreaterThan(1);
  });

  it('widens the longitude pad with latitude, so the pad stays 250 m on the ground', () => {
    // At 60°N a degree of longitude is half a degree of latitude. An unscaled pad would be
    // 250 m at the equator and 125 m here, and the tile seams would start leaking.
    const equator = padBBox([0, 0, 1, 1]);
    const north = padBBox([0, 59.5, 1, 60.5]);

    expect(north[0]).toBeLessThan(equator[0]);
    expect(north[3] - 60.5).toBeCloseTo(equator[3] - 1, 9);
  });

  it('stops the longitude scaling from diverging at the pole', () => {
    const [w] = padBBox([0, 84, 1, 85]);

    expect(Number.isFinite(w)).toBe(true);
    expect(w).toBeGreaterThan(-1);
  });

  it('never produces coordinates off the map', () => {
    const [w, s, e, n] = padBBox([-180, -85, 180, 85]);

    expect(w).toBe(-180);
    expect(e).toBe(180);
    expect(s).toBe(-85);
    expect(n).toBe(85);
  });

  it('honours a caller-supplied pad', () => {
    expect(padBBox([0, 0, 1, 1], 0.5)[3]).toBeCloseTo(1.5, 9);
  });
});

// ---------------------------------------------------------------------------
// budget
// ---------------------------------------------------------------------------

describe('trimForBudget', () => {
  const path = segment(1, [0, 0, 0.001, 0]);
  const road: PathSegment = { ...segment(2, [0, 0, 0.001, 0]), kind: 'road' };

  it('leaves a tile under budget exactly as it found it', () => {
    const { segments, dropped } = trimForBudget([path, road]);

    expect(segments).toHaveLength(2);
    expect(dropped).toBe(0);
  });

  it('drops the road network first when a tile will not fit', () => {
    const { segments, dropped } = trimForBudget([path, road], 1);

    expect(segments).toEqual([path]);
    expect(dropped).toBe(1);
  });

  it('never drops a footpath, even when dropping the roads was not enough', () => {
    // Past this point the size *is* the pedestrian network, which is the data we came for.
    const { segments } = trimForBudget([path], 1);

    expect(segments).toEqual([path]);
  });

  it('sets the cap high enough for an ordinary tile', () => {
    expect(MAX_TILE_BYTES).toBeGreaterThan(1_000_000);
  });
});

describe('segmentsBytes', () => {
  it('grows with the geometry it is measuring', () => {
    expect(segmentsBytes([segment(1, [0, 0, 1, 1, 2, 2])])).toBeGreaterThan(
      segmentsBytes([segment(1, [0, 0])]),
    );
  });

  it('is zero for nothing', () => {
    expect(segmentsBytes([])).toBe(0);
  });
});

describe('countNodes', () => {
  it('counts a junction shared by two ways once', () => {
    // Four vertices, three nodes — which is the number the graph will actually build, and
    // therefore the number worth recording on the tile.
    expect(countNodes([segment(1, [0, 0, 0.001, 0]), segment(2, [0.001, 0, 0.001, 0.001])])).toBe(
      3,
    );
  });

  it('rounds to the interning precision buildGraph uses', () => {
    expect(countNodes([segment(1, [0, 0, 0.0000000001, 0])])).toBe(1);
  });

  it('is zero for nothing', () => {
    expect(countNodes([])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// freshness and keys
// ---------------------------------------------------------------------------

describe('isRoutingTileFresh', () => {
  it('plans on cached network inside the TTL', () => {
    expect(isRoutingTileFresh({ status: TileStatus.ready, fetchedAt: ago(1000) }, NOW)).toBe(true);
  });

  it('counts an empty tile as fresh, so open water is not re-queried', () => {
    expect(isRoutingTileFresh({ status: TileStatus.empty, fetchedAt: ago(1000) }, NOW)).toBe(true);
  });

  it('expires past the TTL', () => {
    expect(
      isRoutingTileFresh(
        { status: TileStatus.ready, fetchedAt: ago(ROUTING_TILE_TTL_MS + 1) },
        NOW,
      ),
    ).toBe(false);
  });

  it('never plans on a tile that failed, is running, or was never fetched', () => {
    expect(isRoutingTileFresh({ status: TileStatus.failed, fetchedAt: ago(1) }, NOW)).toBe(false);
    expect(isRoutingTileFresh({ status: TileStatus.running, fetchedAt: ago(1) }, NOW)).toBe(false);
    expect(isRoutingTileFresh({ status: TileStatus.ready, fetchedAt: null }, NOW)).toBe(false);
    expect(isRoutingTileFresh(null, NOW)).toBe(false);
  });
});

describe('networkJobKey', () => {
  it('cannot collide with a trail ingest for the same quadkey', () => {
    // Both caches are keyed by quadkey at different zooms. One shared key namespace would
    // mean a z9 trail fetch and a z12 network fetch silently deduping onto each other.
    expect(networkJobKey('023010')).not.toBe(tileJobKey('023010'));
  });
});

// ---------------------------------------------------------------------------
// processNetworkTile
// ---------------------------------------------------------------------------

describe('processNetworkTile', () => {
  it('refuses a quadkey at the wrong zoom before touching Overpass or the database', async () => {
    let queried = false;
    const overpass = {
      query: () => {
        queried = true;
        return Promise.resolve({ elements: [] });
      },
    } as unknown as OverpassClient;

    await expect(processNetworkTile('023010', { overpass })).rejects.toThrow(
      new RegExp(`z${ROUTING_ZOOM} quadkey`),
    );
    expect(queried).toBe(false);
  });

  it('is defined at a finer zoom than the trail catalogue', () => {
    // A z9 network query keeps every alley in a city and times out. Smaller tiles also match
    // how planning is used: inside one valley, so a session touches one or two of them.
    expect(ROUTING_ZOOM).toBeGreaterThan(9);
  });
});
