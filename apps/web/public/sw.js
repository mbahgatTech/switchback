/*
 * Switchback's service worker: hand-written, no build step, and deliberately ignorant of what a
 * tile is — the app stores what is worth keeping, and this serves whatever it finds in our caches.
 */

// Served from the origin root, outside the module graph, so nothing here can be imported. These
// names are a second copy of `src/offline/caches.ts`; `test/offline-caches.test.ts` guards the drift.
// Service-worker globals are declared in `eslint.config.mjs` — flat config ignores `eslint-env`.
const CACHE_PREFIX = 'sb-';
const TILE_CACHE = 'sb-tiles-v1';
const PAGE_CACHE = 'sb-pages-v1';
const MEDIA_CACHE = 'sb-media-v1';
/**
 * The `/_next/static/*` a *downloaded page* names. Hand-versioned like the three above: they are
 * part of somebody's download, and a page served without its chunks renders "This page couldn't load".
 */
const ASSET_CACHE = 'sb-assets-v1';
/**
 * This build, out of the worker's own URL: `register.tsx` registers `/sw.js?v=<build id>`, the only
 * channel into a file outside the module graph, and a changed query is a changed worker URL.
 */
const BUILD_ID = new URL(self.location.href).searchParams.get('v') || 'dev';
/**
 * This build's own precache, scoped to the build so the next `activate` collects it. The four above
 * are the reader's downloads and are hand-versioned: a deploy must not delete them.
 */
const SHELL_CACHE = `sb-shell-${BUILD_ID}`;
/**
 * The flat shell name earlier builds used. Deliberately absent from `OFFLINE_CACHES` so `activate`
 * sweeps it — `adoptLegacyShell` must rescue downloaded pages' chunks out of it before that runs.
 */
const LEGACY_SHELL_CACHE = 'sb-shell-v1';
const OFFLINE_CACHES = [TILE_CACHE, PAGE_CACHE, MEDIA_CACHE, ASSET_CACHE, SHELL_CACHE];
const OFFLINE_FALLBACK_PATH = '/offline';
const SHELL_PAGES = [OFFLINE_FALLBACK_PATH, '/downloads', '/', '/explore', '/record'];
const STATIC_ASSET_PATTERN = String.raw`/_next/static/[A-Za-z0-9._@%/-]+\.[A-Za-z0-9]{2,5}\b`;
const PRECACHE_ATTEMPTS = 3;
const PRECACHE_BACKOFF_MS = 500;

/**
 * Shell pages that answered with a redirect (`/record` is auth-gated), remembered so `repairShell`
 * does not refetch them on every navigation. Per worker instance: a fresh worker is worth re-asking.
 */
const redirectedShellPages = new Set();

/**
 * Caches a page *and the build assets its markup names* — nobody visits `/offline` while online, so
 * its chunks are never requested and the fallback would fail to render exactly when it is needed.
 * Individual puts rather than the atomic `addAll`, and retried because `install` runs only once.
 */
async function precache(cache, path) {
  for (let attempt = 1; attempt <= PRECACHE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, PRECACHE_BACKOFF_MS * (attempt - 1)));
    }

    const response = await fetch(new Request(path, { cache: 'reload' })).catch(() => null);
    if (!response || !response.ok) continue;
    /*
     * A redirect is not this page: a signed-out install would otherwise store `/signin`'s markup
     * under the key `/record`. Returned rather than retried — a redirect is a settled answer.
     */
    if (response.redirected) {
      redirectedShellPages.add(path);
      return;
    }

    const html = await response.clone().text();
    await cache.put(path, response);

    const assets = [...new Set(html.match(new RegExp(STATIC_ASSET_PATTERN, 'gu')) || [])];
    await Promise.all(assets.map((asset) => cache.add(asset).catch(() => undefined)));
    return;
  }
}

/**
 * Refills a shell page that `install` could not fetch. A navigation that has just returned 2xx is
 * proof of a working network, and the cheapest chance to close a gap that only shows up offline.
 */
let repairing = false;

async function repairShell() {
  if (repairing) return;
  repairing = true;
  try {
    const cache = await caches.open(SHELL_CACHE);
    for (const path of SHELL_PAGES) {
      if (redirectedShellPages.has(path)) continue;
      if (!(await cache.match(path))) await precache(cache, path);
    }
  } catch {
    // Nothing useful to do from here. The next navigation tries again.
  } finally {
    repairing = false;
  }
}

/**
 * Takes over immediately rather than waiting for every tab to close: this worker serves bytes and
 * does not shape responses, so a page talking to a worker newer than its own HTML is inert.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        /*
         * Sequential and individually guarded: install has no deadline, and asking the dev server
         * to render two overlapping module graphs at once makes it answer 500 for the second.
         */
        for (const path of SHELL_PAGES) {
          await precache(cache, path).catch(() => undefined);
        }
      })
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

/**
 * Moves a pre-existing download's `/_next/static/*` out of the old flat shell into `ASSET_CACHE`
 * before `activate` sweeps that name. Chunks only: a downloaded page names content-hashed URLs no
 * current build serves, whereas its markup is refetched on the first navigation. Nothing is fatal.
 */
async function adoptLegacyShell() {
  const names = await caches.keys();
  if (!names.includes(LEGACY_SHELL_CACHE) || OFFLINE_CACHES.includes(LEGACY_SHELL_CACHE)) return;

  const old = await caches.open(LEGACY_SHELL_CACHE);
  const assets = await caches.open(ASSET_CACHE);

  for (const request of await old.keys()) {
    let pathname;
    try {
      const url = new URL(request.url);
      if (url.origin !== self.location.origin) continue;
      pathname = url.pathname;
    } catch {
      continue;
    }
    if (!pathname.startsWith('/_next/static/')) continue;

    try {
      // Content-hashed, so an entry already held is the same bytes.
      if (await assets.match(request, { ignoreVary: true })) continue;
      const response = await old.match(request);
      if (response) await assets.put(request, response);
    } catch {
      // One asset lost, not the pass.
    }
  }
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // Before the sweep, and sequentially: the cache it reads is the one the sweep deletes.
    adoptLegacyShell()
      .catch(() => undefined)
      .then(() => caches.keys())
      .then((names) =>
        Promise.all(
          names
            // Ours and superseded. Another app's caches on this origin are left alone.
            .filter((name) => name.startsWith(CACHE_PREFIX) && !OFFLINE_CACHES.includes(name))
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Anything we deliberately stored, from whichever cache holds it. */
async function fromOurCaches(request) {
  for (const name of OFFLINE_CACHES) {
    const cache = await caches.open(name);
    const hit = await cache.match(request, { ignoreVary: true });
    if (hit) return hit;
  }
  return null;
}

/**
 * A page request: network first (conditions change), then cache, then the offline page.
 * `cache.match` is query-sensitive, so `/record?trail=…` misses the stored `/record` entry and
 * degrades to the plain shell — you can still record, you just do not get the wrong-turn watchdog.
 */
async function handleNavigation(request, url) {
  try {
    const response = await fetch(request);
    // Only 2xx is worth keeping: caching a 500 would pin the error until the cache is cleared.
    if (response.ok) {
      // A working network, proven rather than assumed. See `repairShell`.
      void repairShell();
      refreshShell(request, response);

      const cache = await caches.open(PAGE_CACHE);
      // Refresh a page that was explicitly downloaded; never silently store one merely visited.
      if (await cache.match(request, { ignoreVary: true })) {
        cache.put(request, response.clone()).catch(() => undefined);
      }
    }
    return response;
  } catch {
    const cached = await fromOurCaches(request);
    if (cached) return cached;

    const shell = await caches.open(SHELL_CACHE);
    if (SHELL_PAGES.includes(url.pathname)) {
      const page = await shell.match(url.pathname);
      if (page) return page;
    }

    const fallback = await shell.match(OFFLINE_FALLBACK_PATH);
    return (
      fallback ??
      new Response('Offline, and this page was not downloaded.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    );
  }
}

/**
 * Replaces a stored shell page with the copy the reader just loaded. `/` and `/explore` render with
 * this reader's own opening coordinate, so the shell is viewer-dependent and filling gaps is not
 * enough. Clones before anything awaits: a response body can only be read once, and the page needs it.
 */
function refreshShell(request, response) {
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) return;
  if (!SHELL_PAGES.includes(url.pathname)) return;
  // Same guard as `precache`: storing a redirect would hand a sign-in form to a signed-in reader.
  if (response.redirected) return;

  const copy = response.clone();
  // This reader can see the page after all, so the earlier refusal no longer holds.
  redirectedShellPages.delete(url.pathname);
  caches
    .open(SHELL_CACHE)
    .then((cache) => cache.put(url.pathname, copy))
    // The stored copy stays as it was.
    .catch(() => undefined);
}

/**
 * A build asset, cache-first because `/_next/static/*` is content-hashed. `ASSET_CACHE` is looked in
 * *second*, and must be: a downloaded page names hashed URLs no current build serves, so without
 * that look the download is present but renders React's error boundary once the signal goes.
 */
async function handleStatic(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;

  const downloaded = await caches.open(ASSET_CACHE);
  const kept = await downloaded.match(request, { ignoreVary: true });
  if (kept) return kept;

  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone()).catch(() => undefined);
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  const sameOrigin = url.origin === self.location.origin;

  /*
   * The API is never cached: tRPC carries reads over GET, and a silently stale read is worse than
   * an honest failure. Offline reading is served by the cached *page*, which is dated and looks it.
   */
  if (sameOrigin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/image'))) {
    return;
  }

  if (sameOrigin && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(handleStatic(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request, url));
    return;
  }

  // Tiles, glyphs, photographs, fonts: served if we stored them, otherwise a plain fetch, so an
  // undownloaded trail behaves exactly as it would with no worker installed.
  event.respondWith(fromOurCaches(request).then((hit) => hit ?? fetch(request)));
});

/** Lets the page ask a freshly-installed worker to take over without a reload. */
self.addEventListener('message', (event) => {
  if (event.data === 'sb:skip-waiting') self.skipWaiting();
});
