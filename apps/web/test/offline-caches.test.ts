import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASSET_CACHE,
  BUILD_ID,
  CACHE_PREFIX,
  LEGACY_SHELL_CACHE,
  MEDIA_CACHE,
  OFFLINE_CACHES,
  OFFLINE_FALLBACK_PATH,
  PAGE_CACHE,
  READER_SHELL_PAGES,
  SHELL_CACHE,
  SHELL_PAGES,
  STATIC_ASSET_PATTERN,
  staticAssets,
  TILE_CACHE,
} from '../src/offline/caches';

/**
 * The service worker is served from the origin root, outside the module graph, so it cannot import
 * anything: every cache name and pattern exists twice. Drift is silent and only shows up offline,
 * and no typecheck or lint can see across that boundary — so this file reads the worker as text.
 */
const SW = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

/** The registration, read as text: the build id reaches the worker through its URL, not an import. */
const REGISTER = readFileSync(
  fileURLToPath(new URL('../src/offline/register.tsx', import.meta.url)),
  'utf8',
);

/** The downloader, read as text for the third instance of the same problem. */
const DOWNLOAD = readFileSync(
  fileURLToPath(new URL('../src/offline/download.ts', import.meta.url)),
  'utf8',
);

/** Pull `const NAME = 'value';` out of the worker source. */
function literal(name: string): string | null {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*'([^']*)'`, 'u').exec(SW);
  return match?.[1] ?? null;
}

describe('service worker cache names', () => {
  it.each([
    ['CACHE_PREFIX', CACHE_PREFIX],
    ['TILE_CACHE', TILE_CACHE],
    ['PAGE_CACHE', PAGE_CACHE],
    ['MEDIA_CACHE', MEDIA_CACHE],
    ['ASSET_CACHE', ASSET_CACHE],
    ['OFFLINE_FALLBACK_PATH', OFFLINE_FALLBACK_PATH],
  ])('%s matches the app', (name, expected) => {
    expect(literal(name)).toBe(expected);
  });

  // The shell name carries the build id, so the two sides only agree at runtime: what is checked
  // is the shape, plus (below) that the worker really does take the value from its own URL.
  it('scopes the shell cache to the build, in both copies', () => {
    const inWorker = /const\s+SHELL_CACHE\s*=\s*`sb-shell-\$\{BUILD_ID\}`/u.test(SW);
    expect(inWorker).toBe(true);
    expect(SHELL_CACHE).toBe(`sb-shell-${BUILD_ID}`);
    expect(SHELL_CACHE.startsWith(CACHE_PREFIX)).toBe(true);
  });

  it('does not harvest a download into the cache a deploy sweeps', () => {
    const write =
      /async function storeShell\([^)]*\)[^{]*\{\s*const cache = await caches\.open\((\w+)\)/u.exec(
        DOWNLOAD,
      );
    expect(write?.[1]).toBe('ASSET_CACHE');
    expect(ASSET_CACHE).not.toContain(BUILD_ID);
    // And the worker has to look there, or the entries are stored and never served: a
    // downloaded page names hashed URLs that no current build serves.
    expect(SW).toMatch(/async function handleStatic[\s\S]*?caches\.open\(ASSET_CACHE\)/u);
  });

  it('carries a pre-split download’s chunks out of the old shell before sweeping it', () => {
    expect(literal('LEGACY_SHELL_CACHE')).toBe(LEGACY_SHELL_CACHE);
    // Not adopted into the keep-list: it is emptied and then collected, not retained.
    expect(OFFLINE_CACHES).not.toContain(LEGACY_SHELL_CACHE);
    expect(SW).toMatch(
      /async function adoptLegacyShell[\s\S]*?caches\.open\(LEGACY_SHELL_CACHE\)[\s\S]*?caches\.open\(ASSET_CACHE\)/u,
    );
    // Only the build assets. Shell markup for an older build is refetched on first navigation.
    expect(SW).toMatch(/adoptLegacyShell[\s\S]*?startsWith\('\/_next\/static\/'\)/u);
    // And before the delete pass, or the copy reads a cache that is already gone.
    expect(SW).toMatch(/adoptLegacyShell\(\)[\s\S]*?caches\.delete\(name\)/u);
  });

  it('takes the build id from the URL it was registered with', () => {
    // That query string is the only channel into a file outside the module graph, and a changed
    // one is also what forces the upgrade.
    expect(SW).toMatch(/new URL\(self\.location\.href\)\.searchParams\.get\('v'\)/u);
    expect(REGISTER).toMatch(/register\(`\/sw\.js\?v=\$\{encodeURIComponent\(BUILD_ID\)\}`/u);
  });

  it('lists every cache in OFFLINE_CACHES, so activate does not evict a live one', () => {
    // The worker deletes any `sb-` cache missing from this array on activate.
    const match = /const\s+OFFLINE_CACHES\s*=\s*\[([^\]]*)\]/u.exec(SW);
    expect(match).not.toBeNull();

    const listed = [...(match?.[1] ?? '').matchAll(/[A-Z_]+/gu)].map((m) => m[0]);
    expect(listed).toEqual([
      'TILE_CACHE',
      'PAGE_CACHE',
      'MEDIA_CACHE',
      'ASSET_CACHE',
      'SHELL_CACHE',
    ]);
    expect(OFFLINE_CACHES).toHaveLength(listed.length);
  });

  it('keeps every cache under the prefix it sweeps by', () => {
    // A cache named outside the prefix would never be collected when its version is bumped.
    for (const name of OFFLINE_CACHES) expect(name.startsWith(CACHE_PREFIX)).toBe(true);
  });

  it('keeps the downloads a reader made off the build id', () => {
    // Versioning any of these off the build would empty somebody's download on every deploy.
    for (const name of [TILE_CACHE, PAGE_CACHE, MEDIA_CACHE, ASSET_CACHE]) {
      expect(name).not.toContain(BUILD_ID);
    }
  });
});

describe('service worker routing', () => {
  it('never caches the API', () => {
    // A stale tRPC read served silently makes a review look posted and a Lifeline ping look sent.
    expect(SW).toMatch(/url\.pathname\.startsWith\('\/api\/'\)/u);
  });

  it('only responds to GET', () => {
    expect(SW).toMatch(/request\.method !== 'GET'/u);
  });
});

/**
 * A cached page without its chunks renders Next's error boundary from a cache that contains the
 * page. The worker and the downloader harvest the asset list with the same expression; these keep
 * the two honest.
 */
describe('build assets referenced by a cached page', () => {
  /** Pull the inside of a ``String.raw`…` `` binding out of a source file. */
  function rawTemplate(source: string, name: string): string | null {
    const match = new RegExp(`const\\s+${name}\\s*=\\s*String\\.raw\`([^\`]*)\``, 'u').exec(source);
    return match?.[1] ?? null;
  }

  it('uses the same pattern in the worker as in the app', () => {
    expect(rawTemplate(SW, 'STATIC_ASSET_PATTERN')).toBe(STATIC_ASSET_PATTERN);
  });

  it('precaches the fallback page with its assets, not just its markup', () => {
    // `cache.add(OFFLINE_FALLBACK_PATH)` alone is the bug this replaced.
    expect(SW).toMatch(/precache\(cache, path\)/u);
    // Individually, because `addAll` is atomic: one 404 would discard the fallback too.
    expect(SW).not.toMatch(/\.addAll\(/u);
  });

  it('precaches the shell pages one at a time', () => {
    // These pages share components, and Next's dev server answers 500, reproducibly, for
    // whichever of two overlapping module graphs lands second. Install has no deadline.
    expect(SW).toMatch(/for \(const path of SHELL_PAGES\) \{\s*await precache\(/u);
  });

  it('retries a shell page rather than giving up on one bad response', () => {
    // `install` fires once per worker version, so a 500 lasting the half-second a deploy takes
    // to swap over would cost this worker its fallback for life.
    expect(SW).toMatch(/attempt <= PRECACHE_ATTEMPTS/u);
    // And any later navigation that succeeds is a chance to put back what install missed.
    expect(SW).toMatch(/void repairShell\(\)/u);
  });

  it('precaches the same pages the app names', () => {
    const match = /const\s+SHELL_PAGES\s*=\s*\[([^\]]*)\]/u.exec(SW);
    const listed = [...(match?.[1] ?? '').matchAll(/'([^']*)'|([A-Z_]+)/gu)].map(
      (m) => m[1] ?? (m[2] === 'OFFLINE_FALLBACK_PATH' ? OFFLINE_FALLBACK_PATH : m[2]),
    );
    expect(listed).toEqual([...SHELL_PAGES]);
  });

  it('keeps the recorder in the shell', () => {
    // Named separately from the equality above, which only says the two lists agree: dropping
    // `/record` from both would keep that test green.
    expect(SHELL_PAGES).toContain('/record');
  });

  it('names only per-reader pages as the ones a handover deletes', () => {
    // Deleting `SHELL_CACHE` by name took the fallback, the storage manager and every harvested
    // chunk with it, and nothing puts those back without a full-document navigation.
    for (const path of READER_SHELL_PAGES) expect(SHELL_PAGES).toContain(path);
    // The two that take no server input are right for everybody and are not anybody's to lose.
    expect(READER_SHELL_PAGES).not.toContain(OFFLINE_FALLBACK_PATH);
    expect(READER_SHELL_PAGES).not.toContain('/downloads');
  });

  it('never stores a redirect under a shell page', () => {
    // `/record` is auth-gated: a signed-out install follows its 307 to `/signin` and gets a 200,
    // so an unguarded put caches the sign-in form under the key `/record`.
    //
    // Asserted by *shape and position*, not by substring: `/if \(response\.redirected\) return;/`
    // matched only `refreshShell`'s copy, leaving `precache`'s guard untested and mutable.
    expect(SW).toMatch(
      /if \(response\.redirected\) \{\s*redirectedShellPages\.add\(path\);\s*return;\s*\}[\s\S]*?await cache\.put\(path, response\);/u,
    );
    // And `refreshShell`'s, which returns before the `caches.open` that would put it.
    expect(SW).toMatch(/if \(response\.redirected\) return;[\s\S]*?caches\s*$/mu);
  });

  it('stops asking for a shell page the reader is not allowed to see', () => {
    // `repairShell` fills any entry `cache.match` misses, and a signed-out `/record` misses for
    // ever — six extra server renders per page view. `refreshShell` clears the refusal.
    expect(SW).toMatch(/if \(redirectedShellPages\.has\(path\)\) continue;/u);
    expect(SW).toMatch(/redirectedShellPages\.delete\(url\.pathname\)/u);
  });

  it('matches a shell page by pathname when the query differs', () => {
    // `cache.match` is query-sensitive, so `/record?trail=vesper-peak` misses the stored `/record`.
    expect(SW).toMatch(
      /SHELL_PAGES\.includes\(url\.pathname\)\) \{\s*const page = await shell\.match\(url\.pathname\)/u,
    );
  });

  it('finds scripts, stylesheets and fonts in real Next markup', () => {
    const html = `<!DOCTYPE html><html><head>
      <link rel="stylesheet" href="/_next/static/css/6c1a0f2b.css"/>
      <link rel="preload" as="font" href="/_next/static/media/archivo-9e1c.p.woff2"/>
      <script src="/_next/static/chunks/3u-zl6cy87t7w.js" async></script>
      </head><body><script>self.__next_f.push([1,"a:{\\"src\\":\\"/_next/static/chunks/app/trails/%5Bslug%5D/page-77b2.js\\"}"])</script></body></html>`;

    expect(staticAssets(html)).toEqual([
      '/_next/static/css/6c1a0f2b.css',
      '/_next/static/media/archivo-9e1c.p.woff2',
      '/_next/static/chunks/3u-zl6cy87t7w.js',
      '/_next/static/chunks/app/trails/%5Bslug%5D/page-77b2.js',
    ]);
  });

  it('returns each asset once, however many times the markup names it', () => {
    const twice = '/_next/static/chunks/a.js" "/_next/static/chunks/a.js';
    expect(staticAssets(twice)).toEqual(['/_next/static/chunks/a.js']);
  });

  it('ignores a bare prefix with no file at the end of it', () => {
    // `"assetPrefix":"/_next/static/"` in a build manifest is not something to fetch.
    expect(staticAssets('{"path":"/_next/static/"}')).toEqual([]);
  });
});
