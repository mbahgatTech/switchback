/**
 * Cache names and the asset pattern, shared by the app and the service worker. The worker is a
 * plain file under `public/` and cannot import this, so every string here exists twice and
 * `apps/web/test/offline-caches.test.ts` fails the build if the two copies drift.
 */

/**
 * This build, as a string that changes when the build does. Set in `next.config.ts` and inlined at
 * compile time, so the worker — handed the same value as a query parameter — cannot disagree.
 */
export const BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? 'dev';

/** Every cache this product owns starts with this. The worker deletes strays that do not. */
export const CACHE_PREFIX = 'sb-';

/** Map tiles: terrain, vector, glyphs. Shared across downloads, since corridors overlap. */
export const TILE_CACHE = 'sb-tiles-v1';

/** Rendered HTML for downloaded trails. */
export const PAGE_CACHE = 'sb-pages-v1';

/** Photographs shown on a downloaded trail's page. */
export const MEDIA_CACHE = 'sb-media-v1';

/**
 * The `/_next/static/*` a *downloaded page* names. Hand-versioned rather than build-scoped, and it
 * must be: a downloaded page's markup names the exact hashed URLs it was built with, so a deploy
 * that swept these would leave the page cached and unrenderable. The cost is one chunk set per
 * build a reader downloaded on; `evict.ts` drops the whole cache once the last download goes.
 */
export const ASSET_CACHE = 'sb-assets-v1';

/**
 * This build's own precache. Build-scoped, so `activate` collects the previous one — safe here and
 * not for `ASSET_CACHE`, because nothing but the current build ever asks for these entries.
 */
export const SHELL_CACHE = `sb-shell-${BUILD_ID}`;

/**
 * The shell name every build before the split used, and nothing writes any more. Deliberately
 * absent from `OFFLINE_CACHES`, so the worker's `adoptLegacyShell` must rescue the downloaded
 * pages' chunks out of it before `activate` sweeps it. Keep both until every install has upgraded:
 * dropping them strands the chunks of every pre-split download, silently and only visibly offline.
 */
export const LEGACY_SHELL_CACHE = 'sb-shell-v1';

export const OFFLINE_CACHES = [
  TILE_CACHE,
  PAGE_CACHE,
  MEDIA_CACHE,
  ASSET_CACHE,
  SHELL_CACHE,
] as const;

/** Where the worker sends a navigation it cannot satisfy from either network or cache. */
export const OFFLINE_FALLBACK_PATH = '/offline';

/**
 * Pages kept from the moment the worker installs. `/` is the manifest's `start_url` and so what a
 * cold launch opens; `/explore` was the `start_url` before the map moved, and an installed app
 * keeps whatever start URL it captured, so dropping it writes off pre-migration installs.
 */
export const SHELL_PAGES = [
  OFFLINE_FALLBACK_PATH,
  '/downloads',
  '/',
  '/explore',
  '/record',
] as const;

/**
 * The shell pages rendered for whoever was signed in, and so the only ones a handover removes.
 * `/offline` and `/downloads` take no server input, and deleting `SHELL_CACHE` whole would take
 * the fallback page and every harvested chunk with it — nothing refills those without a full
 * navigation, which App Router client routing never performs.
 */
export const READER_SHELL_PAGES = ['/', '/explore', '/record'] as const;

/**
 * Every build asset a page references, as it appears in that page's HTML. A raw source string
 * rather than a `RegExp` because the worker needs the identical expression and cannot import it:
 * both copies are written as ``String.raw`…` `` and compared character for character by the test.
 * The trailing extension is required so a bare `/_next/static/` prefix is not fetched as a file.
 */
export const STATIC_ASSET_PATTERN = String.raw`/_next/static/[A-Za-z0-9._@%/-]+\.[A-Za-z0-9]{2,5}\b`;

/** Deduplicated `/_next/static/…` paths referenced by a page's markup. */
export function staticAssets(html: string): string[] {
  return [...new Set(html.match(new RegExp(STATIC_ASSET_PATTERN, 'gu')) ?? [])];
}
