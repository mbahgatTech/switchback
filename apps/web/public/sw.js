/*
 * Switchback's service worker.
 *
 * Hand-written, and deliberately small. Workbox needs a build step this repo does not have,
 * and the Next plugins that wrap it are unmaintained against Next 16 — which for a file
 * whose failure mode is "the app is bricked until the user clears site data" is the wrong
 * dependency to take on. What is here is about a hundred lines of routing, and every line
 * of it is inspectable from DevTools.
 *
 * The strategy is unusual in one way that is the whole point: **this worker does not know
 * what a tile is.** It has no list of hosts, no URL patterns for terrain or vector or
 * glyphs. The app decides what is worth keeping and writes it into a named cache itself
 * (see `src/offline/download.ts`); the worker's rule is only "if we deliberately stored
 * this, serve it". That keeps the tile hosts in one place rather than two, and means
 * adding a source later needs no change here at all.
 *
 * Cache names are the one thing duplicated across the module boundary — this file is under
 * `public/`, outside the module graph, so it cannot import them. `test/offline-caches.test.ts`
 * fails the build if the two copies drift.
 *
 * The service-worker globals this file uses are declared for it in `eslint.config.mjs`, not
 * in an `/* eslint-env *\/` comment — flat config stopped honouring those.
 */

const CACHE_PREFIX = 'sb-';
const TILE_CACHE = 'sb-tiles-v1';
const PAGE_CACHE = 'sb-pages-v1';
const MEDIA_CACHE = 'sb-media-v1';
const SHELL_CACHE = 'sb-shell-v1';
const OFFLINE_CACHES = [TILE_CACHE, PAGE_CACHE, MEDIA_CACHE, SHELL_CACHE];
const OFFLINE_FALLBACK_PATH = '/offline';
const SHELL_PAGES = [OFFLINE_FALLBACK_PATH, '/downloads'];
const STATIC_ASSET_PATTERN = String.raw`/_next/static/[A-Za-z0-9._@%/-]+\.[A-Za-z0-9]{2,5}\b`;
const PRECACHE_ATTEMPTS = 3;
const PRECACHE_BACKOFF_MS = 500;

/**
 * Cache a page *and the build assets it names*, which is not the same thing.
 *
 * `cache.add('/offline')` stores the markup and nothing else. Nobody visits `/offline` while
 * online, so its chunks are never requested, never seen by `handleStatic`, and never cached —
 * and the first time the fallback is needed, React fails to load a chunk and replaces the
 * whole document with "This page couldn't load". The offline page failing offline is the one
 * failure this worker exists to prevent, so the assets are read out of the markup here.
 *
 * Individual puts rather than `cache.addAll`, which is atomic: one asset 404ing after a
 * redeploy would discard the fallback page along with it.
 *
 * Retried, because `install` runs once per worker version and there is nothing after it. A
 * server that answers 500 for the half-second a deploy is swapping over would otherwise cost
 * this worker its fallback for the whole of its life — silently, and visibly only to a user
 * who is by then offline and has no way to ask for it again. Three attempts is not resilience
 * against an outage; it is a refusal to make a permanent decision on one bad response.
 */
async function precache(cache, path) {
  for (let attempt = 1; attempt <= PRECACHE_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, PRECACHE_BACKOFF_MS * (attempt - 1)));
    }

    const response = await fetch(new Request(path, { cache: 'reload' })).catch(() => null);
    if (!response || !response.ok) continue;

    const html = await response.clone().text();
    await cache.put(path, response);

    const assets = [...new Set(html.match(new RegExp(STATIC_ASSET_PATTERN, 'gu')) || [])];
    await Promise.all(assets.map((asset) => cache.add(asset).catch(() => undefined)));
    return;
  }
}

/**
 * Put back a shell page that never made it into the cache.
 *
 * `install` fires once per worker version and nothing re-runs it, so a page that could not be
 * fetched then stays missing for as long as this worker is in charge. The gap is invisible
 * while there is a network — every navigation succeeds, and nothing consults the shell — and
 * it surfaces at the one moment it cannot be repaired. A navigation that has just succeeded
 * is proof of a working network and a server that answers, which makes it the cheapest moment
 * available to try again.
 *
 * The in-flight flag stops a run of navigations from stacking repairs on top of each other.
 * It is cleared either way, so a repair that fails is retried by the next navigation rather
 * than written off — the same refusal to decide permanently that `precache` makes above.
 */
let repairing = false;

async function repairShell() {
  if (repairing) return;
  repairing = true;
  try {
    const cache = await caches.open(SHELL_CACHE);
    for (const path of SHELL_PAGES) {
      if (!(await cache.match(path))) await precache(cache, path);
    }
  } catch {
    // Nothing useful to do from here. The next navigation tries again.
  } finally {
    repairing = false;
  }
}

/**
 * Take over immediately rather than waiting for every tab to close.
 *
 * The usual argument against this is that a page can find itself talking to a worker newer
 * than the HTML that started it. Here the worker serves bytes and does not shape responses,
 * so the mismatch is inert — and the alternative is a hiker who installs the app, presses
 * download, and gets nothing because the worker controlling the tab is the one that did not
 * exist yet.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(async (cache) => {
        /*
         * One page at a time, and each guarded on its own so that one 404ing after a route
         * rename cannot take the other down with it.
         *
         * Sequential is not a micro-optimisation in reverse — install has no deadline, since
         * nothing waits on it but activation, so running the pages together wins nothing. It
         * loses something, though: these pages share components, and asking a server to
         * render two overlapping module graphs in the same instant is how you discover which
         * of its caches is not reentrant. Next's dev server answers 500, reproducibly, for
         * whichever of the two lands second.
         */
        for (const path of SHELL_PAGES) {
          await precache(cache, path).catch(() => undefined);
        }
      })
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            // Ours and superseded — a bumped version suffix orphans the old cache, and this
            // is where it gets collected. Caches belonging to another app on the same origin
            // are left alone.
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
 * A page request.
 *
 * Network first, because a trail's conditions, reviews and busyness change and a hiker
 * planning at home should see today's. Cache second, which is the download doing its job.
 * The offline page last — a real screen that says what is available rather than the
 * browser's dinosaur.
 */
async function handleNavigation(request) {
  try {
    const response = await fetch(request);
    // Only 2xx is worth keeping: caching a 500 would pin the error until the cache is
    // cleared, and the user has no way to know that is what happened.
    if (response.ok) {
      // A working network, proven rather than assumed. If the shell is short a page, this is
      // the moment to put it back — see `repairShell`.
      void repairShell();

      const cache = await caches.open(PAGE_CACHE);
      // Refresh a page that was explicitly downloaded, but do not silently download every
      // page the user merely visited — storage is theirs to spend, not ours.
      if (await cache.match(request, { ignoreVary: true })) {
        cache.put(request, response.clone()).catch(() => undefined);
      }
    }
    return response;
  } catch {
    const cached = await fromOurCaches(request);
    if (cached) return cached;

    const shell = await caches.open(SHELL_CACHE);
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
 * A build asset.
 *
 * `/_next/static/*` is content-hashed, so a URL that resolves once resolves forever and
 * cache-first is exact rather than merely fast. This is what makes a downloaded page
 * *render* offline: the HTML is worth nothing without the JS and CSS it references, and
 * those are requested by the page rather than by us, so they cannot be listed in advance.
 */
async function handleStatic(request) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) return hit;

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
   * The API is never cached, on purpose.
   *
   * tRPC carries mutations over POST and reads over GET, and a stale read served silently
   * is worse than an honest failure: a review that appears to post, a Lifeline that appears
   * to ping. Offline reading is served by the cached *page*, which is dated and looks it.
   */
  if (sameOrigin && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/_next/image'))) {
    return;
  }

  if (sameOrigin && url.pathname.startsWith('/_next/static/')) {
    event.respondWith(handleStatic(request));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(request));
    return;
  }

  // Everything else — tiles, glyphs, photographs, fonts — is served from cache if we put it
  // there, and otherwise goes to the network untouched. A miss is a plain fetch, so an
  // undownloaded trail behaves exactly as it would with no worker installed.
  event.respondWith(fromOurCaches(request).then((hit) => hit ?? fetch(request)));
});

/** Lets the page ask a freshly-installed worker to take over without a reload. */
self.addEventListener('message', (event) => {
  if (event.data === 'sb:skip-waiting') self.skipWaiting();
});
