import type { LineString } from '@switchback/core';
import { MERCATOR_MAX_LAT, type Tile } from './tiles';

/**
 * Which map tiles a trail needs for offline download: the tiles its line passes through, dilated
 * by a ring of neighbours. A bounding box is the wrong shape — the Pennine Way's box is most of
 * northern England, ~100k tiles at z15 against a few thousand for the corridor.
 */

/** Tiles either side of the line, at every zoom. One ring is about a screen's worth at z14. */
const DEFAULT_RING = 1;

/**
 * Refuse past this many tiles in one download — at ~12 kB a vector tile and 60 kB a terrain
 * tile, 8,000 is around 200 MB, the point past which the answer is "download it in sections".
 */
export const MAX_CORRIDOR_TILES = 8_000;

export interface CorridorOptions {
  minZoom: number;
  maxZoom: number;
  /** Rings of neighbouring tiles added around the line. Defaults to 1. */
  ring?: number;
  /** Stop before exceeding this many tiles. Defaults to {@link MAX_CORRIDOR_TILES}. */
  cap?: number;
}

export interface CorridorResult {
  tiles: Tile[];
  /** The deepest zoom that fitted under the cap. Equals `maxZoom` when nothing was dropped. */
  coveredMaxZoom: number;
  /** True when at least one requested zoom was dropped to stay under the cap. */
  truncated: boolean;
}

/**
 * Where a coordinate falls on the tile grid, in fractional tile units. Local rather than
 * `terrarium.ts`'s tile-plus-pixel-offset, which assumes a fixed 256 px raster tile.
 */
function fractionalTile(lng: number, lat: number, z: number): { x: number; y: number } {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const n = 2 ** z;
  const latRad = (clamped * Math.PI) / 180;
  return {
    x: ((lng + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  };
}

/** East–west wraps at the antimeridian; north–south does not. */
function normalise(x: number, y: number, z: number): { x: number; y: number } {
  const n = 2 ** z;
  return { x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y)) };
}

/**
 * Tiles touched by the line at one zoom, before dilation. Sampled at half a tile in the dominant
 * axis rather than rasterised with a DDA: consecutive samples are then under half a tile apart on
 * both axes, so no tile between them is stepped over.
 */
function touchedAtZoom(coords: LineString['coordinates'], z: number, into: Set<string>): void {
  const first = coords[0];
  if (!first) return;

  let previous = fractionalTile(first[0], first[1], z);
  const start = normalise(Math.floor(previous.x), Math.floor(previous.y), z);
  into.add(`${start.x}/${start.y}`);

  for (let i = 1; i < coords.length; i++) {
    const point = coords[i];
    if (!point) continue;
    const current = fractionalTile(point[0], point[1], z);

    const dx = current.x - previous.x;
    const dy = current.y - previous.y;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) * 2));

    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const tile = normalise(Math.floor(previous.x + dx * t), Math.floor(previous.y + dy * t), z);
      into.add(`${tile.x}/${tile.y}`);
    }

    previous = current;
  }
}

function dilate(keys: Set<string>, z: number, ring: number): Set<string> {
  if (ring <= 0) return keys;
  const grown = new Set<string>();
  for (const key of keys) {
    const [xs, ys] = key.split('/');
    const x = Number(xs);
    const y = Number(ys);
    for (let ox = -ring; ox <= ring; ox++) {
      for (let oy = -ring; oy <= ring; oy++) {
        const tile = normalise(x + ox, y + oy, z);
        grown.add(`${tile.x}/${tile.y}`);
      }
    }
  }
  return grown;
}

/**
 * The tile corridor for a route. Zooms are added coarsest first and a zoom is taken whole or
 * dropped whole: a download cut off mid-z15 is sharp for the first third of the hike and blank
 * for the rest, which looks like it worked. Dropping the deepest zoom leaves a complete, soft map.
 */
export function tileCorridor(line: LineString, options: CorridorOptions): CorridorResult {
  const ring = options.ring ?? DEFAULT_RING;
  const cap = options.cap ?? MAX_CORRIDOR_TILES;
  const minZoom = Math.max(0, Math.floor(options.minZoom));
  const maxZoom = Math.max(minZoom, Math.floor(options.maxZoom));

  const tiles: Tile[] = [];
  let coveredMaxZoom = minZoom - 1;
  let truncated = false;

  for (let z = minZoom; z <= maxZoom; z++) {
    const touched = new Set<string>();
    touchedAtZoom(line.coordinates, z, touched);
    const grown = dilate(touched, z, ring);

    if (tiles.length + grown.size > cap) {
      truncated = true;
      break;
    }

    for (const key of grown) {
      const [xs, ys] = key.split('/');
      tiles.push({ x: Number(xs), y: Number(ys), z });
    }
    coveredMaxZoom = z;
  }

  // The coarsest zoom always goes in, even alone and even over the cap: a downloaded trail that
  // renders as a grey void is not a smaller download, it is a broken one.
  if (tiles.length === 0) {
    const touched = new Set<string>();
    touchedAtZoom(line.coordinates, minZoom, touched);
    for (const key of dilate(touched, minZoom, ring)) {
      const [xs, ys] = key.split('/');
      tiles.push({ x: Number(xs), y: Number(ys), z: minZoom });
    }
    coveredMaxZoom = minZoom;
  }

  return { tiles, coveredMaxZoom, truncated };
}

/**
 * Fill a `{z}/{x}/{y}` template. `{-y}` is understood too, because TMS-ordered sources exist and
 * getting the flip wrong renders somewhere else entirely rather than erroring.
 */
export function tileUrl(template: string, tile: Tile): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
    .replace('{-y}', String(2 ** tile.z - 1 - tile.y));
}
