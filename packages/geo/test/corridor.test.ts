import { describe, expect, it } from 'vitest';
import type { LineString } from '@switchback/core';
import { MAX_CORRIDOR_TILES, lngLatToTile, tileCorridor, tileUrl } from '@switchback/geo';

/** A short there-and-back on Vesper Peak, close enough to the real line for tile maths. */
const SHORT: LineString = {
  type: 'LineString',
  coordinates: [
    [-121.4922, 48.0169],
    [-121.4901, 48.0181],
    [-121.4877, 48.0194],
  ],
};

/** Roughly Mexico to Canada, as the crow flies. The shape a bounding box handles worst. */
const LONG: LineString = {
  type: 'LineString',
  coordinates: [
    [-116.47, 32.59],
    [-118.2, 36.5],
    [-120.0, 39.3],
    [-121.7, 45.65],
    [-120.73, 49.0],
  ],
};

function keys(tiles: ReadonlyArray<{ x: number; y: number; z: number }>): Set<string> {
  return new Set(tiles.map((tile) => `${tile.z}/${tile.x}/${tile.y}`));
}

describe('tileCorridor', () => {
  it('covers every zoom in the range when the trail is small', () => {
    const result = tileCorridor(SHORT, { minZoom: 10, maxZoom: 14 });
    expect(result.truncated).toBe(false);
    expect(result.coveredMaxZoom).toBe(14);

    const zooms = new Set(result.tiles.map((tile) => tile.z));
    expect([...zooms].sort((a, b) => a - b)).toEqual([10, 11, 12, 13, 14]);
  });

  it('includes the tile each endpoint falls in', () => {
    const result = tileCorridor(SHORT, { minZoom: 12, maxZoom: 14 });
    const present = keys(result.tiles);

    for (const z of [12, 13, 14]) {
      for (const [lng, lat] of SHORT.coordinates) {
        const tile = lngLatToTile(lng, lat, z);
        expect(present.has(`${z}/${tile.x}/${tile.y}`)).toBe(true);
      }
    }
  });

  it('emits no duplicates', () => {
    const result = tileCorridor(LONG, { minZoom: 6, maxZoom: 9 });
    expect(keys(result.tiles).size).toBe(result.tiles.length);
  });

  it('never skips a tile along a segment that crosses several', () => {
    // One straight segment across ~8 tiles of longitude at z10: a hike sampling too coarsely
    // would leave gaps in the middle of this run.
    const line: LineString = {
      type: 'LineString',
      coordinates: [
        [-121.9, 47.5],
        [-121.1, 47.5],
      ],
    };
    const result = tileCorridor(line, { minZoom: 10, maxZoom: 10, ring: 0 });
    const xs = result.tiles.map((tile) => tile.x).sort((a, b) => a - b);
    const west = lngLatToTile(-121.9, 47.5, 10).x;
    const east = lngLatToTile(-121.1, 47.5, 10).x;

    expect(xs[0]).toBe(west);
    expect(xs.at(-1)).toBe(east);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!).toBe(1);
    }
  });

  it('adds a ring of neighbours around the line', () => {
    const bare = tileCorridor(SHORT, { minZoom: 13, maxZoom: 13, ring: 0 });
    const ringed = tileCorridor(SHORT, { minZoom: 13, maxZoom: 13, ring: 1 });

    expect(ringed.tiles.length).toBeGreaterThan(bare.tiles.length);
    // Every bare tile survives dilation.
    for (const key of keys(bare.tiles)) expect(keys(ringed.tiles).has(key)).toBe(true);
  });

  /**
   * The saving grows with zoom: a corridor is a line so its count doubles per level, a box is
   * an area so its count quadruples. Two levels deeper is a fourfold better bargain.
   */
  it('beats the trail bounding box by a margin that widens with zoom', () => {
    function ratioAt(z: number): number {
      const corridor = tileCorridor(LONG, { minZoom: z, maxZoom: z, ring: 1, cap: 1e9 });
      const nw = lngLatToTile(-121.7, 49.0, z);
      const se = lngLatToTile(-116.47, 32.59, z);
      const box = (se.x - nw.x + 1) * (se.y - nw.y + 1);
      return corridor.tiles.length / box;
    }

    const coarse = ratioAt(10);
    const fine = ratioAt(13);

    expect(coarse).toBeLessThan(0.3);
    // Eight times cheaper again, three levels down.
    expect(fine).toBeLessThan(coarse / 5);
  });

  describe('the cap', () => {
    it('drops whole zooms rather than truncating one', () => {
      const result = tileCorridor(LONG, { minZoom: 8, maxZoom: 16, cap: 4_000 });
      expect(result.truncated).toBe(true);
      expect(result.tiles.length).toBeLessThanOrEqual(4_000);

      // Every zoom present is complete: none was cut off part way through.
      const byZoom = new Map<number, number>();
      for (const tile of result.tiles) byZoom.set(tile.z, (byZoom.get(tile.z) ?? 0) + 1);
      const zooms = [...byZoom.keys()].sort((a, b) => a - b);
      expect(zooms[0]).toBe(8);
      expect(zooms.at(-1)).toBe(result.coveredMaxZoom);
      // Contiguous from the coarsest — the deepest are the ones dropped.
      expect(zooms).toEqual(zooms.map((_, i) => 8 + i));
    });

    it('still returns the coarsest zoom when even that exceeds the cap', () => {
      const result = tileCorridor(LONG, { minZoom: 9, maxZoom: 14, cap: 1 });
      expect(result.tiles.length).toBeGreaterThan(1);
      expect(result.tiles.every((tile) => tile.z === 9)).toBe(true);
      expect(result.truncated).toBe(true);
    });

    it('defaults to a cap that admits an ordinary day hike in full', () => {
      const result = tileCorridor(SHORT, { minZoom: 10, maxZoom: 15 });
      expect(result.tiles.length).toBeLessThan(MAX_CORRIDOR_TILES);
      expect(result.truncated).toBe(false);
    });
  });

  it('keeps tile indices inside the pyramid', () => {
    const result = tileCorridor(LONG, { minZoom: 4, maxZoom: 6 });
    for (const tile of result.tiles) {
      const n = 2 ** tile.z;
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(n);
      expect(tile.y).toBeGreaterThanOrEqual(0);
      expect(tile.y).toBeLessThan(n);
    }
  });

  it('survives a degenerate line', () => {
    const single: LineString = { type: 'LineString', coordinates: [[-121.49, 48.01]] };
    const result = tileCorridor(single, { minZoom: 12, maxZoom: 13 });
    expect(result.tiles.length).toBeGreaterThan(0);

    const empty: LineString = { type: 'LineString', coordinates: [] };
    expect(tileCorridor(empty, { minZoom: 12, maxZoom: 13 }).tiles).toEqual([]);
  });
});

describe('tileUrl', () => {
  it('fills z, x and y', () => {
    expect(tileUrl('https://t/{z}/{x}/{y}.png', { x: 3, y: 5, z: 3 })).toBe('https://t/3/3/5.png');
  });

  it('flips y for TMS-ordered templates', () => {
    expect(tileUrl('https://t/{z}/{x}/{-y}.png', { x: 3, y: 5, z: 3 })).toBe('https://t/3/3/2.png');
  });
});
