/**
 * Cache names and the asset pattern, shared by the app and the service worker.
 *
 * The service worker is a plain file under `public/` — it is not part of the module graph
 * and cannot import this. So these strings appear in two places, and
 * `apps/web/test/offline-caches.test.ts` fails the build if the two ever drift. That test is
 * the whole reason this file is separate from the downloader: a mismatch here is invisible
 * in development, where the network always answers, and shows up as a blank map on a ridge.
 *
 * Versioned by name rather than cleared on upgrade. Bumping a suffix orphans the old cache,
 * which the worker deletes on activate — the standard dance, and the only one that is safe
 * while an old worker is still serving pages from the cache you want to replace.
 */

/** Every cache this product owns starts with this. The worker deletes strays that do not. */
export const CACHE_PREFIX = 'sb-';

/** Map tiles: terrain, vector, glyphs. Shared across downloads, since corridors overlap. */
export const TILE_CACHE = 'sb-tiles-v1';

/** Rendered HTML for downloaded trails. */
export const PAGE_CACHE = 'sb-pages-v1';

/** Photographs shown on a downloaded trail's page. */
export const MEDIA_CACHE = 'sb-media-v1';

/** The application shell: the offline page, and the hashed assets it needs to render. */
export const SHELL_CACHE = 'sb-shell-v1';

export const OFFLINE_CACHES = [TILE_CACHE, PAGE_CACHE, MEDIA_CACHE, SHELL_CACHE] as const;

/** Where the worker sends a navigation it cannot satisfy from either network or cache. */
export const OFFLINE_FALLBACK_PATH = '/offline';

/**
 * Pages kept from the moment the worker installs, before anything is downloaded.
 *
 * Two, and both earn it. The fallback is where every unreachable navigation lands. The
 * storage manager is where that fallback sends you — and it reads its list from IndexedDB,
 * so it is fully truthful offline; without it here, "Manage downloads" leads back to the
 * screen it was pressed from, which is the kind of small dishonesty that makes a hiker stop
 * trusting the rest. Neither takes a server, so both are static HTML plus their assets.
 */
export const SHELL_PAGES = [OFFLINE_FALLBACK_PATH, '/downloads'] as const;

/**
 * Every build asset a page references, as it appears in that page's HTML.
 *
 * Kept as a raw source string rather than a `RegExp` for one reason: the worker needs the
 * identical expression and cannot import it, so both copies are written as
 * ``String.raw`…` `` and compared character for character by `test/offline-caches.test.ts`.
 *
 * This exists because caching a page's HTML is not the same as caching the page. Next serves
 * the markup with `<script src="/_next/static/chunks/…">` and a flight payload naming more
 * chunks still; miss one of them offline and React replaces the whole document with its error
 * boundary — the page is *there*, in the cache, and the reader sees "This page couldn't load".
 * That is exactly the failure the download was bought to prevent, so the assets are harvested
 * out of the markup at the moment it is stored, when they are known to be the right ones for
 * the build that produced it.
 *
 * The trailing extension is required so a bare `/_next/static/` prefix appearing in a
 * manifest cannot be mistaken for a file and fetched as one.
 */
export const STATIC_ASSET_PATTERN = String.raw`/_next/static/[A-Za-z0-9._@%/-]+\.[A-Za-z0-9]{2,5}\b`;

/** Deduplicated `/_next/static/…` paths referenced by a page's markup. */
export function staticAssets(html: string): string[] {
  return [...new Set(html.match(new RegExp(STATIC_ASSET_PATTERN, 'gu')) ?? [])];
}
