/**
 * Taking a trail with you. The unit of download is a server-rendered *page*, plus the tiles its map
 * will ask for and its photographs — so the offline page is the one you pressed the button on.
 */

import { MAX_CORRIDOR_TILES, TERRARIUM_URL_TEMPLATE, tileCorridor, tileUrl } from '@switchback/geo';
import type { CorridorResult } from '@switchback/geo';
import type { TrailDetail } from '@switchback/core';
import { glyphsUrl, openMapTilesUrl } from '../components/map/basemap';
import { ASSET_CACHE, MEDIA_CACHE, PAGE_CACHE, staticAssets, TILE_CACHE } from './caches';
import { putOfflineTrail, type OfflineTrail } from './store';

/**
 * The zoom range a downloaded trail is usable at. Above z15 the vector source has no more detail —
 * OpenMapTiles builds stop at z14 — so the extra tiles would be terrain only, at four times the count.
 */
export const OFFLINE_MIN_ZOOM = 10;
export const OFFLINE_MAX_ZOOM = 15;

/** Vector tiles exist only to z14; MapLibre overzooms past that from the z14 tile. */
const VECTOR_MAX_ZOOM = 14;

/** The browser's own per-host connection limit — more just queues elsewhere and slows aborting. */
const CONCURRENCY = 6;

/**
 * Latin, its supplement, and Latin Extended-A and B. Glyph ranges are 30-60 kB apiece; the map
 * falls back to unlabelled features for a range it has not got, which degrades honestly.
 */
const GLYPH_RANGES = ['0-255', '256-511', '512-767'] as const;

/** The one fontstack every symbol layer in this product asks for. */
const FONTSTACK = 'Noto Sans Regular';

export type DownloadPhase = 'planning' | 'page' | 'tiles' | 'media' | 'saving';

export interface DownloadProgress {
  phase: DownloadPhase;
  /** Items stored so far, across every phase. */
  done: number;
  total: number;
  /** Bytes actually written, measured rather than estimated. */
  bytes: number;
}

export interface DownloadOptions {
  /** Photograph URLs to keep. The gallery's first page — enough to recognise the place. */
  photoUrls?: readonly string[];
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

export class DownloadTooLargeError extends Error {
  constructor(readonly tiles: number) {
    super(
      `This route needs about ${tiles.toLocaleString()} map tiles, past the ${MAX_CORRIDOR_TILES.toLocaleString()} limit for one download. Long-distance routes are best taken in sections.`,
    );
    this.name = 'DownloadTooLargeError';
  }
}

/**
 * The vector tile template, read from the source's TileJSON at download time. OpenFreeMap bakes a
 * build stamp into the tile path, so a hard-coded template caches URLs the map will never ask for.
 */
async function vectorTemplate(tileJsonUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(tileJsonUrl, signal ? { signal } : undefined);
    if (!response.ok) return null;
    const body = (await response.json()) as { tiles?: readonly unknown[] } | null;
    const first: unknown = body?.tiles?.[0];
    // The `{z}` test is what makes this a template rather than one file's URL.
    return typeof first === 'string' && first.includes('{z}') ? first : null;
  } catch {
    return null;
  }
}

/**
 * Stores one URL and reports what it cost. The body is read into memory before going back into a
 * `Response` so the size is exact: `content-length` is absent when chunked and wrong when compressed.
 */
async function store(cache: Cache, url: string, signal?: AbortSignal): Promise<number> {
  const response = await fetch(url, {
    // Tiles and photographs are public; credentials to a third-party tile host are a privacy leak.
    credentials: url.startsWith('/') || url.startsWith(location.origin) ? 'same-origin' : 'omit',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);

  const body = await response.arrayBuffer();
  await cache.put(
    url,
    new Response(body, { status: 200, statusText: 'OK', headers: response.headers }),
  );
  return body.byteLength;
}

/** Stores a page and hands back its markup, which is wanted twice: as bytes, and as text to scan. */
async function storeDocument(
  cache: Cache,
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: number; html: string }> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);

  const html = await response.clone().text();
  const body = await response.arrayBuffer();
  await cache.put(
    url,
    new Response(body, { status: 200, statusText: 'OK', headers: response.headers }),
  );
  return { bytes: body.byteLength, html };
}

/**
 * Caches the scripts and stylesheets a stored page names — without them React replaces the
 * downloaded document with its error boundary. Into `ASSET_CACHE` and not the shell, which
 * `activate` sweeps per deploy: nothing else re-harvests these, so a sweep would strand the page.
 * Assets already held are skipped, since content-hashed URLs that resolved once resolve forever.
 */
async function storeShell(html: string, signal?: AbortSignal): Promise<void> {
  const cache = await caches.open(ASSET_CACHE);
  const assets = staticAssets(html).map((path) => new URL(path, location.origin).toString());
  const held = await Promise.all(assets.map((url) => cache.match(url, { ignoreVary: true })));
  const missing = assets.filter((_url, index) => held[index] === undefined);
  await pool(
    missing,
    (url) => store(cache, url, signal),
    () => undefined,
    signal,
  );
}

/**
 * Runs `work` over `items` with a fixed pool. Errors are swallowed per item — terrain tiles
 * legitimately 404 over ocean — and the progress count is of items *attempted*, so the bar moves.
 */
async function pool(
  items: readonly string[],
  worker: (url: string) => Promise<number>,
  onEach: (url: string | null, bytes: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    for (;;) {
      if (signal?.aborted) throw new DOMException('Download cancelled.', 'AbortError');
      const index = next++;
      const url = items[index];
      if (url === undefined) return;
      try {
        onEach(url, await worker(url));
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        onEach(null, 0);
      }
    }
  });
  await Promise.all(runners);
}

/** Every tile URL a downloaded trail will need, across all three sources. */
function tileUrls(corridor: CorridorResult, vector: string | null): string[] {
  const urls: string[] = [];
  for (const tile of corridor.tiles) {
    urls.push(tileUrl(TERRARIUM_URL_TEMPLATE, tile));
    // Past z14 the vector source has nothing new; asking for z15 caches four 404s per tile.
    if (vector && tile.z <= VECTOR_MAX_ZOOM) urls.push(tileUrl(vector, tile));
  }
  return urls;
}

/**
 * Plans a download without performing it, so the button can say what it will cost. The tile count
 * is exact; the byte figures are averages, rounded *up* so an estimate never undershoots.
 */
export function planDownload(trail: TrailDetail): {
  corridor: CorridorResult;
  tiles: number;
  estimatedBytes: number;
} {
  const corridor = tileCorridor(trail.geometry, {
    minZoom: OFFLINE_MIN_ZOOM,
    maxZoom: OFFLINE_MAX_ZOOM,
  });
  const vectorTiles = corridor.tiles.filter((tile) => tile.z <= VECTOR_MAX_ZOOM).length;
  const tiles = corridor.tiles.length + vectorTiles;

  const estimatedBytes =
    corridor.tiles.length * 120_000 +
    vectorTiles * 11_000 +
    // A flat cost per download, paid once however short the route.
    GLYPH_RANGES.length * 100_000;
  return { corridor, tiles, estimatedBytes };
}

/**
 * Downloads a trail for offline use. Resolves to the manifest row, which is written to IndexedDB
 * before returning, so a caller that forgets to persist it cannot leave orphaned bytes behind.
 */
export async function downloadTrail(
  trail: TrailDetail,
  options: DownloadOptions = {},
): Promise<OfflineTrail> {
  const { onProgress, signal } = options;
  const photoUrls = [
    ...new Set([
      ...(trail.primaryPhotoUrl ? [trail.primaryPhotoUrl] : []),
      ...(options.photoUrls ?? []),
    ]),
  ];

  const { corridor } = planDownload(trail);
  if (corridor.truncated && corridor.coveredMaxZoom < OFFLINE_MIN_ZOOM) {
    throw new DownloadTooLargeError(corridor.tiles.length);
  }

  let done = 0;
  let bytes = 0;
  const report = (phase: DownloadPhase, total: number): void =>
    onProgress?.({ phase, done, total, bytes });

  report('planning', 1);

  const vector = await vectorTemplate(openMapTilesUrl(), signal);

  // Glyphs only matter if there are labels to draw with them.
  const glyphTemplate = glyphsUrl();
  const glyphUrls = vector
    ? GLYPH_RANGES.map((range) =>
        glyphTemplate
          .replace('{fontstack}', encodeURIComponent(FONTSTACK))
          .replace('{range}', range),
      )
    : [];
  const tiles = [...tileUrls(corridor, vector), ...glyphUrls];
  const pageUrl = new URL(`/trails/${trail.slug}`, location.origin).toString();
  const total = 1 + tiles.length + photoUrls.length;

  // The page. The only fatal step: without it there is nothing to open.
  report('page', total);
  const pageCache = await caches.open(PAGE_CACHE);
  const page = await storeDocument(pageCache, pageUrl, signal);
  bytes += page.bytes;
  done += 1;

  // The page's build assets, deliberately not counted against this trail nor listed in its
  // manifest: every trail page shares them, so evicting them with one trail would blank the rest.
  // `evictTrails` owns their lifetime instead. See `storeShell`.
  await storeShell(page.html, signal);

  report('tiles', total);
  const tileCache = await caches.open(TILE_CACHE);
  const storedTiles: string[] = [];
  await pool(
    tiles,
    (url) => store(tileCache, url, signal),
    (url, size) => {
      done += 1;
      bytes += size;
      if (url) storedTiles.push(url);
      report('tiles', total);
    },
    signal,
  );

  report('media', total);
  const mediaCache = await caches.open(MEDIA_CACHE);
  const storedMedia: string[] = [];
  await pool(
    photoUrls,
    (url) => store(mediaCache, url, signal),
    (url, size) => {
      done += 1;
      bytes += size;
      if (url) storedMedia.push(url);
      report('media', total);
    },
    signal,
  );

  report('saving', total);
  const row: OfflineTrail = {
    trailId: trail.id,
    slug: trail.slug,
    name: trail.name,
    regionName: trail.regionName,
    lengthM: trail.stats.lengthM,
    gainM: trail.stats.gainM,
    downloadedAt: Date.now(),
    coveredMaxZoom: corridor.coveredMaxZoom,
    truncated: corridor.truncated,
    bytes,
    tileUrls: storedTiles,
    pageUrls: [pageUrl],
    mediaUrls: storedMedia,
    detail: trail,
  };
  await putOfflineTrail(row);
  return row;
}
