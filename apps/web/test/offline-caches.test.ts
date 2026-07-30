import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILD_ID,
  CACHE_PREFIX,
  MEDIA_CACHE,
  OFFLINE_CACHES,
  OFFLINE_FALLBACK_PATH,
  PAGE_CACHE,
  SHELL_CACHE,
  SHELL_PAGES,
  STATIC_ASSET_PATTERN,
  staticAssets,
  TILE_CACHE,
} from '../src/offline/caches';

/**
 * The service worker cannot import anything.
 *
 * It has to be served from the origin root to have scope over the whole site, which means it
 * lives under `public/` as a plain file outside the module graph. So the cache names exist
 * twice, and the failure mode of them drifting is silent and delayed: the app writes tiles
 * into `sb-tiles-v2`, the worker looks in `sb-tiles-v1`, every download reports success, and
 * the map is blank in a place with no signal to fix it from. Nothing in typecheck or lint
 * can see across that boundary — so this test does, by reading the worker as text.
 */
const SW = readFileSync(fileURLToPath(new URL('../public/sw.js', import.meta.url)), 'utf8');

/**
 * The registration, read as text for the same reason.
 *
 * The build id reaches the worker through the URL it is registered with, so the two halves of
 * that channel are in different files and neither can typecheck against the other.
 */
const REGISTER = readFileSync(
  fileURLToPath(new URL('../src/offline/register.tsx', import.meta.url)),
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
    ['OFFLINE_FALLBACK_PATH', OFFLINE_FALLBACK_PATH],
  ])('%s matches the app', (name, expected) => {
    expect(literal(name)).toBe(expected);
  });

  /**
   * The shell cache is the one name neither side can spell out, because it carries the build
   * id: the app reads `NEXT_PUBLIC_BUILD_ID`, the worker reads `?v=` off its own URL, and the
   * two only agree at runtime. So what is checked is the shape — same prefix, same
   * interpolation — plus, below, that the worker really does take the value from its URL. A
   * literal `sb-shell-v1` here would be the bug: the shell holds this build's `/_next/static`
   * chunks, and on a fixed name `activate` never collects them, so a bad asset outlives the
   * deploy that removed it.
   */
  it('scopes the shell cache to the build, in both copies', () => {
    const inWorker = /const\s+SHELL_CACHE\s*=\s*`sb-shell-\$\{BUILD_ID\}`/u.test(SW);
    expect(inWorker).toBe(true);
    expect(SHELL_CACHE).toBe(`sb-shell-${BUILD_ID}`);
    expect(SHELL_CACHE.startsWith(CACHE_PREFIX)).toBe(true);
  });

  it('takes the build id from the URL it was registered with', () => {
    // `offline/register.tsx` appends `?v=<build id>`; `self.location` in a worker is the
    // script URL it was registered with. That query string is the only channel into a file
    // outside the module graph, and a changed one is also what forces the upgrade.
    expect(SW).toMatch(/new URL\(self\.location\.href\)\.searchParams\.get\('v'\)/u);
    expect(REGISTER).toMatch(/register\(`\/sw\.js\?v=\$\{encodeURIComponent\(BUILD_ID\)\}`/u);
  });

  it('lists every cache in OFFLINE_CACHES, so activate does not evict a live one', () => {
    // The worker deletes any `sb-` cache missing from this array on activate. A cache the
    // app writes to but the worker has not been told about is deleted on the next deploy.
    const match = /const\s+OFFLINE_CACHES\s*=\s*\[([^\]]*)\]/u.exec(SW);
    expect(match).not.toBeNull();

    const listed = [...(match?.[1] ?? '').matchAll(/[A-Z_]+/gu)].map((m) => m[0]);
    expect(listed).toEqual(['TILE_CACHE', 'PAGE_CACHE', 'MEDIA_CACHE', 'SHELL_CACHE']);
    expect(OFFLINE_CACHES).toHaveLength(listed.length);
  });

  it('keeps every cache under the prefix it sweeps by', () => {
    // `activate` deletes caches starting with the prefix and not in the list. A cache named
    // outside the prefix would never be collected when its version is bumped.
    for (const name of OFFLINE_CACHES) expect(name.startsWith(CACHE_PREFIX)).toBe(true);
  });

  it('keeps the downloads a reader made off the build id', () => {
    // Tiles, pages and photographs are somebody's deliberate download, quite possibly for a
    // trip they are on. Versioning those off the build would empty them on every deploy.
    for (const name of [TILE_CACHE, PAGE_CACHE, MEDIA_CACHE]) {
      expect(name).not.toContain(BUILD_ID);
    }
  });
});

describe('service worker routing', () => {
  it('never caches the API', () => {
    // A stale tRPC read served silently is worse than an honest failure: it makes a review
    // look posted and a Lifeline ping look sent.
    expect(SW).toMatch(/url\.pathname\.startsWith\('\/api\/'\)/u);
  });

  it('only responds to GET', () => {
    expect(SW).toMatch(/request\.method !== 'GET'/u);
  });
});

/**
 * A cached page without its chunks renders Next's error boundary — "This page couldn't load"
 * — from a cache that contains the page. Both the worker (for `/offline`, at install) and the
 * downloader (for a trail page) harvest the asset list out of the markup, with the same
 * expression, and these are the tests that keep the two honest.
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
    /*
     * These pages share components, and a server asked to render two overlapping module
     * graphs in the same instant may answer 500 for whichever lands second — Next's dev
     * server does, reproducibly. The cost is a worker that installed successfully and has no
     * fallback page, which is invisible until somebody is offline. Install has no deadline,
     * so nothing is won back by running them together.
     */
    expect(SW).toMatch(/for \(const path of SHELL_PAGES\) \{\s*await precache\(/u);
  });

  it('retries a shell page rather than giving up on one bad response', () => {
    // `install` fires once per worker version and nothing re-runs it, so a 500 lasting the
    // half-second a deploy takes to swap over would cost this worker its fallback for life.
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
