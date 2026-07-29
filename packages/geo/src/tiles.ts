import type { BBox, LngLat } from '@switchback/core';

/**
 * Slippy-map tile and quadkey maths (Web Mercator, EPSG:3857).
 *
 * Quadkeys are the unit of ingest coverage: the map viewport is covered with z9
 * quadkeys, each of which is either already cached or gets queued for fetching from
 * OSM. A z9 tile is roughly 78 km across at the equator — large enough that a typical
 * viewport needs only a handful, small enough that one Overpass query for it returns
 * in seconds rather than timing out.
 *
 * @see https://learn.microsoft.com/en-us/bingmaps/articles/bing-maps-tile-system
 */

/** Zoom level at which ingest coverage is tracked. */
export const INGEST_ZOOM = 9;

/**
 * Refuse to cover more than this many tiles in one request. Beyond it the user is
 * asking for a continent, and the honest answer is "zoom in" rather than queuing
 * hundreds of Overpass queries that will be rate-limited into next week.
 */
export const MAX_TILES_PER_REQUEST = 12;

/** Web Mercator is undefined at the poles; this is the standard clamp. */
export const MERCATOR_MAX_LAT = 85.0511287798;

/**
 * Length of the equator on the sphere Web Mercator is drawn on, metres.
 *
 * The one distance in the projection that is true, and therefore the one every other
 * distance is derived from: at latitude φ the projection stretches ground by 1/cos φ, so a
 * metre of paper at 60° buys half the ground a metre at the equator does.
 */
export const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/**
 * How many pixels the whole world is across at zoom 0.
 *
 * **512, not 256.** The slippy-map convention this file's quadkey maths comes from is a
 * 256-pixel tile, but MapLibre — the only renderer here that turns a zoom into a distance —
 * counts a 512-pixel world. A ground resolution computed against 256 is out by a factor of
 * two, which reads as a zoom exactly one level too close, and every camera height and print
 * scale derived from it is half what it should be.
 */
export const MERCATOR_WORLD_PX = 512;

/**
 * Metres of ground under one pixel, at a zoom and a latitude.
 *
 * The bridge between the two ways this product talks about scale: a renderer says "zoom
 * 13.4" and a map sheet says "1:25 000", and this is the only thing that converts one to
 * the other. Exported rather than kept private because three callers now need it — the
 * flyover camera, the printed sheet, and the scale bar drawn on both.
 */
export function groundResolution(zoom: number, latDeg: number): number {
  const latRad = (Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, latDeg)) * Math.PI) / 180;
  return (EARTH_CIRCUMFERENCE_M * Math.cos(latRad)) / (MERCATOR_WORLD_PX * 2 ** zoom);
}

/**
 * A point as a fraction of the whole Mercator world: `[0, 0]` north-west, `[1, 1]` south-east.
 *
 * The unit everything else in the projection is a scaling of — tiles are this times `2^z`,
 * pixels are this times the world width in pixels, and millimetres of paper are this times
 * the world width in millimetres. Working in fractions first means each of those is one
 * multiplication rather than its own copy of the logarithm.
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

export interface CoverResult {
  quadkeys: string[];
  /** True when the bbox needed more than `maxTiles`; `quadkeys` is then empty. */
  tooLarge: boolean;
  /** How many tiles the bbox actually spans, even when refused. */
  requiredTiles: number;
}

/**
 * Cover a bounding box with quadkeys at `z`, refusing anything above `maxTiles`.
 *
 * Antimeridian-crossing boxes (west > east) are split and covered in two passes,
 * because a viewport over the Pacific is a real thing users produce by dragging.
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
 * Cover a bounding box at `z`, keeping the `maxTiles` tiles nearest its centre.
 *
 * The difference from `coverBBox` is what happens when the box is too big, and it turns on
 * who is asking. `coverBBox` answers the automatic path — a map that merely panned — and
 * refusing there is right: nobody asked to fetch a continent, and queueing three hundred
 * Overpass queries because a viewport got wide would be a product that punishes zooming out.
 *
 * This answers somebody who pressed a button. Refusing them is not an option, and neither is
 * fetching everything, so the cap becomes a *selection* rather than a rejection: the tiles
 * closest to the middle of the view, which is the ground the person is looking at. What was
 * left out is reported through `requiredTiles` so the caller can say so out loud.
 *
 * Ordering is load-bearing, not cosmetic. Queueing hikes this array and jobs of equal
 * priority come off the queue in the order they went on, so centre-first here is why the
 * middle of the screen fills before the corners.
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

  /*
   * X runs unwrapped. A box crossing the antimeridian has west > east, and its eastern edge
   * is one world *further along* rather than behind; tiles are taken modulo the world on the
   * way out. That is what makes a viewport over the Pacific cover Kamchatka and Alaska
   * instead of the entire land mass between them.
   */
  const x0 = nw.x;
  const x1 = se.x >= nw.x ? se.x : se.x + world;
  const y0 = Math.min(nw.y, se.y);
  const y1 = Math.max(nw.y, se.y);

  const cols = Math.min(x1 - x0 + 1, world);
  const rows = y1 - y0 + 1;
  const requiredTiles = cols * rows;

  const cx = x0 + (cols - 1) / 2;
  const cy = y0 + (rows - 1) / 2;

  /*
   * How far from the centre to look.
   *
   * Bounded by the cap rather than by the box, because only tiles near the centre can make
   * the cut and a world view spans 262,144 of them at z9. Enumerating a quarter of a million
   * tiles to sort them and throw away all but ninety-six is the kind of thing that works fine
   * until somebody zooms out on a phone.
   *
   * `√maxTiles` covers the square case with room to spare — the nearest m tiles fill a disc
   * of radius ≈0.56·√m — but a box one tile tall and four hundred wide has its nearest m in a
   * *strip*, and a reach of ten would clip it to twenty-one. So each axis also allows for the
   * other one being clipped short by the box.
   */
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

  // Ties broken on x then y so the same box always produces the same order — the queue is
  // deduped by quadkey, and a set that reshuffles between calls would be harder to reason
  // about for no gain.
  candidates.sort((a, b) => a.d - b.d || a.x - b.x || a.y - b.y);

  const quadkeys = candidates
    .slice(0, maxTiles)
    .map(({ x, y }) => tileToQuadkey({ x: ((x % world) + world) % world, y, z }));

  return { quadkeys, requiredTiles, capped: requiredTiles > maxTiles };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
