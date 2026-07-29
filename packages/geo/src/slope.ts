import { NO_DATA_ELEVATION, TERRARIUM_TILE_SIZE } from './terrarium';
import { tileToLngLat } from './tiles';

/**
 * Slope angle from an elevation raster.
 *
 * The angle of the ground is the single number that decides whether a slope slides. The
 * avalanche literature is unusually consistent about it: releases cluster between 35° and
 * 45°, thin out sharply below 30° because the snow will not fail, and thin out again above
 * 50° because the snow sluffs off continuously instead of building a slab. Nothing else a
 * map can show — aspect, elevation, even the forecast — narrows the ground down as fast.
 *
 * This module turns a decoded DEM tile into that angle, per pixel, and nothing more. It has
 * no opinion on colour, no network, and no canvas: the browser plumbing lives in the web
 * app, and the same functions serve the phone when its map grows the same overlay.
 *
 * **Horn's method**, the 3×3 kernel every GIS uses, weighting the four edge-adjacent
 * samples double. Its neighbours-only nature is the reason a tile alone is not enough to
 * shade itself — see `slopeDegrees` on the padded grid it expects.
 */

/** WGS-84 equatorial circumference. The Web Mercator world is exactly this wide at z0. */
const EQUATORIAL_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;

const RAD_TO_DEG = 180 / Math.PI;

/**
 * How much ground one raster pixel covers, in metres.
 *
 * Web Mercator is conformal, so at any single point the scale is the same in both axes and
 * one number answers for `dx` and `dy` alike. It is a strong function of latitude, though —
 * a z13 pixel is 19 m in Snowdonia and 9 m in Svalbard — and getting that wrong scales every
 * computed angle with it, which for a safety layer is not a rounding error.
 */
export function groundResolutionM(
  z: number,
  latDeg: number,
  tileSize: number = TERRARIUM_TILE_SIZE,
): number {
  return (EQUATORIAL_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (tileSize * 2 ** z);
}

/**
 * Latitude through the middle of a tile row.
 *
 * The scale varies across a tile as well as between tiles, but by a fraction of a percent at
 * the zooms this overlay runs at — far below the DEM's own error. The centre is the right
 * single sample; the tile's north edge would bias every tile in the same direction.
 */
export function tileCentreLatitude(y: number, z: number): number {
  return tileToLngLat(0, y + 0.5, z)[1];
}

/**
 * Per-pixel slope angle in degrees, from a grid padded by one pixel on every side.
 *
 * The padding is not an optimisation, it is the whole correctness argument. Horn's kernel
 * reads the eight neighbours of every pixel, so the outermost row and column of a tile
 * cannot be computed from that tile alone. Clamping instead — reusing the edge row as its
 * own neighbour — halves the gradient along every tile boundary, and because the bands
 * below are hard-edged that shows up as a faint one-pixel grid ruled across the whole map at
 * exactly the tile spacing. Hand this function the real neighbouring pixels and the seams do
 * not exist.
 *
 * `padded` is `(size + 2)²` values in row-major order; index `(row) * (size + 2) + col`,
 * where rows and columns `1…size` are the tile proper. Returns `size²` degrees.
 *
 * Any window touching a no-data pixel yields 0 rather than an angle computed against
 * -32768 m, which would paint the entire coastline as a vertical wall.
 */
export function slopeDegrees(
  padded: Float32Array,
  size: number,
  metresPerPixel: number,
): Float32Array {
  const stride = size + 2;
  const out = new Float32Array(size * size);
  // Horn's denominator: four samples at weight 1, two at weight 2, over two cells of run.
  const denominator = 8 * metresPerPixel;

  for (let row = 1; row <= size; row += 1) {
    const above = (row - 1) * stride;
    const here = row * stride;
    const below = (row + 1) * stride;
    const target = (row - 1) * size - 1;

    for (let col = 1; col <= size; col += 1) {
      const a = padded[above + col - 1]!;
      const b = padded[above + col]!;
      const c = padded[above + col + 1]!;
      const d = padded[here + col - 1]!;
      const f = padded[here + col + 1]!;
      const g = padded[below + col - 1]!;
      const h = padded[below + col]!;
      const i = padded[below + col + 1]!;

      if (Math.min(a, b, c, d, f, g, h, i) <= NO_DATA_ELEVATION) continue;

      const dzdx = (c + 2 * f + i - (a + 2 * d + g)) / denominator;
      const dzdy = (g + 2 * h + i - (a + 2 * b + c)) / denominator;
      out[target + col] = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy)) * RAD_TO_DEG;
    }
  }

  return out;
}

/** One step of the shading ramp. `rgba` is straight, not premultiplied. */
export interface SlopeBand {
  /** Inclusive lower bound, in degrees. */
  readonly fromDeg: number;
  readonly rgba: readonly [number, number, number, number];
}

/**
 * Paint angles into RGBA, leaving everything below the first band transparent.
 *
 * `bands` must be sorted ascending by `fromDeg`; the search hikes down from the top and
 * takes the first band the angle reaches. Ground gentler than the lowest band is not
 * coloured at all rather than coloured faintly — most of any map is gentle ground, and an
 * overlay that tints all of it is a filter over the map rather than a reading off it.
 *
 * The buffer is owned rather than shared, which is what lets a caller hand the result
 * straight to `ImageData` without a defensive copy.
 */
export function shadeSlope(
  degrees: Float32Array,
  bands: readonly SlopeBand[],
): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(degrees.length * 4);

  for (let i = 0; i < degrees.length; i += 1) {
    const angle = degrees[i]!;
    for (let b = bands.length - 1; b >= 0; b -= 1) {
      const band = bands[b]!;
      if (angle < band.fromDeg) continue;
      const p = i * 4;
      out[p] = band.rgba[0];
      out[p + 1] = band.rgba[1];
      out[p + 2] = band.rgba[2];
      out[p + 3] = band.rgba[3];
      break;
    }
  }

  return out;
}
