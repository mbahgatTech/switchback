import { NO_DATA_ELEVATION, TERRARIUM_TILE_SIZE } from './terrarium';
import { tileToLngLat } from './tiles';

/**
 * Per-pixel slope angle from a decoded DEM tile, by Horn's method (the 3×3 GIS kernel, edge
 * neighbours weighted double). Avalanche releases cluster between 35° and 45°, thinning below
 * 30° where snow will not fail and above 50° where it sluffs instead of slabbing.
 */

/** WGS-84 equatorial circumference. The Web Mercator world is exactly this wide at z0. */
const EQUATORIAL_CIRCUMFERENCE_M = 2 * Math.PI * 6378137;

const RAD_TO_DEG = 180 / Math.PI;

/**
 * Ground metres per raster pixel. Web Mercator is conformal, so one number answers for `dx` and
 * `dy` — but it is a strong function of latitude (a z13 pixel is 19 m in Snowdonia, 9 m in
 * Svalbard), and getting it wrong scales every computed angle with it.
 */
export function groundResolutionM(
  z: number,
  latDeg: number,
  tileSize: number = TERRARIUM_TILE_SIZE,
): number {
  return (EQUATORIAL_CIRCUMFERENCE_M * Math.cos((latDeg * Math.PI) / 180)) / (tileSize * 2 ** z);
}

/**
 * Latitude through the middle of a tile row. The centre is the right single sample; the north
 * edge would bias every tile in the same direction.
 */
export function tileCentreLatitude(y: number, z: number): number {
  return tileToLngLat(0, y + 0.5, z)[1];
}

/**
 * Per-pixel slope angle in degrees, from a grid padded by one pixel on every side. The padding is
 * the correctness argument, not an optimisation: Horn's kernel reads eight neighbours, so clamping
 * the edge row to itself halves the gradient along every tile boundary and rules a faint one-pixel
 * grid across the map at exactly the tile spacing.
 *
 * `padded` is `(size + 2)²` row-major values, index `row * (size + 2) + col`, where rows and
 * columns `1…size` are the tile proper. Returns `size²` degrees. Any window touching a no-data
 * pixel yields 0 rather than an angle against -32768 m, which would paint coastlines vertical.
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
 * Paint angles into RGBA, leaving everything below the first band transparent — most of any map
 * is gentle ground, and tinting all of it makes a filter over the map rather than a reading off
 * it. `bands` must be sorted ascending by `fromDeg`. The buffer is owned, so a caller can hand
 * it straight to `ImageData`.
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
