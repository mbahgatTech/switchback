import { describe, expect, it } from 'vitest';
import {
  NO_DATA_ELEVATION,
  TERRARIUM_ZOOM,
  type TerrariumTile,
  decodeElevation,
  pixelForLngLat,
  requiredTiles,
  sampleElevations,
  sampleTileBilinear,
  terrariumUrl,
  tileKey,
} from '@switchback/geo';

/** Encode metres back into terrarium RGB, so fixtures state elevations, not bytes. */
function encode(elevationM: number): [number, number, number] {
  const v = elevationM + 32768;
  const r = Math.floor(v / 256);
  const g = Math.floor(v) % 256;
  const b = Math.round((v - Math.floor(v)) * 256) % 256;
  return [r, g, b];
}

/** A tile whose elevation is a function of its pixel column/row. */
function makeTile(
  width: number,
  height: number,
  at: (x: number, y: number) => number,
  overrides: Partial<TerrariumTile> = {},
): TerrariumTile {
  const data = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = encode(at(x, y));
      const i = (y * width + x) * 3;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  return { z: TERRARIUM_ZOOM, x: 0, y: 0, width, height, channels: 3, data, ...overrides };
}

describe('decodeElevation', () => {
  it('puts sea level at R=128', () => {
    expect(decodeElevation(128, 0, 0)).toBe(0);
  });

  it('decodes the elevation of Everest (8,848 m)', () => {
    expect(decodeElevation(162, 144, 0)).toBe(8848);
  });

  it('decodes below sea level — Badwater Basin (−86 m)', () => {
    expect(decodeElevation(127, 170, 0)).toBe(-86);
  });

  it('carries sub-metre precision in the blue channel', () => {
    expect(decodeElevation(128, 10, 128)).toBe(10.5);
    expect(decodeElevation(128, 10, 64)).toBe(10.25);
  });

  it('returns the no-data sentinel for an all-zero pixel', () => {
    expect(decodeElevation(0, 0, 0)).toBe(NO_DATA_ELEVATION);
  });

  it('round-trips every elevation the encoder produces', () => {
    for (const m of [-430, -86, 0, 0.5, 1000, 4808, 8848]) {
      const [r, g, b] = encode(m);
      expect(decodeElevation(r, g, b)).toBeCloseTo(m, 2);
    }
  });
});

describe('pixelForLngLat', () => {
  it('puts the null island on the corner of the four central tiles', () => {
    const p = pixelForLngLat(0, 0, TERRARIUM_ZOOM);
    expect(p).toEqual({ x: 4096, y: 4096, z: TERRARIUM_ZOOM, px: 0, py: 0 });
  });

  it('agrees with the tile grid it shares', () => {
    const p = pixelForLngLat(7.658, 45.976, 9);
    expect(p.x).toBe(266);
    expect(p.px).toBeGreaterThanOrEqual(0);
    expect(p.px).toBeLessThan(256);
    expect(p.py).toBeGreaterThanOrEqual(0);
    expect(p.py).toBeLessThan(256);
  });

  it('clamps past the Mercator limit rather than producing NaN', () => {
    const p = pixelForLngLat(0, 89.999, 5);
    expect(Number.isFinite(p.py)).toBe(true);
    expect(p.y).toBe(0);
  });
});

describe('sampleTileBilinear', () => {
  // Elevation rises 100 m per pixel column: a clean ramp to interpolate across.
  const ramp = makeTile(4, 4, (x) => x * 100);

  it('is exact at pixel centres', () => {
    expect(sampleTileBilinear(ramp, 0.5, 0.5)).toBeCloseTo(0, 6);
    expect(sampleTileBilinear(ramp, 1.5, 0.5)).toBeCloseTo(100, 6);
    expect(sampleTileBilinear(ramp, 3.5, 0.5)).toBeCloseTo(300, 6);
  });

  it('interpolates between them instead of stepping', () => {
    expect(sampleTileBilinear(ramp, 2.0, 0.5)).toBeCloseTo(150, 6);
    expect(sampleTileBilinear(ramp, 2.25, 0.5)).toBeCloseTo(175, 6);
  });

  it('interpolates on both axes', () => {
    const diagonal = makeTile(4, 4, (x, y) => x * 100 + y * 10);
    expect(diagonal.width).toBe(4);
    expect(sampleTileBilinear(diagonal, 2.0, 2.0)).toBeCloseTo(150 + 15, 6);
  });

  it('clamps at the tile edge rather than reading out of bounds', () => {
    expect(sampleTileBilinear(ramp, 0, 0)).toBeCloseTo(0, 6);
    expect(sampleTileBilinear(ramp, 4, 4)).toBeCloseTo(300, 6);
  });

  it('falls back to nearest-neighbour beside a no-data pixel', () => {
    // Blending -32768 into a coastal sample would drag the profile to nonsense.
    const coastal = makeTile(4, 4, (x) => (x === 0 ? NO_DATA_ELEVATION : 100));
    expect(sampleTileBilinear(coastal, 1.0, 1.5)).toBe(100);
  });

  it('reads RGBA tiles as well as RGB', () => {
    const rgb = makeTile(2, 2, () => 500);
    const rgba = new Uint8Array(2 * 2 * 4);
    for (let p = 0; p < 4; p++) {
      rgba[p * 4] = rgb.data[p * 3]!;
      rgba[p * 4 + 1] = rgb.data[p * 3 + 1]!;
      rgba[p * 4 + 2] = rgb.data[p * 3 + 2]!;
      rgba[p * 4 + 3] = 255;
    }
    const tile: TerrariumTile = { ...rgb, channels: 4, data: rgba };
    expect(sampleTileBilinear(tile, 1, 1)).toBeCloseTo(500, 6);
  });
});

describe('sampleElevations', () => {
  const p = pixelForLngLat(7.658, 45.976, TERRARIUM_ZOOM);
  const tile = makeTile(256, 256, () => 1450, { x: p.x, y: p.y });
  const tiles = new Map([[tileKey(p.z, p.x, p.y), tile]]);

  it('samples a coordinate whose tile is loaded', () => {
    expect(sampleElevations([[7.658, 45.976]], tiles)).toEqual([1450]);
  });

  it('returns null for a coordinate whose tile is missing, rather than guessing', () => {
    expect(sampleElevations([[-118.4, 33.9]], tiles)).toEqual([null]);
  });

  it('returns null for a no-data pixel', () => {
    const ocean = new Map([
      [tileKey(p.z, p.x, p.y), makeTile(256, 256, () => NO_DATA_ELEVATION, { x: p.x, y: p.y })],
    ]);
    expect(sampleElevations([[7.658, 45.976]], ocean)).toEqual([null]);
  });

  it('preserves input order and length', () => {
    const coords: Array<[number, number]> = [
      [7.658, 45.976],
      [-118.4, 33.9],
      [7.6581, 45.9761],
    ];
    const out = sampleElevations(coords, tiles);
    expect(out).toHaveLength(3);
    expect(out[1]).toBeNull();
  });
});

describe('requiredTiles', () => {
  it('deduplicates coordinates that share a tile', () => {
    const coords: Array<[number, number]> = Array.from({ length: 50 }, (_, i) => [
      7.658 + i * 0.00001,
      45.976,
    ]);
    expect(requiredTiles(coords)).toHaveLength(1);
  });

  it('lists each distinct tile once, in first-seen order', () => {
    const tilesNeeded = requiredTiles([
      [7.658, 45.976],
      [-118.4, 33.9],
      [7.658, 45.976],
    ]);
    expect(tilesNeeded).toHaveLength(2);
    expect(tilesNeeded[0]).toEqual({ z: TERRARIUM_ZOOM, x: 4270, y: 2915 });
  });

  it('returns nothing for no coordinates', () => {
    expect(requiredTiles([])).toEqual([]);
  });
});

describe('terrariumUrl', () => {
  it('builds the AWS terrain-tiles path', () => {
    expect(terrariumUrl(13, 4270, 2915)).toBe(
      'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/13/4270/2915.png',
    );
  });
});
