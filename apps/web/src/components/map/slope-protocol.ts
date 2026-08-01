'use client';

import maplibregl, { type RequestParameters } from 'maplibre-gl';
import {
  TERRARIUM_TILE_SIZE,
  decodeElevation,
  groundResolutionM,
  shadeSlope,
  slopeDegrees,
  terrariumUrl,
  tileCentreLatitude,
  tileKey,
} from '@switchback/geo';
import { SLOPE_BANDS, SLOPE_PROTOCOL } from './slope';

/**
 * The slope overlay, computed in the browser from the elevation tiles already on the wire —
 * so it costs no serverless function and survives being taken offline with the terrain tiles.
 *
 * Each output tile needs its eight neighbours as well as itself, because Horn's kernel reads
 * a pixel's neighbours and the outermost row of a tile has none inside it (see `slopeDegrees`).
 * The cache below is what keeps that closer to one fetch per tile than nine.
 */

/** `slope://{z}/{x}/{y}`, with whatever MapLibre appends left alone. */
const TILE_URL = /^slope:\/\/(\d+)\/(\d+)\/(\d+)/u;

/**
 * The 3×3 neighbourhood, row-major from the north-west, so index 4 is the tile itself and
 * `(dy + 1) * 3 + (dx + 1)` addresses any of them.
 */
const OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [0, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * Decoded elevation tiles, most-recently-used last. 64 is sized against a viewport: a
 * 1440×900 map at these zooms asks for ~30 tiles, each wanting a ring around it, so anything
 * smaller evicts a neighbour before the tile beside it borrows it. `null` is a real cached
 * value — a tile the bucket does not have is worth remembering as absent.
 */
const CACHE_LIMIT = 64;
const decoded = new Map<string, Float32Array | null>();
const inFlight = new Map<string, Promise<Float32Array | null>>();

function recall(key: string): Float32Array | null | undefined {
  if (!decoded.has(key)) return undefined;
  const tile = decoded.get(key) ?? null;
  // Re-insert to move it to the young end: Map iterates in insertion order, which is the
  // whole reason this is a Map and not an object.
  decoded.delete(key);
  decoded.set(key, tile);
  return tile;
}

function remember(key: string, tile: Float32Array | null): void {
  decoded.set(key, tile);
  while (decoded.size > CACHE_LIMIT) {
    const oldest = decoded.keys().next();
    if (oldest.done) break;
    decoded.delete(oldest.value);
  }
}

type Scratch =
  | { kind: 'offscreen'; canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D }
  | { kind: 'dom'; canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };

/**
 * A canvas to decode into and encode out of. `willReadFrequently` matters here more than
 * anywhere else in the app: without it the surface stays on the GPU and every `getImageData`
 * stalls the pipeline reading it back — over thirty tiles, a frame versus a second.
 */
function scratch(width: number, height: number): Scratch | null {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    return context ? { kind: 'offscreen', canvas, context } : null;
  }
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  return context ? { kind: 'dom', canvas, context } : null;
}

async function toPng(surface: Scratch): Promise<ArrayBuffer> {
  if (surface.kind === 'offscreen') {
    return (await surface.canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }
  const { canvas } = surface;
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, 'image/png');
  });
  if (!blob) throw new Error('Slope tile could not be encoded.');
  return blob.arrayBuffer();
}

/** One terrarium PNG, decoded to metres. Returns null for anything the bucket will not give. */
async function fetchAndDecode(z: number, x: number, y: number): Promise<Float32Array | null> {
  const response = await fetch(terrariumUrl(z, x, y));
  if (!response.ok) return null;

  // Straight from `fetch`, so the bitmap carries no origin and the canvas below never taints.
  const bitmap = await createImageBitmap(await response.blob());
  try {
    const { width, height } = bitmap;
    const surface = scratch(width, height);
    if (!surface) return null;
    surface.context.drawImage(bitmap, 0, 0);
    const { data } = surface.context.getImageData(0, 0, width, height);

    const out = new Float32Array(width * height);
    for (let i = 0; i < out.length; i += 1) {
      const p = i * 4;
      out[i] = decodeElevation(data[p]!, data[p + 1]!, data[p + 2]!);
    }
    return out;
  } finally {
    bitmap.close();
  }
}

/**
 * A decoded tile, from the cache if it is there and from S3 at most once if it is not. The
 * in-flight map is what makes the neighbourhood cheap — adjacent requests overlap by six
 * tiles. Deliberately not given the requesting tile's abort signal: a shared fetch belongs to
 * every tile waiting on it. The signal is checked later, before the expensive part.
 */
async function elevationTile(z: number, x: number, y: number): Promise<Float32Array | null> {
  const span = 2 ** z;
  // North and south of the world there is nothing to borrow; east and west there is, because
  // the antimeridian is a seam in the tile numbering and not in the ground.
  if (y < 0 || y >= span) return null;
  const wrapped = ((x % span) + span) % span;
  const key = tileKey(z, wrapped, y);

  const cached = recall(key);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(key);
  if (pending) return pending;

  const work = fetchAndDecode(z, wrapped, y)
    .catch(() => null)
    .then((tile) => {
      remember(key, tile);
      inFlight.delete(key);
      return tile;
    });
  inFlight.set(key, work);
  return work;
}

/**
 * One elevation, in tile-relative coordinates that may run one pixel outside the tile. Where
 * the neighbour is genuinely absent — the poles, or a tile S3 declined — the edge clamps to
 * itself: a faint seam at the top of the world beats a stripe of fabricated cliff.
 */
function sample(
  tiles: readonly (Float32Array | null)[],
  size: number,
  row: number,
  col: number,
): number {
  const dy = row < 0 ? -1 : row >= size ? 1 : 0;
  const dx = col < 0 ? -1 : col >= size ? 1 : 0;
  const tile = tiles[(dy + 1) * 3 + (dx + 1)];
  if (tile) return tile[(row - dy * size) * size + (col - dx * size)]!;

  const centre = tiles[4]!;
  const r = Math.min(size - 1, Math.max(0, row));
  const c = Math.min(size - 1, Math.max(0, col));
  return centre[r * size + c]!;
}

/** The `(size + 2)²` grid `slopeDegrees` expects: the tile, ringed by its neighbours' edges. */
function assemble(tiles: readonly (Float32Array | null)[], size: number): Float32Array {
  const stride = size + 2;
  const padded = new Float32Array(stride * stride);
  const centre = tiles[4]!;

  for (let row = 0; row < size; row += 1) {
    padded.set(centre.subarray(row * size, row * size + size), (row + 1) * stride + 1);
  }

  // Only the ring is filled a pixel at a time — 1,028 of the 66,564 positions.
  for (let prow = 0; prow < stride; prow += 1) {
    if (prow === 0 || prow === stride - 1) {
      for (let pcol = 0; pcol < stride; pcol += 1) {
        padded[prow * stride + pcol] = sample(tiles, size, prow - 1, pcol - 1);
      }
    } else {
      padded[prow * stride] = sample(tiles, size, prow - 1, -1);
      padded[prow * stride + stride - 1] = sample(tiles, size, prow - 1, size);
    }
  }

  return padded;
}

function aborted(): Error {
  return typeof DOMException === 'function'
    ? new DOMException('Slope tile aborted', 'AbortError')
    : Object.assign(new Error('Slope tile aborted'), { name: 'AbortError' });
}

/** A transparent tile, for ground we have no elevation for. Not an error — just no reading. */
async function blank(size: number): Promise<ArrayBuffer> {
  const surface = scratch(size, size);
  if (!surface) throw new Error('No 2D canvas available for the slope overlay.');
  return toPng(surface);
}

async function slopeTile(
  request: RequestParameters,
  abort: AbortController,
): Promise<{ data: ArrayBuffer }> {
  const match = TILE_URL.exec(request.url);
  if (!match) throw new Error(`Not a slope tile: ${request.url}`);
  const z = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);

  const neighbourhood = await Promise.all(
    OFFSETS.map(([dx, dy]) => elevationTile(z, x + dx, y + dy)),
  );

  // Checked here rather than around the fetches: by now nothing more will be requested, and
  // what remains is a few million floating-point operations worth skipping.
  if (abort.signal.aborted) throw aborted();

  const centre = neighbourhood[4];
  if (!centre) return { data: await blank(TERRARIUM_TILE_SIZE) };

  const size = Math.round(Math.sqrt(centre.length));
  const tiles = neighbourhood.map((tile) => (tile && tile.length === size * size ? tile : null));
  tiles[4] = centre;

  const metresPerPixel = groundResolutionM(z, tileCentreLatitude(y, z), size);
  const shaded = shadeSlope(slopeDegrees(assemble(tiles, size), size, metresPerPixel), SLOPE_BANDS);

  const surface = scratch(size, size);
  if (!surface) throw new Error('No 2D canvas available for the slope overlay.');
  surface.context.putImageData(new ImageData(shaded, size, size), 0, 0);
  return { data: await toPng(surface) };
}

/**
 * Teach MapLibre the `slope://` scheme. Safe to call from every map that offers the layer.
 * Registration is global and never torn down, unlike the pmtiles protocol beside it: two maps
 * can be mounted at once, and removing it on the first unmount would break the second.
 */
let registered = false;

export function registerSlopeProtocol(): void {
  if (registered || typeof window === 'undefined') return;
  registered = true;
  maplibregl.addProtocol(SLOPE_PROTOCOL, slopeTile);
}
