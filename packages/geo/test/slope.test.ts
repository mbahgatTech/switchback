import { describe, expect, it } from 'vitest';
import {
  NO_DATA_ELEVATION,
  type SlopeBand,
  groundResolutionM,
  shadeSlope,
  slopeDegrees,
  tileCentreLatitude,
} from '@switchback/geo';

/**
 * A padded grid whose elevation is a function of its position in the *tile*, so a fixture
 * says what the ground does rather than what the array index is.
 *
 * `at` is called with coordinates running from -1 to `size`, the padding included: the ring
 * is real neighbouring ground here, exactly as it is when the protocol assembles nine tiles.
 */
function padded(size: number, at: (x: number, y: number) => number): Float32Array {
  const stride = size + 2;
  const grid = new Float32Array(stride * stride);
  for (let row = -1; row <= size; row += 1) {
    for (let col = -1; col <= size; col += 1) {
      grid[(row + 1) * stride + (col + 1)] = at(col, row);
    }
  }
  return grid;
}

describe('groundResolutionM', () => {
  it('gives the standard Web Mercator figure at the equator', () => {
    // The number every tile-scheme table opens with: one z0 tile spans the world, so a pixel
    // of it is 1/256th of the equator.
    expect(groundResolutionM(0, 0)).toBeCloseTo(156_543.034, 2);
    expect(groundResolutionM(13, 0)).toBeCloseTo(19.109, 3);
  });

  it('halves at 60 degrees, where the meridians have closed by half', () => {
    // Mercator's scale factor is 1/cos(lat). Getting this wrong scales every angle the
    // overlay reports, which is why it is measured rather than assumed constant.
    expect(groundResolutionM(13, 60)).toBeCloseTo(groundResolutionM(13, 0) / 2, 3);
    expect(groundResolutionM(13, -60)).toBeCloseTo(groundResolutionM(13, 60), 6);
  });

  it('scales with the tile size it is asked about', () => {
    expect(groundResolutionM(10, 45, 512)).toBeCloseTo(groundResolutionM(10, 45, 256) / 2, 6);
  });
});

describe('tileCentreLatitude', () => {
  it('puts the single z0 tile on the equator', () => {
    expect(tileCentreLatitude(0, 0)).toBeCloseTo(0, 9);
  });

  it('finds the middle of a hemisphere tile, in Mercator rather than in degrees', () => {
    // Not 42.5 — the northern z1 tile spans 0 to 85.05, but its *centre pixel* is at the
    // latitude a quarter of the way down the projected world, which is 66.51.
    expect(tileCentreLatitude(0, 1)).toBeCloseTo(66.5133, 3);
    expect(tileCentreLatitude(1, 1)).toBeCloseTo(-66.5133, 3);
  });
});

describe('slopeDegrees', () => {
  it('reads a one-in-one ramp as 45 degrees, everywhere including the edges', () => {
    // A plane rising one metre per pixel east, sampled at one metre per pixel.
    const size = 4;
    const degrees = slopeDegrees(
      padded(size, (x) => x),
      size,
      1,
    );
    for (const angle of degrees) expect(angle).toBeCloseTo(45, 6);
  });

  it('is the same angle whichever way the ground faces', () => {
    const size = 4;
    const east = slopeDegrees(
      padded(size, (x) => x),
      size,
      1,
    );
    const north = slopeDegrees(
      padded(size, (_x, y) => y),
      size,
      1,
    );
    // A 45° plane facing north-east: the rise is spread over a diagonal step, so the run per
    // axis is 1/√2. A naive `max(dzdx, dzdy)` would call this 35°.
    const diagonal = slopeDegrees(
      padded(size, (x, y) => (x + y) / Math.SQRT2),
      size,
      1,
    );

    // Aspect is not what this layer measures; a 45° face is 45° facing any quarter.
    for (let i = 0; i < east.length; i += 1) {
      expect(north[i]!).toBeCloseTo(east[i]!, 6);
      expect(diagonal[i]!).toBeCloseTo(45, 6);
    }
  });

  it('divides the rise by the real ground distance', () => {
    const size = 3;
    // The same metre of rise spread over two metres of run: half the gradient, 26.57°.
    const degrees = slopeDegrees(
      padded(size, (x) => x),
      size,
      2,
    );
    for (const angle of degrees) expect(angle).toBeCloseTo(26.565, 3);
  });

  it('reads flat ground as flat', () => {
    const size = 3;
    const degrees = slopeDegrees(
      padded(size, () => 812),
      size,
      19.1,
    );
    for (const angle of degrees) expect(angle).toBe(0);
  });

  it('refuses to compute an angle against a no-data pixel', () => {
    const size = 3;
    const grid = padded(size, (x) => x);
    // One ocean pixel in the padding, north-west of the tile's own top-left corner.
    grid[0] = NO_DATA_ELEVATION;

    const degrees = slopeDegrees(grid, size, 1);
    // Only the pixel whose kernel reaches it is blanked — a -32768 in the window would put a
    // 32 km cliff on the map, and blanking the whole tile would hide a real coastline.
    expect(degrees[0]).toBe(0);
    expect(degrees[1]).toBeCloseTo(45, 6);
    expect(degrees[size]).toBeCloseTo(45, 6);
  });

  it('returns one value per pixel of the tile, not of the padded grid', () => {
    expect(
      slopeDegrees(
        padded(8, () => 0),
        8,
        1,
      ),
    ).toHaveLength(64);
  });
});

describe('shadeSlope', () => {
  const bands: readonly SlopeBand[] = [
    { fromDeg: 27, rgba: [1, 1, 1, 71] },
    { fromDeg: 35, rgba: [2, 2, 2, 148] },
    { fromDeg: 50, rgba: [3, 3, 3, 230] },
  ];

  const alphaFor = (angle: number): number => shadeSlope(Float32Array.of(angle), bands)[3]!;
  const bandFor = (angle: number): number => shadeSlope(Float32Array.of(angle), bands)[0]!;

  it('leaves gentle ground unpainted', () => {
    // Fully transparent, not faintly tinted: most of any map is gentle, and shading all of it
    // would make the overlay a filter over the sheet rather than a reading off it.
    expect(alphaFor(0)).toBe(0);
    expect(alphaFor(26.9)).toBe(0);
  });

  it('includes the lower bound of a band', () => {
    expect(bandFor(27)).toBe(1);
    expect(bandFor(35)).toBe(2);
    expect(bandFor(50)).toBe(3);
  });

  it('holds a band until the next one opens', () => {
    expect(bandFor(34.99)).toBe(1);
    expect(bandFor(49.99)).toBe(2);
    expect(bandFor(89)).toBe(3);
  });

  it('gets denser with every step up', () => {
    // The property that carries the ramp when the hue does not — greyscale, a colour-blind
    // reader, a phone in bright sun.
    const alphas = [27, 35, 50].map(alphaFor);
    expect(alphas).toEqual([...alphas].sort((a, b) => a - b));
    expect(new Set(alphas).size).toBe(3);
  });

  it('paints four channels per angle', () => {
    const painted = shadeSlope(Float32Array.of(0, 40, 60), bands);
    expect(painted).toHaveLength(12);
    expect([...painted.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect([...painted.slice(4, 8)]).toEqual([2, 2, 2, 148]);
  });
});
