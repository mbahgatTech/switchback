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
/**
 * The `/_next/static/*` a *downloaded page* names. Hand-versioned, like the three above and
 * for the same reason — they are part of somebody's download, and a page served from
 * `PAGE_CACHE` without its chunks renders "This page couldn't load". A deploy must not sweep
 * them. `src/offline/caches.ts` has the full argument, including what it costs.
 */
const ASSET_CACHE = 'sb-assets-v1';
/**
 * This build, out of the worker's own URL.
 *
 * `offline/register.tsx` registers `/sw.js?v=<build id>`, and `self.location` inside a worker
 * is the script URL it was registered with — query string and all. That is the only channel
 * into a file outside the module graph, and it does double duty: a changed query is a changed
 * worker URL, so a deploy always installs a new worker rather than waiting on a revalidation.
 *
 * The fallback is for a worker registered by an older build, which had no `v` at all. It is a
 * name like any other and the next activate collects it.
 */
const BUILD_ID = new URL(self.location.href).searchParams.get('v') || 'dev';
/**
 * The shell holds this build's own precache — `SHELL_PAGES` and the chunks those pages name —
 * which the next build replaces wholesale, so it is scoped to the build and collected by
 * `activate`. The four above are the reader's downloads and are versioned by hand: a deploy
 * must not delete the map somebody took onto a hill, nor the code that draws it.
 */
const SHELL_CACHE = `sb-shell-${BUILD_ID}`;
/**
 * The shell name every build before this one used, kept only long enough to empty it.
 *
 * It is not in `OFFLINE_CACHES`, so `activate` collects it — and that is the whole problem.
 * Until this deploy the shell was the flat `sb-shell-v1` and `download.ts`'s `storeShell`
 * harvested a *downloaded page's* chunks into it. So every phone that has downloaded a trail
 * on the live build is holding that trail's `/_next/static/*` in a cache this worker is about
 * to delete, with nothing to put them back: `storeShell` runs only inside `downloadTrail`, and
 * `refreshShell` re-puts SHELL_PAGES rather than trail pages. The download would survive in
 * `PAGE_CACHE` and stop rendering — "This page couldn't load", offline, which is verbatim the
 * failure `ASSET_CACHE` exists to prevent.
 *
 * So `adoptLegacyShell` moves the build assets across before the sweep runs. One release of
 * that is enough — nothing writes this name any more — but it costs a `caches.keys()` on an
 * activate that already calls one, so it stays until somebody can show every install has
 * upgraded, and removing it before then is silent and unrecoverable.
 */
const LEGACY_SHELL_CACHE = 'sb-shell-v1';
const OFFLINE_CACHES = [TILE_CACHE, PAGE_CACHE, MEDIA_CACHE, ASSET_CACHE, SHELL_CACHE];
const OFFLINE_FALLBACK_PATH = '/offline';
const SHELL_PAGES = [OFFLINE_FALLBACK_PATH, '/downloads', '/', '/explore'];
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

/**
 * Rescue a pre-existing download's build assets out of the old flat shell.
 *
 * Before this build, `SHELL_CACHE` was the constant `sb-shell-v1` and it held two unrelated
 * things: this build's precache, and the `/_next/static/*` that `storeShell` harvested for
 * every trail somebody downloaded. Splitting them — a build-scoped shell, a hand-versioned
 * `ASSET_CACHE` — is the right shape, but the split alone strands everything already stored:
 * the old name stops being in `OFFLINE_CACHES` and the sweep below deletes it, chunks and all.
 *
 * Only `/_next/static/*` is carried over. The shell *pages* in there are this-build markup for
 * an older build and are refetched on the first navigation; the chunks cannot be refetched at
 * all, because a downloaded page names content-hashed URLs no current build serves.
 *
 * Everything is guarded and nothing is fatal. A failure here costs one download its offline
 * rendering, which is the status quo it is trying to improve on; throwing would cost the
 * activate, and with it `clients.claim()` and the sweep.
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
      // Content-hashed, so an entry already held is the same bytes. Skipping it keeps a
      // second activate cheap rather than rewriting the whole set.
      if (await assets.match(request, { ignoreVary: true })) continue;
      const response = await old.match(request);
      if (response) await assets.put(request, response);
    } catch {
      // One asset lost, not the pass. The rest of the page's chunks are still worth moving.
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
      refreshShell(request, response);

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
 * Replace a stored shell page with the copy the reader just successfully loaded.
 *
 * `repairShell` above only fills gaps — it asks whether an entry is *missing*. That was the
 * whole story while the shell was viewer-independent. It is not any more: `/` and `/explore`
 * are rendered with the reader's own opening coordinate, taken from the `sb-place` cookie and
 * the edge geo headers, and `install` runs once per worker version. So a reader who installed
 * the app and later corrected their place — searched somewhere on the map, or pressed "Use my
 * location" on `/nearby` — had an offline cold launch pinned to whatever was true at install
 * time, with no path back short of a new worker.
 *
 * A navigation that has just returned 2xx is that path: the bytes are already in hand and they
 * are this reader's, so the store costs nothing but the write. Assets are not re-harvested —
 * `/_next/static/*` is content-hashed and `handleStatic` is caching the live page's chunks as
 * they are requested anyway.
 *
 * Synchronous down to the `clone()`, and that part is not style. A response body can only be
 * read once; cloning after an `await` would race the page consuming the very response we are
 * about to hand it, and the failure would be a navigation that renders nothing on a slow
 * connection and everything on a fast one. So the cheap checks and the clone happen before
 * anything yields, and only the cache write is deferred.
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

  const copy = response.clone();
  caches
    .open(SHELL_CACHE)
    .then((cache) => cache.put(url.pathname, copy))
    // The stored copy stays as it was, which is the state this function improves on.
    .catch(() => undefined);
}

/**
 * A build asset.
 *
 * `/_next/static/*` is content-hashed, so a URL that resolves once resolves forever and
 * cache-first is exact rather than merely fast. This is what makes a downloaded page
 * *render* offline: the HTML is worth nothing without the JS and CSS it references, and
 * those are requested by the page rather than by us, so they cannot be listed in advance.
 *
 * Two caches, in this order and not the other. The shell holds the current build and is the
 * common hit. `ASSET_CACHE` holds the chunks harvested for downloaded pages, which may belong
 * to a build that shipped months ago — a page in `PAGE_CACHE` names hashed URLs no current
 * build serves, so without this second look the download is present, matched, and replaced by
 * React's error boundary the moment the reader is out of signal.
 *
 * A miss is written back to the shell. It is this build asking, by definition: the request
 * came from a live page, not from the cache.
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
