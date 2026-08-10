/**
 * The grid's own contract, separate from the parity suite: it must return a *superset* of what
 * the unindexed pass keeps, in the tile's own order, whatever the geometry.
 */

import { describe, expect, it } from 'vitest';
import type { LngLat } from '@switchback/core';
import { EARTH_RADIUS_M } from '@switchback/geo';
import { attachWaypoints, terminusFeatures } from '../src/enrich';
import { FEATURE_CELL_M, buildFeatureIndex } from '../src/feature-index';
import type { OverpassElement } from '../src/overpass';

const DEG = Math.PI / 180;

/** Deterministic, so a failure is reproducible from the seed in the test name. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const KINDS: Record<string, string>[] = [
  { natural: 'peak' },
  { amenity: 'parking' },
  { tourism: 'viewpoint' },
  { barrier: 'gate' },
  { highway: 'bus_stop' }, // classifies as nothing — the index must drop it
];

function scatter(count: number, around: LngLat, spreadM: number, seed: number): OverpassElement[] {
  const next = random(seed);
  const out: OverpassElement[] = [];
  for (let id = 1; id <= count; id++) {
    const dLat = ((next() - 0.5) * 2 * spreadM) / (EARTH_RADIUS_M * DEG);
    const dLng = dLat / Math.cos(around[1] * DEG);
    out.push({
      type: 'node',
      id,
      lat: around[1] + dLat,
      lon: around[0] + dLng,
      tags: KINDS[id % KINDS.length]!,
    });
  }
  return out;
}

function keys(elements: readonly OverpassElement[]): string[] {
  return elements.map((element) => `${element.type}/${'id' in element ? element.id : '?'}`);
}

/** What the unindexed pass keeps, which is what `near` must contain. */
function attachedKeys(coords: readonly LngLat[], features: readonly OverpassElement[]): string[] {
  const waypoints = attachWaypoints(coords, features).map(
    (waypoint) => `${waypoint.osmType}/${waypoint.osmId}`,
  );
  return [...new Set(waypoints)];
}

function walk(from: LngLat, count: number, stepM: number, bearing: 'east' | 'north'): LngLat[] {
  const out: LngLat[] = [];
  for (let i = 0; i < count; i++) {
    const d = (i * stepM) / (EARTH_RADIUS_M * DEG);
    out.push(
      bearing === 'north'
        ? [from[0], from[1] + d]
        : [from[0] + d / Math.cos(from[1] * DEG), from[1]],
    );
  }
  return out;
}

describe('buildFeatureIndex', () => {
  it('holds only the features a rule classifies, and says how many it was offered', () => {
    const features = scatter(200, [-121.5, 47.5], 5_000, 7);
    const index = buildFeatureIndex(features);
    expect(index.sourceCount).toBe(200);
    expect(index.size).toBe(160); // one KINDS entry in five classifies as nothing
    expect(index.size).toBeLessThan(index.sourceCount);
  });

  it('returns a superset of the attached set, in feature order, over scattered geometry', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const centre: LngLat = [-121.5, 47.5];
      const features = scatter(400, centre, 3_000, seed);
      const index = buildFeatureIndex(features);
      // Vertices 400 m apart, which is wider than a cell: a per-vertex index would miss the
      // features beside the middle of a segment, and this is what catches that.
      const coords = walk(centre, 12, 400, seed % 2 === 0 ? 'east' : 'north');

      const near = index.near(coords);
      const nearKeys = new Set(keys(near));
      const attached = attachedKeys(coords, features);
      // Without this the loop below would pass on a line with nothing near it.
      expect(attached.length, `seed ${seed}: nothing attached, nothing proved`).toBeGreaterThan(0);
      for (const key of attached) {
        expect(nearKeys.has(key), `seed ${seed}: ${key} attached but not returned`).toBe(true);
      }
      expect(near.length).toBeLessThan(features.length);
      // Order preserved, which is what makes the dedupe and the sort come out the same.
      expect(keys(near)).toEqual(keys(features.filter((one) => nearKeys.has(keys([one])[0]!))));
    }
  });

  it('agrees with the unindexed pass on both enrichment outputs', () => {
    const centre: LngLat = [7.65, 45.98];
    const features = scatter(300, centre, 2_000, 11);
    const coords = walk(centre, 20, 150, 'east');
    const near = buildFeatureIndex(features).near(coords);

    expect(attachWaypoints(coords, near)).toEqual(attachWaypoints(coords, features));
    expect(terminusFeatures(coords, near)).toEqual(terminusFeatures(coords, features));
  });

  it('answers the same for a line and its reverse', () => {
    // `commitTrail` queries once with the un-oriented line and uses the answer for the oriented
    // one, which `deriveTrail` may have reversed. That is only sound if this holds.
    const centre: LngLat = [-121.5, 47.5];
    const features = scatter(400, centre, 3_000, 17);
    const coords = walk(centre, 15, 300, 'east');
    const index = buildFeatureIndex(features);

    const forward = index.near(coords);
    expect(forward.length).toBeGreaterThan(0);
    expect(keys(index.near([...coords].reverse()))).toEqual(keys(forward));
  });

  it('answers an empty feature set, an empty line and a single vertex without throwing', () => {
    const empty = buildFeatureIndex([]);
    expect(empty.size).toBe(0);
    expect(empty.sourceCount).toBe(0);
    expect(empty.near([[0, 0]])).toEqual([]);

    const index = buildFeatureIndex(scatter(20, [-100, 40], 100, 3));
    expect(index.near([])).toEqual([]);
    expect(index.near([[-100, 40]]).length).toBeGreaterThan(0);
  });

  it('covers a segment that spans the antimeridian, and one beside a pole', () => {
    const seam = buildFeatureIndex([
      { type: 'node', id: 1, lat: -16.5, lon: 179.9995, tags: { natural: 'peak' } },
      { type: 'node', id: 2, lat: -16.5, lon: -179.9995, tags: { natural: 'peak' } },
      { type: 'node', id: 3, lat: 40, lon: 0, tags: { natural: 'peak' } },
    ]);
    const across = seam.near([
      [179.999, -16.5],
      [-179.999, -16.5],
    ]);
    expect(keys(across)).toContain('node/1');
    expect(keys(across)).toContain('node/2');

    // A degree of longitude is 194 m here, so the query is thousands of cells wide.
    const polarFeatures = scatter(50, [15, 89.9], 300, 5);
    const line = walk([15, 89.9], 6, 200, 'east');
    const nearKeys = new Set(keys(buildFeatureIndex(polarFeatures).near(line)));
    const attached = attachedKeys(line, polarFeatures);
    expect(attached.length).toBeGreaterThan(0);
    for (const key of attached) {
      expect(nearKeys.has(key), `polar: ${key} attached but not returned`).toBe(true);
    }
  });

  it('is a superset at every cell size, not only the shipped one', () => {
    const centre: LngLat = [-105.2, 39.7];
    const features = scatter(500, centre, 4_000, 13);
    const coords = walk(centre, 30, 250, 'east');
    const expected = attachedKeys(coords, features);
    expect(expected.length).toBeGreaterThan(0);

    for (const cellM of [50, FEATURE_CELL_M, 5_000]) {
      const nearKeys = new Set(keys(buildFeatureIndex(features, cellM).near(coords)));
      for (const key of expected) {
        expect(nearKeys.has(key), `cell ${cellM} m: ${key} attached but not returned`).toBe(true);
      }
    }
  });
});
