/**
 * Taking a trail with you.
 *
 * The unit of download here is a **page**, not a data blob, and that is the design decision
 * everything else follows from. A trail page is server-rendered end to end — stats,
 * description, waypoints, access, provenance, and the route geometry the map island draws
 * from are all in the HTML by the time it reaches the browser. So the honest way to make it
 * work offline is to keep the HTML, keep the tiles the map will ask for, and keep the
 * photographs. Nothing has to be reassembled from parts, and nothing can be reassembled
 * *wrongly* — the offline page is byte-for-byte the page you were looking at when you
 * pressed the button.
 *
 * The tiles are the hard part and the valuable part. They come from a corridor along the
 * route rather than its bounding box (see `tileCorridor`), from every source the relief base
 * actually uses: terrain for the shading, vector for the names, glyphs to draw them with.
 * That is why this works without a self-hosted PMTiles archive — the sources are keyless
 * HTTP tiles, and a tile in a cache is a tile.
 *
 * Failures are per-URL and non-fatal. Terrain tiles legitimately 404 over ocean, a vector
 * tile can time out, and a download that aborts because one tile of four hundred was
 * missing would fail constantly for no reason a hiker could act on. What is fatal is the
 * page itself: without it there is nothing to open.
 */

import { MAX_CORRIDOR_TILES, TERRARIUM_URL_TEMPLATE, tileCorridor, tileUrl } from '@switchback/geo';
import type { CorridorResult } from '@switchback/geo';
import type { TrailDetail } from '@switchback/core';
import { glyphsUrl, openMapTilesUrl } from '../components/map/basemap';
import { ASSET_CACHE, MEDIA_CACHE, PAGE_CACHE, staticAssets, TILE_CACHE } from './caches';
import { putOfflineTrail, type OfflineTrail } from './store';

/**
 * The zoom range a downloaded trail is usable at.
 *
 * z10 is the "where in the country is this" view; z15 is close enough to tell which side of
 * the stream the path runs. Below 10 the trail is a dot on a region and the tiles are shared
 * with everything else you have downloaded anyway; above 15 the vector source has no more
 * detail to give — OpenMapTiles builds stop at 14 and overzoom from there — so the extra
 * tiles would be terrain only, at four times the count, for a sharper hillshade nobody
 * navigates by.
 */
export const OFFLINE_MIN_ZOOM = 10;
export const OFFLINE_MAX_ZOOM = 15;

/** Vector tiles exist only to z14; MapLibre overzooms past that from the z14 tile. */
const VECTOR_MAX_ZOOM = 14;

/**
 * Simultaneous tile fetches.
 *
 * Six is the browser's own per-host connection limit, so asking for more just queues them in
 * a different place while making the abort button slower to take effect.
 */
const CONCURRENCY = 6;

/**
 * Character ranges to keep glyphs for.
 *
 * Latin, its supplement, and Latin Extended-A and B — the block a European or American
 * place name is drawn from. A viewport in Japan or Greece would want more, but glyph
 * ranges are 30–60 kB apiece and downloading the world's scripts to hike in Snowdonia is
 * not a trade worth making. The map falls back to unlabelled features for a range it has
 * not got, which degrades honestly.
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
 * The vector tile template, read from the source's TileJSON at download time.
 *
 * OpenFreeMap bakes a build stamp into the tile path — `…/planet/20260621_080001_pt/{z}/…` —
 * which changes whenever the planet is rebuilt. Hard-coding the template we happened to see
 * once would mean every download after the next rebuild caches URLs the map will never ask
 * for: a progress bar that fills, a manifest that looks right, and a blank map.
 */
async function vectorTemplate(tileJsonUrl: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await fetch(tileJsonUrl, signal ? { signal } : undefined);
    if (!response.ok) return null;
    const body = (await response.json()) as { tiles?: readonly unknown[] } | null;
    const first: unknown = body?.tiles?.[0];
    // The `{z}` test is what makes this a template rather than merely a string: anything
    // without it cannot be filled in per tile, and caching it would be caching one file.
    return typeof first === 'string' && first.includes('{z}') ? first : null;
  } catch {
    return null;
  }
}

/**
 * Store one URL, and report what it cost.
 *
 * The body is read into memory before being put back into a `Response`, which is what makes
 * the size exact. `response.headers.get('content-length')` is absent on anything served
 * chunked and lies about anything served compressed, and a storage manager that reports
 * numbers a hiker can check against their phone's own settings screen has to be right.
 */
async function store(cache: Cache, url: string, signal?: AbortSignal): Promise<number> {
  const response = await fetch(url, {
    // Tiles and photographs are public, and sending credentials to a third-party tile host
    // would be both pointless and a small privacy leak.
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

/**
 * Store a page, and hand back its markup.
 *
 * Separate from `store` because a page's body is wanted twice — once as bytes to cache, once
 * as text to read the asset references out of. A tile has no second reading.
 */
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
 * Cache the scripts and stylesheets a stored page names.
 *
 * Without this, a downloaded page can be present, matched, and served — and still show
 * "This page couldn't load", because React could not fetch a chunk and replaced the document
 * with its error boundary. The worker's `handleStatic` fills the shell cache from ordinary
 * browsing, but only for pages visited *while it was already in control*, which a hiker who
 * installed the app and immediately pressed download has not done.
 *
 * **Into `ASSET_CACHE`, not the shell, and that is the whole point of it existing.** The shell
 * is named after the build and swept by `activate` when the next one takes over. Writing a
 * download's chunks there meant a deploy deleted them while the page that names them sat in
 * `PAGE_CACHE` untouched — a download that survives and no longer renders. Nothing re-harvests
 * them either: this function is called from `downloadTrail` and nowhere else.
 *
 * Assets already held are skipped rather than re-fetched: they are content-hashed, so a URL
 * that resolved once resolves forever, and the second trail in a valley would otherwise pay
 * for the same forty files.
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
 * Run `work` over `items` with a fixed pool, collecting the URLs that succeeded.
 *
 * Errors are swallowed per item on purpose — see the note at the top of the file. The count
 * that reaches the progress callback is of items *attempted*, not stored, so the bar
 * advances at a constant rate rather than stalling over a patch of ocean.
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
    // Past z14 the vector source has nothing new; MapLibre overzooms the z14 tile it
    // already has, so asking for z15 would cache four 404s per tile of real coverage.
    if (vector && tile.z <= VECTOR_MAX_ZOOM) urls.push(tileUrl(vector, tile));
  }
  return urls;
}

/**
 * Plan a download without performing it, so the button can say what it will cost.
 *
 * Rough by construction — the byte figures are averages, not measurements — and labelled as
 * such wherever it is shown. The tile count is exact.
 *
 * The averages come from measuring a completed download of a Cascades summit trail across
 * z10–z15 (`terrain 119 kB · vector 11 kB · glyph range 99 kB`) and are rounded *up*. An
 * estimate that comes in under what the download actually spends is a promise broken on a
 * metered connection, so where the numbers are uncertain they lean expensive: a hiker who
 * budgeted 9 MB and spent 8 has lost nothing.
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
    // The glyph ranges are a flat cost per download, paid once however short the route —
    // which is why a two-kilometre trail is never as cheap as its tile count suggests.
    GLYPH_RANGES.length * 100_000;
  return { corridor, tiles, estimatedBytes };
}

/**
 * Download a trail for offline use.
 *
 * Resolves to the manifest row, which is also written to IndexedDB before returning — so a
 * caller that forgets to persist the result cannot leave orphaned bytes in Cache Storage.
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

  // ── The page. The only fatal step: without it there is nothing to open. ──────────────
  report('page', total);
  const pageCache = await caches.open(PAGE_CACHE);
  const page = await storeDocument(pageCache, pageUrl, signal);
  bytes += page.bytes;
  done += 1;

  // The page's own build assets. Not counted against this trail's size and not listed in its
  // manifest, both on purpose: they belong to the deployment rather than to the download,
  // every trail page shares them, and evicting them with one trail would blank the others.
  // They go into `ASSET_CACHE`, which no deploy sweeps — see `storeShell`.
  await storeShell(page.html, signal);

  // ── Tiles ────────────────────────────────────────────────────────────────────────────
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

  // ── Photographs ──────────────────────────────────────────────────────────────────────
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
