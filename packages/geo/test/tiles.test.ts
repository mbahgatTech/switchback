import { describe, expect, it } from 'vitest';
import {
  INGEST_ZOOM,
  MAX_TILES_PER_REQUEST,
  MERCATOR_MAX_LAT,
  coverBBox,
  coverBBoxFromCentre,
  lngLatToTile,
  quadkeyToBBox,
  quadkeyToTile,
  tileToBBox,
  tileToLngLat,
  tileToQuadkey,
} from '@switchback/geo';

describe('tileToQuadkey / quadkeyToTile', () => {
  /** The worked example from Microsoft's Bing Maps tile-system documentation. */
  it('matches the reference example: tile (3, 5) at z3 is quadkey "213"', () => {
    expect(tileToQuadkey({ x: 3, y: 5, z: 3 })).toBe('213');
    expect(quadkeyToTile('213')).toEqual({ x: 3, y: 5, z: 3 });
  });

  it('numbers the four z1 quadrants NW, NE, SW, SE', () => {
    expect(tileToQuadkey({ x: 0, y: 0, z: 1 })).toBe('0');
    expect(tileToQuadkey({ x: 1, y: 0, z: 1 })).toBe('1');
    expect(tileToQuadkey({ x: 0, y: 1, z: 1 })).toBe('2');
    expect(tileToQuadkey({ x: 1, y: 1, z: 1 })).toBe('3');
  });

  it('round-trips every tile at z4', () => {
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 16; y++) {
        const key = tileToQuadkey({ x, y, z: 4 });
        expect(key).toHaveLength(4);
        expect(quadkeyToTile(key)).toEqual({ x, y, z: 4 });
      }
    }
  });

  it('makes a quadkey a prefix of all its descendants', () => {
    const parent = tileToQuadkey({ x: 3, y: 5, z: 3 });
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      expect(tileToQuadkey({ x: 6 + dx!, y: 10 + dy!, z: 4 })).toMatch(new RegExp(`^${parent}`));
    }
  });

  it('rejects an invalid digit rather than returning a plausible tile', () => {
    expect(() => quadkeyToTile('2143')).toThrow(/invalid digit/);
  });
});

describe('lngLatToTile', () => {
  it('puts the whole world in one tile at z0', () => {
    expect(lngLatToTile(0, 0, 0)).toEqual({ x: 0, y: 0, z: 0 });
    expect(lngLatToTile(179, -80, 0)).toEqual({ x: 0, y: 0, z: 0 });
  });

  it('splits the world into quadrants at z1 about the null island', () => {
    expect(lngLatToTile(-1, 1, 1)).toEqual({ x: 0, y: 0, z: 1 });
    expect(lngLatToTile(1, 1, 1)).toEqual({ x: 1, y: 0, z: 1 });
    expect(lngLatToTile(-1, -1, 1)).toEqual({ x: 0, y: 1, z: 1 });
    expect(lngLatToTile(1, -1, 1)).toEqual({ x: 1, y: 1, z: 1 });
  });

  it('clamps beyond the Mercator limit instead of returning NaN', () => {
    const north = lngLatToTile(0, 89.9, 5);
    const south = lngLatToTile(0, -89.9, 5);
    expect(north).toEqual({ x: 16, y: 0, z: 5 });
    expect(south).toEqual({ x: 16, y: 31, z: 5 });
  });

  it('clamps the eastern edge into the last column', () => {
    expect(lngLatToTile(180, 0, 5).x).toBe(31);
  });
});

describe('tileToLngLat / tileToBBox', () => {
  it('bounds the z0 tile at the Mercator limits', () => {
    const [w, s, e, n] = tileToBBox({ x: 0, y: 0, z: 0 });
    expect(w).toBeCloseTo(-180, 6);
    expect(e).toBeCloseTo(180, 6);
    expect(n).toBeCloseTo(MERCATOR_MAX_LAT, 5);
    expect(s).toBeCloseTo(-MERCATOR_MAX_LAT, 5);
  });

  it('returns the north-west corner of a tile', () => {
    expect(tileToLngLat(1, 1, 1)).toEqual([0, 0]);
  });

  it('inverts lngLatToTile — a tile’s own bbox centre lands back in it', () => {
    for (const [lng, lat] of [
      [7.658, 45.976],
      [-118.4, 33.9],
      [151.2, -33.87],
    ]) {
      const tile = lngLatToTile(lng!, lat!, INGEST_ZOOM);
      const [w, s, e, n] = tileToBBox(tile);
      expect(lngLatToTile((w + e) / 2, (s + n) / 2, INGEST_ZOOM)).toEqual(tile);
      expect(lng!).toBeGreaterThanOrEqual(w);
      expect(lng!).toBeLessThanOrEqual(e);
      expect(lat!).toBeGreaterThanOrEqual(s);
      expect(lat!).toBeLessThanOrEqual(n);
    }
  });

  it('agrees with quadkeyToBBox', () => {
    const tile = { x: 271, y: 186, z: 9 };
    expect(quadkeyToBBox(tileToQuadkey(tile))).toEqual(tileToBBox(tile));
  });
});

describe('coverBBox', () => {
  it('covers a small viewport with a handful of tiles', () => {
    const result = coverBBox([7.6, 45.9, 7.9, 46.1]);
    expect(result.tooLarge).toBe(false);
    expect(result.quadkeys.length).toBeGreaterThan(0);
    expect(result.quadkeys.length).toBe(result.requiredTiles);
    expect(result.quadkeys.every((k) => k.length === INGEST_ZOOM)).toBe(true);
  });

  it('covers a point bbox with exactly the tile containing it', () => {
    const result = coverBBox([7.658, 45.976, 7.658, 45.976]);
    expect(result.quadkeys).toEqual([tileToQuadkey(lngLatToTile(7.658, 45.976, INGEST_ZOOM))]);
  });

  it('refuses a continent-sized box and says how many tiles it would have taken', () => {
    const result = coverBBox([-10, 35, 30, 60]);
    expect(result.tooLarge).toBe(true);
    expect(result.quadkeys).toEqual([]);
    expect(result.requiredTiles).toBeGreaterThan(MAX_TILES_PER_REQUEST);
  });

  it('returns unique quadkeys', () => {
    const { quadkeys } = coverBBox([7.6, 45.9, 7.9, 46.1]);
    expect(new Set(quadkeys).size).toBe(quadkeys.length);
  });

  it('splits an antimeridian-crossing viewport into both hemispheres', () => {
    const result = coverBBox([179, 0.1, -179, 0.4]);
    expect(result.tooLarge).toBe(false);
    expect(result.quadkeys.length).toBe(4);
    // Tiles hard against 180° sit in the last columns; tiles just past it, in the first.
    const columns = result.quadkeys.map((k) => quadkeyToTile(k).x);
    expect(columns.some((x) => x > 500)).toBe(true);
    expect(columns.some((x) => x < 10)).toBe(true);
  });

  it('honours an explicit zoom and tile cap', () => {
    const result = coverBBox([7.6, 45.9, 7.9, 46.1], 12, 4);
    expect(result.tooLarge).toBe(true);
    expect(coverBBox([7.6, 45.9, 7.9, 46.1], 6).quadkeys[0]).toHaveLength(6);
  });
});

describe('coverBBoxFromCentre', () => {
  it('agrees with coverBBox on a box that fits under the cap', () => {
    const box = [7.6, 45.9, 7.9, 46.1] as const;
    const centre = coverBBoxFromCentre([...box]);
    const plain = coverBBox([...box]);

    expect(centre.capped).toBe(false);
    expect(centre.requiredTiles).toBe(plain.requiredTiles);
    // Same set, different order — this one sorts by distance from the middle.
    expect([...centre.quadkeys].sort()).toEqual([...plain.quadkeys].sort());
  });

  it('truncates a continent instead of refusing it, unlike coverBBox', () => {
    const box: [number, number, number, number] = [-10, 35, 30, 60];
    expect(coverBBox(box).tooLarge).toBe(true);

    const result = coverBBoxFromCentre(box, INGEST_ZOOM, MAX_TILES_PER_REQUEST);
    expect(result.capped).toBe(true);
    expect(result.quadkeys).toHaveLength(MAX_TILES_PER_REQUEST);
    expect(result.requiredTiles).toBe(coverBBox(box).requiredTiles);
  });

  it('takes the tiles nearest the centre, nearest first', () => {
    const box: [number, number, number, number] = [-10, 35, 30, 60];
    const { quadkeys } = coverBBoxFromCentre(box, INGEST_ZOOM, 9);

    /*
     * The centre of the *tile grid*, not `lngLatToTile` of the box's mid-latitude. Mercator
     * rows are linear in screen space and not in degrees, so on a box 25° tall those two
     * are several tiles apart — and the grid centre is the one that means "the middle of
     * what the user is looking at", which is what this ordering is for.
     */
    const nw = lngLatToTile(box[0], box[3], INGEST_ZOOM);
    const se = lngLatToTile(box[2], box[1], INGEST_ZOOM);
    const cx = (nw.x + se.x) / 2;
    const cy = (nw.y + se.y) / 2;

    const distances = quadkeys.map((key) => {
      const { x, y } = quadkeyToTile(key);
      return Math.hypot(x - cx, y - cy);
    });

    // The first tile is the one under the centre of the view...
    expect(distances[0]).toBeLessThanOrEqual(1);
    // ...and the sequence never doubles back towards it.
    for (let i = 1; i < distances.length; i++) {
      expect(distances[i]).toBeGreaterThanOrEqual(distances[i - 1]! - 1e-9);
    }
  });

  it('returns unique quadkeys', () => {
    const { quadkeys } = coverBBoxFromCentre([-125, 30, -60, 50], INGEST_ZOOM, 96);
    expect(new Set(quadkeys).size).toBe(quadkeys.length);
    expect(quadkeys).toHaveLength(96);
  });

  it('fills a one-row strip along its own axis rather than clipping to a square', () => {
    // Built from a real tile's own bounds, so the strip is exactly one row tall by
    // construction rather than by an arithmetic guess about how many degrees a z9 row spans.
    const [, s, , n] = tileToBBox({ x: 100, y: 184, z: INGEST_ZOOM });
    const mid = (s + n) / 2;

    const result = coverBBoxFromCentre([-60, mid - 0.01, 0, mid + 0.01], INGEST_ZOOM, 48);
    expect(result.quadkeys).toHaveLength(48);
    expect(new Set(result.quadkeys.map((k) => quadkeyToTile(k).y)).size).toBe(1);
  });

  it('covers both sides of the antimeridian rather than the world in between', () => {
    const result = coverBBoxFromCentre([179, 0.1, -179, 0.4], INGEST_ZOOM, 12);
    expect(result.capped).toBe(false);
    expect(result.quadkeys).toHaveLength(4);

    const columns = result.quadkeys.map((k) => quadkeyToTile(k).x);
    expect(columns.some((x) => x > 500)).toBe(true);
    expect(columns.some((x) => x < 10)).toBe(true);
  });

  it('is stable — the same box always produces the same order', () => {
    const box: [number, number, number, number] = [-125, 30, -60, 50];
    expect(coverBBoxFromCentre(box, INGEST_ZOOM, 32).quadkeys).toEqual(
      coverBBoxFromCentre(box, INGEST_ZOOM, 32).quadkeys,
    );
  });

  it('does not enumerate a quarter of a million tiles for a world view', () => {
    // z9 spans 262,144 tiles. If the candidate window were the box rather than the cap,
    // this call would allocate all of them; the assertion is really that it returns at all.
    const result = coverBBoxFromCentre([-180, -85, 180, 85], INGEST_ZOOM, 96);
    expect(result.quadkeys).toHaveLength(96);
    expect(result.requiredTiles).toBe(512 * 512);
    expect(result.capped).toBe(true);
  });

  it('covers a point bbox with exactly the tile containing it', () => {
    const result = coverBBoxFromCentre([7.658, 45.976, 7.658, 45.976]);
    expect(result.requiredTiles).toBe(1);
    expect(result.quadkeys).toEqual([tileToQuadkey(lngLatToTile(7.658, 45.976, INGEST_ZOOM))]);
  });
});
