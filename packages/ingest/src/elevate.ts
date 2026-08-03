/**
 * Elevation tiles from AWS Terrain Tiles — the network and cache half; `@switchback/geo` owns
 * the maths. See `docs/architecture.md` for why terrarium PNGs rather than an elevation API.
 */

import { PNG } from 'pngjs';
import type { ElevationPoint, LngLat } from '@switchback/core';
import {
  NO_DATA_ELEVATION,
  TERRARIUM_ZOOM,
  cumulativeDistancesM,
  requiredTiles,
  sampleElevations,
  terrariumUrl,
  tileKey,
} from '@switchback/geo';
import type { TerrariumTile } from '@switchback/geo';

/**
 * Terrarium tiles are 64 KB decoded. 256 of them is ~16 MB, which fits a serverless function
 * and covers a whole z9 ingest tile's worth of terrain.
 */
const DEFAULT_CACHE_SIZE = 256;

export interface TerrainSourceOptions {
  urlTemplate?: string;
  cacheSize?: number;
  maxConcurrent?: number;
  maxAttempts?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<unknown>;
}

/**
 * Fetches and caches terrarium tiles. `Map` iterates in insertion order, which is all an LRU
 * needs: delete-then-set on read moves an entry to the end, and the victim is the first key.
 */
export class TerrainSource {
  private readonly urlTemplate: string | undefined;
  private readonly cacheSize: number;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<unknown>;

  private readonly cache = new Map<string, TerrariumTile | null>();
  /** In-flight requests, so 40 trails asking for one tile at once make one request. */
  private readonly inflight = new Map<string, Promise<TerrariumTile | null>>();
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: TerrainSourceOptions = {}) {
    this.urlTemplate = options.urlTemplate;
    this.cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 6);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise((r) => globalThis.setTimeout(r, ms)));
  }

  get cachedCount(): number {
    return this.cache.size;
  }

  private url(z: number, x: number, y: number): string {
    if (!this.urlTemplate) return terrariumUrl(z, x, y);
    return this.urlTemplate
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
  }

  /**
   * One tile, from cache or the network. `null` for a tile that does not exist — the bucket
   * 404s over open ocean and outside the DEM's coverage, and that is data, not an error.
   */
  async tile(z: number, x: number, y: number): Promise<TerrariumTile | null> {
    const key = tileKey(z, x, y);

    if (this.cache.has(key)) {
      const hit = this.cache.get(key)!;
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const request = this.load(z, x, y)
      .then((tile) => {
        this.remember(key, tile);
        return tile;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, request);
    return request;
  }

  private remember(key: string, tile: TerrariumTile | null): void {
    this.cache.set(key, tile);
    while (this.cache.size > this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async load(z: number, x: number, y: number): Promise<TerrariumTile | null> {
    await this.acquire();
    try {
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          const response = await this.fetchImpl(this.url(z, x, y));
          if (response.status === 404 || response.status === 403) return null;
          if (!response.ok) throw new Error(`terrain tile ${z}/${x}/${y}: ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          return decodeTerrarium(buffer, z, x, y);
        } catch (error) {
          lastError = error;
          if (attempt < this.maxAttempts) await this.sleepImpl(250 * 2 ** (attempt - 1));
        }
      }
      throw lastError instanceof Error ? lastError : new Error('terrain tile fetch failed');
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  // The slot goes straight to the next waiter rather than being freed and the waiter woken, so
  // `active` never dips below the cap between the two — see the same shape in `overpass.ts`.
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }

  /** Load every tile a coordinate list needs, keyed the way `sampleElevations` expects. */
  async tilesFor(
    coords: ReadonlyArray<readonly [number, number]>,
    z = TERRARIUM_ZOOM,
  ): Promise<Map<string, TerrariumTile>> {
    const needed = requiredTiles(coords, z);
    const loaded = new Map<string, TerrariumTile>();
    await Promise.all(
      needed.map(async (t) => {
        const tile = await this.tile(t.z, t.x, t.y);
        if (tile) loaded.set(tileKey(t.z, t.x, t.y), tile);
      }),
    );
    return loaded;
  }
}

/** Decode a terrarium PNG into the raster shape `@switchback/geo` samples. */
export function decodeTerrarium(buffer: Buffer, z: number, x: number, y: number): TerrariumTile {
  const png = PNG.sync.read(buffer);
  return {
    z,
    x,
    y,
    width: png.width,
    height: png.height,
    // pngjs always normalises to RGBA, whatever the source bit depth or colour type.
    channels: 4,
    data: png.data,
  };
}

export interface ElevateOptions {
  /** Resample interval. 25 m is what `ElevationProfile.spacingM` defaults to. */
  spacingM?: number;
  zoom?: number;
  /**
   * The true along-line length of the geometry these samples came from. **Give this whenever
   * the coordinates came out of `resampleLine`, which is always here.** Chord-to-chord
   * measurement cuts every corner between samples: negligible at 25 m spacing, 24% on the
   * Pacific Crest Trail at 725 m, which is how a thru-hike was published as 3,214 km. With the
   * length given the distances are exact by construction — `resampleLine` spaces its output
   * evenly along the source, so sample `i` of `n` is at `length·i/(n−1)`.
   */
  alongLengthM?: number;
}

export interface ElevatedProfile {
  points: ElevationPoint[];
  spacingM: number;
  /** Samples that fell in a tile we could not load, filled by interpolation. */
  gapCount: number;
}

/**
 * Build the elevation profile for a line already resampled to a fixed interval — the interval
 * is a property of the profile record and the caller records it.
 */
export async function elevateLine(
  coords: readonly LngLat[],
  source: TerrainSource,
  options: ElevateOptions = {},
): Promise<ElevatedProfile> {
  const spacingM = options.spacingM ?? 25;
  const zoom = options.zoom ?? TERRARIUM_ZOOM;

  const tiles = await source.tilesFor(coords, zoom);
  const raw = sampleElevations(coords, tiles, zoom);
  const { filled, gapCount } = fillGaps(raw);
  const distances = alongDistancesM(coords, options.alongLengthM);

  const points: ElevationPoint[] = coords.map((coord, i) => ({
    distM: distances[i]!,
    eleM: filled[i]!,
    lng: coord[0],
    lat: coord[1],
  }));

  return { points, spacingM, gapCount };
}

/**
 * Where along the trail each sample sits. The chord-to-chord fallback assumes the straight
 * lines between samples *are* the trail, which at 725 m spacing deletes every switchback in
 * between. Given the real along-line length, the answer is exact instead — see `alongLengthM`.
 */
function alongDistancesM(coords: readonly LngLat[], alongLengthM?: number): number[] {
  const n = coords.length;
  if (alongLengthM == null || !Number.isFinite(alongLengthM) || alongLengthM <= 0 || n < 2) {
    return cumulativeDistancesM(coords);
  }
  const step = alongLengthM / (n - 1);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? alongLengthM : i * step));
}

/**
 * Fill null samples by linear interpolation between their nearest known neighbours — a gap is
 * a tile that 404'd, almost always at the coast or the DEM's edge, and a null in the middle of
 * a profile array renders as a hole in the chart. Leading and trailing gaps clamp rather than
 * extrapolate. An entirely-gap profile comes back as sea level, and `gapCount` equal to the
 * sample count is how the caller detects that and declines to store the trail.
 */
export function fillGaps(raw: ReadonlyArray<number | null>): {
  filled: number[];
  gapCount: number;
} {
  const n = raw.length;
  const isKnown = (i: number): boolean => raw[i] !== null && raw[i]! > NO_DATA_ELEVATION;

  // Two linear passes rather than a search per gap: for every index, the nearest known sample
  // to its left and to its right. Both are -1 when there is none on that side.
  const prev: number[] = new Array<number>(n).fill(-1);
  const next: number[] = new Array<number>(n).fill(-1);

  let last = -1;
  for (let i = 0; i < n; i++) {
    prev[i] = isKnown(i) ? i : last;
    if (isKnown(i)) last = i;
  }

  last = -1;
  for (let i = n - 1; i >= 0; i--) {
    next[i] = isKnown(i) ? i : last;
    if (isKnown(i)) last = i;
  }

  const filled: number[] = new Array<number>(n).fill(0);
  let gapCount = 0;

  for (let i = 0; i < n; i++) {
    if (isKnown(i)) {
      filled[i] = raw[i]!;
      continue;
    }
    gapCount += 1;

    const before = prev[i]!;
    const after = next[i]!;

    if (before === -1 && after === -1) filled[i] = 0;
    else if (before === -1) filled[i] = raw[after]!;
    else if (after === -1) filled[i] = raw[before]!;
    else {
      const t = (i - before) / (after - before);
      filled[i] = raw[before]! + (raw[after]! - raw[before]!) * t;
    }
  }

  return { filled, gapCount };
}
