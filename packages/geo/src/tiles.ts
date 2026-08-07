import type { BBox, LngLat } from '@switchback/core';

/**
 * Slippy-map tile and quadkey maths (Web Mercator, EPSG:3857). Quadkeys are the unit of ingest
 * coverage: a z9 tile is ~78 km across, small enough that one Overpass query returns in seconds.
 *
 * @see https://learn.microsoft.com/en-us/bingmaps/articles/bing-maps-tile-system
 */

/** Zoom level at which ingest coverage is tracked. */
export const INGEST_ZOOM = 9;

/**
 * Deepest zoom a tile may be subdivided to when z9 will not fit in one invocation.
 *
 * Sixteen z11 tiles cover one z9, and each level quadruples the fixed per-tile cost — a region
 * lookup and a waypoint query that a smaller box does not make cheaper. Measured against the
 * densest tile we have (`120221203`, 6,440 elements at z9, 1,641 in its first z10 child), z10 is
 * already inside the budget and z11 is the margin rather than the expectation.
 */
export const MAX_INGEST_ZOOM = 11;

/** Refuse to cover more than this many tiles in one request — beyond it, the ask is a continent. */
export const MAX_TILES_PER_REQUEST = 12;

/** Web Mercator is undefined at the poles; this is the standard clamp. */
export const MERCATOR_MAX_LAT = 85.0511287798;

/** Length of the equator on Web Mercator's sphere — the one true distance in the projection. */
export const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/**
 * World width in pixels at zoom 0. **512, not 256**: the quadkey convention here is 256-pixel
 * tiles, but MapLibre counts a 512-pixel world, and a ground resolution against 256 is out by a
 * factor of two — one zoom level too close in every camera height and print scale derived from it.
 */
export const MERCATOR_WORLD_PX = 512;

/**
 * Metres of ground under one pixel, at a zoom and a latitude — the only bridge between a
 * renderer's "zoom 13.4" and a sheet's "1:25 000".
 */
export function groundResolution(zoom: number, latDeg: number): number {
  const latRad = (Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, latDeg)) * Math.PI) / 180;
  return (EARTH_CIRCUMFERENCE_M * Math.cos(latRad)) / (MERCATOR_WORLD_PX * 2 ** zoom);
}

/**
 * A point as a fraction of the whole Mercator world: `[0, 0]` north-west, `[1, 1]` south-east.
 * Tiles, pixels and paper millimetres are all this times a scale, so each is one multiplication
 * rather than its own copy of the logarithm.
 */
export function mercatorFraction(lng: number, lat: number): [number, number] {
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const latRad = (clampedLat * Math.PI) / 180;
  return [(lng + 180) / 360, (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2];
}

/** The inverse of `mercatorFraction`. Unclamped: a fraction outside 0–1 wraps off the world. */
export function mercatorLngLat(x: number, y: number): LngLat {
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
  return [x * 360 - 180, (latRad * 180) / Math.PI];
}

export interface Tile {
  x: number;
  y: number;
  z: number;
}

export function lngLatToTile(lng: number, lat: number, z: number): Tile {
  const n = 2 ** z;
  const [fx, fy] = mercatorFraction(lng, lat);
  return { x: clamp(Math.floor(fx * n), 0, n - 1), y: clamp(Math.floor(fy * n), 0, n - 1), z };
}

/** North-west corner of a tile. */
export function tileToLngLat(x: number, y: number, z: number): LngLat {
  const n = 2 ** z;
  return mercatorLngLat(x / n, y / n);
}

/** Geographic bounds of a tile, as [west, south, east, north]. */
export function tileToBBox(tile: Tile): BBox {
  const [w, n] = tileToLngLat(tile.x, tile.y, tile.z);
  const [e, s] = tileToLngLat(tile.x + 1, tile.y + 1, tile.z);
  return [w, s, e, n];
}

export function tileToQuadkey({ x, y, z }: Tile): string {
  let key = '';
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    key += digit;
  }
  return key;
}

export function quadkeyToTile(quadkey: string): Tile {
  let x = 0;
  let y = 0;
  const z = quadkey.length;
  for (let i = z; i > 0; i--) {
    const mask = 1 << (i - 1);
    switch (quadkey[z - i]) {
      case '0':
        break;
      case '1':
        x |= mask;
        break;
      case '2':
        y |= mask;
        break;
      case '3':
        x |= mask;
        y |= mask;
        break;
      default:
        throw new Error(`quadkeyToTile: invalid digit in "${quadkey}"`);
    }
  }
  return { x, y, z };
}

export function quadkeyToBBox(quadkey: string): BBox {
  return tileToBBox(quadkeyToTile(quadkey));
}

/**
 * The four z+1 quadkeys covering the same ground. A quadkey is a prefix code, so this is the
 * whole of the subdivision maths — no projection, no rounding, no zoom-dependent special case.
 */
export function childQuadkeys(quadkey: string): [string, string, string, string] {
  return [`${quadkey}0`, `${quadkey}1`, `${quadkey}2`, `${quadkey}3`];
}

/** The z-1 quadkey containing this one, or null at z0. */
export function parentQuadkey(quadkey: string): string | null {
  return quadkey.length > 0 ? quadkey.slice(0, -1) : null;
}

export interface CoverResult {
  quadkeys: string[];
  /** True when the bbox needed more than `maxTiles`; `quadkeys` is then empty. */
  tooLarge: boolean;
  /** How many tiles the bbox actually spans, even when refused. */
  requiredTiles: number;
}

/**
 * Cover a bounding box with quadkeys at `z`, refusing anything above `maxTiles`. Boxes crossing
 * the antimeridian (west > east) are split and covered in two passes.
 */
export function coverBBox(
  bbox: BBox,
  z: number = INGEST_ZOOM,
  maxTiles: number = MAX_TILES_PER_REQUEST,
): CoverResult {
  const [w, s, e, n] = bbox;
  const spans: Array<[number, number]> =
    w > e
      ? [
          [w, 180],
          [-180, e],
        ]
      : [[w, e]];

  let required = 0;
  const quadkeys: string[] = [];

  for (const [west, east] of spans) {
    const nw = lngLatToTile(west, n, z);
    const se = lngLatToTile(east, s, z);
    const cols = Math.abs(se.x - nw.x) + 1;
    const rows = Math.abs(se.y - nw.y) + 1;
    required += cols * rows;

    if (required > maxTiles) continue;

    for (let x = Math.min(nw.x, se.x); x <= Math.max(nw.x, se.x); x++) {
      for (let y = Math.min(nw.y, se.y); y <= Math.max(nw.y, se.y); y++) {
        quadkeys.push(tileToQuadkey({ x, y, z }));
      }
    }
  }

  if (required > maxTiles) return { quadkeys: [], tooLarge: true, requiredTiles: required };
  return { quadkeys, tooLarge: false, requiredTiles: required };
}

export interface CentreCoverResult {
  /** Nearest the centre of `bbox` first. */
  quadkeys: string[];
  /** How many tiles the box spans, before any cap. */
  requiredTiles: number;
  /** True when the box needed more than `maxTiles`, so this is the middle of it. */
  capped: boolean;
}

/**
 * Cover a bounding box at `z`, keeping the `maxTiles` tiles nearest its centre. `coverBBox`
 * refuses an oversized box because nobody asked for it — a map merely panned; this serves
 * somebody who pressed a button, so the cap is a selection rather than a rejection and what was
 * left out is reported through `requiredTiles`.
 *
 * Centre-first ordering is load-bearing: equal-priority jobs leave the queue in insertion order,
 * so this is why the middle of the screen fills before the corners.
 */
export function coverBBoxFromCentre(
  bbox: BBox,
  z: number = INGEST_ZOOM,
  maxTiles: number = MAX_TILES_PER_REQUEST,
): CentreCoverResult {
  const [w, s, e, n] = bbox;
  const world = 2 ** z;

  const nw = lngLatToTile(w, n, z);
  const se = lngLatToTile(e, s, z);

  // X runs unwrapped: a box crossing the antimeridian has west > east and its eastern edge one
  // world further along, taken modulo the world on the way out. Without this a Pacific viewport
  // covers the whole land mass between Kamchatka and Alaska rather than the two ends.
  const x0 = nw.x;
  const x1 = se.x >= nw.x ? se.x : se.x + world;
  const y0 = Math.min(nw.y, se.y);
  const y1 = Math.max(nw.y, se.y);

  const cols = Math.min(x1 - x0 + 1, world);
  const rows = y1 - y0 + 1;
  const requiredTiles = cols * rows;

  const cx = x0 + (cols - 1) / 2;
  const cy = y0 + (rows - 1) / 2;

  // Search radius is bounded by the cap, not the box: a world view spans 262,144 tiles at z9 and
  // enumerating them to keep ninety-six is what breaks when somebody zooms out on a phone.
  // √maxTiles covers the square case (the nearest m tiles fill a disc of radius ≈0.56·√m), so
  // each axis also allows for the other being clipped short by a long thin box.
  const reach = Math.ceil(Math.sqrt(maxTiles));
  const reachX = Math.max(reach, Math.ceil(maxTiles / Math.min(rows, 2 * reach + 1)));
  const reachY = Math.max(reach, Math.ceil(maxTiles / Math.min(cols, 2 * reach + 1)));

  const wx0 = Math.max(x0, Math.round(cx) - reachX);
  const wx1 = Math.min(x0 + cols - 1, Math.round(cx) + reachX);
  const wy0 = Math.max(y0, Math.round(cy) - reachY);
  const wy1 = Math.min(y1, Math.round(cy) + reachY);

  const candidates: Array<{ x: number; y: number; d: number }> = [];
  for (let x = wx0; x <= wx1; x++) {
    for (let y = wy0; y <= wy1; y++) {
      candidates.push({ x, y, d: (x - cx) ** 2 + (y - cy) ** 2 });
    }
  }

  // Ties broken on x then y so the same box always produces the same order.
  candidates.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);

  const quadkeys = candidates
    .slice(0, maxTiles)
    .map(({ x, y }) => tileToQuadkey({ x: ((x % world) + world) % world, y, z }));

  return { quadkeys, requiredTiles, capped: requiredTiles > maxTiles };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
