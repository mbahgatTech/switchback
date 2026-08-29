/**
 * Elevation tiles from AWS Terrain Tiles — the network and cache half; `@switchback/geo` owns
 * the maths. See `docs/architecture.md` for why terrarium PNGs rather than an elevation API.
 */

import { PNG } from 'pngjs';
import type { ElevationPoint, LngLat } from '@switchback/core';
import { IngestDeadlineError, assertBefore, requestBudgetMs } from './deadline';
import type { TerrainCache } from './terrain-cache';
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

/**
 * Per-request ceiling on one terrarium tile. A tile is ~64 KB from a CDN; twenty seconds is a
 * dead connection, not a slow one. Without it a stalled socket has no timeout at all — Node's
 * `fetch` does not impose one — which is how an invocation outran the host's ten minutes.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

/**
 * What one origin request produced. `absent` is a 404 and is data — the DEM does not cover this
 * tile. `denied` is a 403, which says nothing about terrain and must never reach the cache.
 */
type OriginTerrain =
  { kind: 'tile'; body: Buffer; tile: TerrariumTile } | { kind: 'absent' } | { kind: 'denied' };

export interface TerrainSourceOptions {
  urlTemplate?: string;
  cacheSize?: number;
  maxConcurrent?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<unknown>;
  /**
   * Shared tier behind the in-process LRU, outliving the invocation. Absent is the default and
   * leaves every tile coming from the origin, which is what the estate did before it existed.
   */
  cache?: TerrainCache;
}

/**
 * Fetches and caches terrarium tiles. `Map` iterates in insertion order, which is all an LRU
 * needs: delete-then-set on read moves an entry to the end, and the victim is the first key.
 *
 * Two tiers, and they are not interchangeable. The LRU is free and covers one z9 tile's terrain;
 * the shared tier is a network round trip that survives the invocation and is what makes a retry,
 * a subdivided child or a cold start cheap. See `terrain-cache.ts`.
 */
export class TerrainSource {
  private readonly urlTemplate: string | undefined;
  private readonly cacheSize: number;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<unknown>;
  private readonly shared: TerrainCache | undefined;

  private readonly cache = new Map<string, TerrariumTile | null>();
  /** In-flight requests, so 40 trails asking for one tile at once make one request. */
  private readonly inflight = new Map<string, Promise<TerrariumTile | null>>();
  /** Unawaited write-backs, held only so `flushWrites` can settle them. */
  private readonly writes = new Set<Promise<void>>();
  private sharedHits = 0;
  private sharedMisses = 0;
  private sharedOutages = 0;
  private sharedCorrupt = 0;
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: TerrainSourceOptions = {}) {
    this.urlTemplate = options.urlTemplate;
    this.cacheSize = options.cacheSize ?? DEFAULT_CACHE_SIZE;
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 6);
    this.maxAttempts = options.maxAttempts ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise((r) => globalThis.setTimeout(r, ms)));
    this.shared = options.cache;
  }

  get cachedCount(): number {
    return this.cache.size;
  }

  /**
   * Shared-tier outcomes since construction. `unavailable` and `corrupt` are counted apart from
   * `misses` deliberately: folding either into the miss rate reports a healthy cache during an
   * outage, or during the one failure that does not heal on its own.
   */
  get sharedCacheStats(): {
    hits: number;
    misses: number;
    unavailable: number;
    corrupt: number;
  } {
    return {
      hits: this.sharedHits,
      misses: this.sharedMisses,
      unavailable: this.sharedOutages,
      corrupt: this.sharedCorrupt,
    };
  }

  /**
   * Settle the write-backs the pipeline deliberately does not await. The benchmark and the test
   * suite need them landed before they measure; production has nothing to wait for.
   */
  async flushWrites(): Promise<void> {
    await Promise.all([...this.writes]);
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
   *
   * `deadlineAt` is the invocation's wall clock, not this request's: past it, `load` throws
   * rather than starting or continuing. A cache hit is always served, deadline or not — it
   * costs nothing and refusing it would fail a trail the source could already answer for.
   */
  async tile(z: number, x: number, y: number, deadlineAt?: number): Promise<TerrariumTile | null> {
    const key = tileKey(z, x, y);

    if (this.cache.has(key)) {
      const hit = this.cache.get(key)!;
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }

    const existing = this.inflight.get(key);
    if (existing) return existing;

    const request = this.load(z, x, y, deadlineAt)
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

  private async load(
    z: number,
    x: number,
    y: number,
    deadlineAt?: number,
  ): Promise<TerrariumTile | null> {
    // A shared lookup is a network round trip, so the deadline gates it exactly as it gates the
    // origin. The always-serve rule belongs to the in-process cache above, where a hit is free.
    assertBefore(deadlineAt, 'terrain');

    const shared = await this.readShared(z, x, y, deadlineAt);
    if (shared) return shared.tile;

    const origin = await this.fetchOrigin(z, x, y, deadlineAt);
    if (origin.kind === 'absent') {
      this.writeBack(z, x, y, null);
      return null;
    }
    // A 403 is an answer about access, not about terrain. It reads as a gap here exactly as it
    // did before this tier existed, but storing it would write the no-tile marker — and since
    // nothing expires a key, one misconfigured mirror would turn a region into permanent ocean
    // for every process that reads the bucket afterwards.
    if (origin.kind === 'denied') return null;

    this.writeBack(z, x, y, origin.body);
    return origin.tile;
  }

  /**
   * What the shared tier knows, boxed so a tile the origin does not have stays distinguishable
   * from the tier having no answer. `null` means go to the origin.
   */
  private async readShared(
    z: number,
    x: number,
    y: number,
    deadlineAt?: number,
  ): Promise<{ tile: TerrariumTile | null } | null> {
    if (!this.shared) return null;

    const found = await this.shared.read(z, x, y, deadlineAt);
    if (found.kind === 'absent') {
      this.sharedHits += 1;
      return { tile: null };
    }
    if (found.kind === 'tile') {
      try {
        const tile = decodeTerrarium(found.body, z, x, y);
        this.sharedHits += 1;
        return { tile };
      } catch {
        // An object that will not decode is a corrupt cache entry, not a corrupt DEM. Going to
        // the origin re-fetches it, and the write-back replaces what was stored.
        this.sharedCorrupt += 1;
        return null;
      }
    }
    if (found.kind === 'unavailable') this.sharedOutages += 1;
    else this.sharedMisses += 1;
    return null;
  }

  /**
   * Unawaited on purpose: a cache write is not part of anyone's answer, and making the pipeline
   * wait for one would spend the deadline this tier exists to save.
   */
  private writeBack(z: number, x: number, y: number, body: Buffer | null): void {
    if (!this.shared) return;
    const write = this.shared.write(z, x, y, body);
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write));
  }

  /**
   * What the origin said, kept apart rather than collapsed to `null`. Only a 404 is evidence
   * that the DEM has no tile here; a 403 is evidence about the request.
   */
  private async fetchOrigin(
    z: number,
    x: number,
    y: number,
    deadlineAt?: number,
  ): Promise<OriginTerrain> {
    // Before the queue, not after: waiting for a slot is time too, and a caller that has
    // already run out of clock should not take one from a caller that has not.
    assertBefore(deadlineAt, 'terrain');
    await this.acquire();
    try {
      assertBefore(deadlineAt, 'terrain');
      let lastError: unknown;
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        try {
          const response = await this.fetchImpl(this.url(z, x, y), {
            signal: AbortSignal.timeout(requestBudgetMs(this.requestTimeoutMs, deadlineAt)),
          });
          if (response.status === 404) return { kind: 'absent' };
          if (response.status === 403) return { kind: 'denied' };
          if (!response.ok) throw new Error(`terrain tile ${z}/${x}/${y}: ${response.status}`);
          // Decoded here, inside the attempt, for two reasons: a truncated body is transient and
          // retrying it is the right answer, and nothing may be handed to the cache until it has
          // been proved to be a tile — the store's empty-object marker makes a bad write eternal.
          const body = Buffer.from(await response.arrayBuffer());
          return { kind: 'tile', body, tile: decodeTerrarium(body, z, x, y) };
        } catch (error) {
          // A deadline is not a transient fault and retrying it cannot help — the next
          // attempt would fail the same assertion, three backoffs later.
          if (error instanceof IngestDeadlineError) throw error;
          lastError = error;
          if (attempt < this.maxAttempts) {
            await this.sleepImpl(250 * 2 ** (attempt - 1));
            assertBefore(deadlineAt, 'terrain');
          }
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
    deadlineAt?: number,
  ): Promise<Map<string, TerrariumTile>> {
    const needed = requiredTiles(coords, z);
    const loaded = new Map<string, TerrariumTile>();
    await Promise.all(
      needed.map(async (t) => {
        const tile = await this.tile(t.z, t.x, t.y, deadlineAt);
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
  /** The invocation's wall clock, passed to the terrain source — see `TerrainSource.tile`. */
  deadlineAt?: number;
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

  const tiles = await source.tilesFor(coords, zoom, options.deadlineAt);
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
