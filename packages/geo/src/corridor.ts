import type { LineString } from '@switchback/core';
import { MERCATOR_MAX_LAT, type Tile } from './tiles';

/**
 * Which map tiles a trail actually needs, for downloading it.
 *
 * The obvious answer is "every tile in the trail's bounding box", and it is wrong in a way
 * that gets worse the more interesting the trail is. A bounding box is a rectangle; a trail
 * is a line. The Pennine Way's box contains most of northern England, of which the hiker
 * will see a strip a few hundred metres wide. At z15 that box is on the order of a hundred
 * thousand tiles against a corridor of a few thousand — the difference between a download
 * that is refused and one that finishes over a café's wifi.
 *
 * So this hikes the line and takes the tiles it passes through, then dilates that set by a
 * ring of neighbours. The ring is what makes it usable rather than merely correct: a
 * corridor exactly one tile wide shows the trail pinned to the edge of the world with
 * nothing either side of it, and "what is that valley over there" is a question people ask
 * on ridges.
 *
 * Everything here is integer tile arithmetic on a Web Mercator pyramid, so it is shared
 * verbatim by the terrain tiles that draw the hillshade, the vector tiles that draw the
 * names, and any raster base a deployment adds later.
 */

/** Tiles either side of the line, at every zoom. One ring is about a screen's worth at z14. */
const DEFAULT_RING = 1;

/**
 * Refuse past this many tiles in one download.
 *
 * At roughly 12 kB a vector tile and 60 kB a terrain tile, 8,000 is on the order of 200 MB
 * for a full corridor — already beyond what anyone should hand a phone without being asked.
 * The cap is not a guess at what the device can hold; it is the point past which the honest
 * answer is "this is a thru-hike, download it in sections".
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
 * Where a coordinate falls on the tile grid, as a fraction rather than a tile index.
 *
 * Kept local rather than borrowed from `terrarium.ts`, which returns a tile plus a pixel
 * offset in a fixed 256 px tile — a raster idea. Fractional tile units are the right
 * currency for hiking a line across a grid, and they are the same at any tile size.
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
 * Tiles touched by the line at one zoom, before dilation.
 *
 * Segments are sampled rather than rasterised with a DDA, at a spacing of half a tile in
 * the dominant axis. Two consecutive samples are then under half a tile apart on *both*
 * axes, so no tile between them can be stepped over — which is the only property a DDA
 * would buy here, at more code. The ring dilation that follows makes the distinction
 * academic anyway.
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
 * The tile corridor for a route.
 *
 * Zooms are added coarsest first and the whole of a zoom is either taken or dropped. That
 * ordering is deliberate: a download cut off part-way through z15 leaves a map that is
 * sharp for the first third of the hike and blank for the rest, which is worse than useless
 * because it looks like it worked. Dropping the deepest zoom instead leaves a map that is
 * complete and slightly soft — the failure mode of every paper map ever folded into a
 * pocket, and one every hiker already knows how to read.
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

  /*
   * The coarsest zoom always goes in, even alone and even over the cap. A corridor at z10
   * is a few tiles for any trail on earth, and a downloaded trail that renders as a grey
   * void is not a smaller download — it is a broken one.
   */
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
 * Fill a `{z}/{x}/{y}` template.
 *
 * `{-y}` is understood as well, because TMS-ordered sources exist and getting the flip
 * wrong shows up as a map of somewhere else entirely rather than as an error.
 */
export function tileUrl(template: string, tile: Tile): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y))
    .replace('{-y}', String(2 ** tile.z - 1 - tile.y));
}
