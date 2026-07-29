/**
 * Terrarium terrain-tile elevation decoding.
 *
 * Elevation comes from AWS's public Terrain Tiles (Mapzen/Tilezen `terrarium` format)
 * rather than a hosted elevation API. The reason is rate limits: a hosted elevation
 * endpoint caps at a few thousand calls a day, and a single 20 km trail resampled at
 * 25 m is 800 points. Terrain tiles are plain PNGs on S3 with no quota, and one z13
 * tile answers hundreds of samples at once.
 *
 * The encoding packs metres into RGB with a 32768 m offset so below-sea-level terrain
 * survives:
 *
 *     elevation_m = (R * 256 + G + B / 256) - 32768
 *
 * @see https://github.com/tilezen/joerd/blob/master/docs/formats.md
 */

import { MERCATOR_MAX_LAT } from './tiles';

export const TERRARIUM_TILE_SIZE = 256;
/** z13 gives ~10–20 m ground resolution at mid latitudes — enough for trail grade. */
export const TERRARIUM_ZOOM = 13;
export const TERRARIUM_URL_TEMPLATE =
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';

/** Sentinel returned by the decoder for ocean/no-data pixels. */
export const NO_DATA_ELEVATION = -32768;

export function decodeElevation(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Decoded RGB(A) raster for one tile. `channels` is 3 for RGB, 4 for RGBA. */
export interface TerrariumTile {
  z: number;
  x: number;
  y: number;
  width: number;
  height: number;
  channels: 3 | 4;
  data: Uint8Array | Uint8ClampedArray;
}

export interface TilePixel {
  x: number;
  y: number;
  z: number;
  /** Sub-pixel position within the tile, in pixels. */
  px: number;
  py: number;
}

/** Which tile, and where inside it, a coordinate falls at a given zoom. */
export function pixelForLngLat(
  lng: number,
  lat: number,
  z: number,
  tileSize = TERRARIUM_TILE_SIZE,
): TilePixel {
  const clampedLat = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const scale = 2 ** z * tileSize;
  const worldX = ((lng + 180) / 360) * scale;
  const latRad = (clampedLat * Math.PI) / 180;
  const worldY = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * scale;

  const tx = Math.floor(worldX / tileSize);
  const ty = Math.floor(worldY / tileSize);
  return { x: tx, y: ty, z, px: worldX - tx * tileSize, py: worldY - ty * tileSize };
}

function elevationAtPixel(tile: TerrariumTile, px: number, py: number): number {
  const x = Math.max(0, Math.min(tile.width - 1, px));
  const y = Math.max(0, Math.min(tile.height - 1, py));
  const i = (y * tile.width + x) * tile.channels;
  return decodeElevation(tile.data[i]!, tile.data[i + 1]!, tile.data[i + 2]!);
}

/**
 * Bilinearly interpolated elevation at a sub-pixel position.
 *
 * Nearest-neighbour sampling produces a visible staircase in the elevation profile
 * and, worse, inflates computed gain — each step across a pixel boundary registers as
 * a real climb. Interpolating removes both artefacts.
 *
 * Samples that touch a no-data pixel fall back to nearest-neighbour rather than
 * blending -32768 into the result, which would otherwise drag a coastal trail's
 * elevation to nonsense.
 */
export function sampleTileBilinear(tile: TerrariumTile, px: number, py: number): number {
  const x0 = Math.floor(px - 0.5);
  const y0 = Math.floor(py - 0.5);
  const fx = px - 0.5 - x0;
  const fy = py - 0.5 - y0;

  const q11 = elevationAtPixel(tile, x0, y0);
  const q21 = elevationAtPixel(tile, x0 + 1, y0);
  const q12 = elevationAtPixel(tile, x0, y0 + 1);
  const q22 = elevationAtPixel(tile, x0 + 1, y0 + 1);

  if (
    q11 <= NO_DATA_ELEVATION ||
    q21 <= NO_DATA_ELEVATION ||
    q12 <= NO_DATA_ELEVATION ||
    q22 <= NO_DATA_ELEVATION
  ) {
    return elevationAtPixel(tile, Math.round(px), Math.round(py));
  }

  const top = q11 * (1 - fx) + q21 * fx;
  const bottom = q12 * (1 - fx) + q22 * fx;
  return top * (1 - fy) + bottom * fy;
}

export function tileKey(z: number, x: number, y: number): string {
  return `${z}/${x}/${y}`;
}

export function terrariumUrl(z: number, x: number, y: number): string {
  return TERRARIUM_URL_TEMPLATE.replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/**
 * Sample many coordinates against an already-loaded tile set, keyed by `tileKey`.
 * Separating the sampling from the fetching keeps this module pure and testable;
 * `@switchback/ingest` owns the network and the cache.
 *
 * Returns `null` for coordinates whose tile is missing, so the caller can decide
 * between refetching and interpolating across the gap.
 */
export function sampleElevations(
  coords: ReadonlyArray<readonly [number, number]>,
  tiles: ReadonlyMap<string, TerrariumTile>,
  z = TERRARIUM_ZOOM,
): Array<number | null> {
  return coords.map(([lng, lat]) => {
    const p = pixelForLngLat(lng, lat, z);
    const tile = tiles.get(tileKey(p.z, p.x, p.y));
    if (!tile) return null;
    const ele = sampleTileBilinear(tile, p.px, p.py);
    return ele <= NO_DATA_ELEVATION ? null : ele;
  });
}

/** Which terrarium tiles a coordinate list needs. Feeds the fetch queue. */
export function requiredTiles(
  coords: ReadonlyArray<readonly [number, number]>,
  z = TERRARIUM_ZOOM,
): Array<{ z: number; x: number; y: number }> {
  const seen = new Set<string>();
  const out: Array<{ z: number; x: number; y: number }> = [];
  for (const [lng, lat] of coords) {
    const p = pixelForLngLat(lng, lat, z);
    const key = tileKey(p.z, p.x, p.y);
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ z: p.z, x: p.x, y: p.y });
    }
  }
  return out;
}
