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
 *
 * **Two kinds of version, and the difference matters.** Four of these carry a hand-bumped
 * `-v1`, because what is in them belongs to the reader: tiles, pages, photographs and the
 * build assets those pages name are a download somebody made on purpose, possibly for a trip
 * they are on, and a deploy must not throw them away. Only the shell is versioned off the
 * build id, because it holds this build's own precache and is replaced wholesale by the next
 * one.
 */

/**
 * This build, as a string that changes when the build does.
 *
 * `NEXT_PUBLIC_BUILD_ID` is set in `next.config.ts` — the commit on Vercel and in CI, and a
 * fresh random string for a local production build, because two local builds sharing a name
 * is the exact collision this is here to prevent. Inlined at compile time, so the worker
 * (which is handed the same value as a query parameter) and this module cannot disagree.
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
 * The build assets a *downloaded page* names — its `/_next/static/*` chunks, stylesheets and
 * fonts.
 *
 * Hand-versioned, and this is the one cache name that has already been got wrong once. It was
 * folded into the shell, the shell was then scoped to the build id, and the two together meant
 * every deploy deleted the chunks that pages already sitting in `PAGE_CACHE` refer to. The
 * download survived; it just stopped rendering. A hiker's phone touches wifi, the new worker
 * activates and sweeps `sb-shell-<old build>`, they walk out of signal, and the page they
 * downloaded is served from cache and replaced by "This page couldn't load" — which is
 * verbatim the failure the harvesting below exists to prevent.
 *
 * So the assets that belong to a download live with the download, on a hand-bumped name, and
 * the shell keeps the build id. `download.ts`'s `storeShell` is the only writer.
 *
 * That fixes it going forward and not backwards: chunks harvested by a build that shipped
 * before the split are sitting in `LEGACY_SHELL_CACHE` below, which the split itself makes
 * sweepable. `adoptLegacyShell` in the worker moves them here first.
 *
 * **What that costs, said plainly.** These entries are not collected on deploy, so a phone
 * that has downloaded trails across several builds holds a chunk set per build. Two things
 * bound it: the URLs are content-hashed, so re-downloading a trail on the same build stores
 * nothing new, and `evict.ts` drops the whole cache once the last download is deleted. What is
 * given up is the property the build-scoped name bought — that a bad asset cannot outlive the
 * deploy that removed it. It cannot be had here: a downloaded page's markup names the exact
 * hashed URLs it was built with, and serving that page offline means serving those bytes. The
 * alternative on offer was deleting them, which is not a fix, it is the bug.
 */
export const ASSET_CACHE = 'sb-assets-v1';

/**
 * The application shell: the offline page, and the hashed assets it needs to render.
 *
 * Named after the build, so every deploy starts a clean one and `activate` collects the last.
 * What is in here is this build's own precache — `SHELL_PAGES` and the chunks those pages
 * name — which the next build replaces wholesale, and which nothing that is not the current
 * build ever asks for. That is what makes collecting it safe, and it is exactly the property
 * `ASSET_CACHE` above does not have.
 *
 * The cost is one cold shell per deploy: the first navigation after an upgrade refetches the
 * chunks. They are on the network at that moment by definition — the reader is online, or
 * they would still be on the old worker.
 */
export const SHELL_CACHE = `sb-shell-${BUILD_ID}`;

/**
 * The shell name every build before the split used. Not a cache anything writes — a name the
 * worker has to empty once, on the way to deleting it.
 *
 * `ASSET_CACHE` above describes the bug as a thing that was caught. It was caught late: the
 * flat `sb-shell-v1` shipped, and `storeShell` wrote downloaded pages' chunks into it, so every
 * phone holding a download made on the live build has those chunks under this name. Introducing
 * the build-scoped shell drops it out of `OFFLINE_CACHES`, and `activate` collects anything
 * under the prefix that is not in that list — which would delete exactly the entries this whole
 * split exists to protect, on the first upgrade, for the readers who had already paid for them.
 *
 * So the worker's `adoptLegacyShell` copies the `/_next/static/*` across before the sweep. It is
 * declared here for the same reason as everything else in this file: `test/offline-caches.test.ts`
 * reads the worker as text and fails the build if the two spellings drift.
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
 * Pages kept from the moment the worker installs, before anything is downloaded.
 *
 * Five, and each earns it. `/` is the manifest's `start_url`, so it is what an installed app
 * opens on a cold launch — and an installed app is opened on a cold launch precisely when
 * there is no signal. Without it here the home-screen icon leads straight to the offline
 * fallback, which is the one screen the download was bought to avoid.
 *
 * `/explore` is the same argument aimed backwards. It was the `start_url` until the map moved
 * to `/`, and an installed app keeps whatever start URL it captured: an iOS home-screen
 * bookmark never re-reads the manifest at all, and a Chrome WebAPK update lags by up to a
 * month. `app/manifest.ts` sets `id` so those installs at least *accept* the new manifest
 * rather than being orphaned by it, but accepting it is not the same as having applied it, so
 * for as long as the alias route exists the address they cold-launch has to be in this list.
 * It is a cheap server shell and `precache` is guarded per path, so the cost is one fetch at
 * install. Dropping it is a decision to write off pre-migration installs, and should be taken
 * as one rather than as a tidy-up.
 *
 * `/` used to be viewer-independent, and this comment used to say that if it ever centred the
 * map from `viewerPlace()` server-side the entry would have to go. It now does, and the entry
 * stays — so here is the trade, rather than a condition quietly left broken. What is stored is
 * still the instrument and not a stale list of somebody else's trails; what it now also carries
 * is one opening coordinate. It is *that reader's* coordinate, because the worker precaches
 * with `credentials: 'same-origin'` and each install fetches its own copy — not one reader's
 * city shared out to everyone. And it only ever surfaces offline: `handleNavigation` is
 * network-first, so anyone with signal gets a freshly derived centre and never reads this copy.
 * The residual defect is any reader who corrects their place and then goes offline — searching
 * a place on the map, or pressing "Use my location" on `/nearby`, writes the cookie that this
 * copy was rendered without. `handleNavigation` re-puts a shell page whenever an online
 * navigation to it succeeds, so the correction lands the next time they open that page with
 * signal rather than at the next worker install; before that it was install-time only, which
 * is to say never in practice.
 *
 * The fallback is where every unreachable navigation lands. The storage manager is where
 * that fallback sends you — and it reads its list from IndexedDB, so it is fully truthful
 * offline; without it here, "Manage downloads" leads back to the screen it was pressed
 * from, which is the kind of small dishonesty that makes a hiker stop trusting the rest.
 * `/offline` and `/downloads` take no server input at all, so one stored copy is right for
 * everybody; `/` and `/explore` are the two that are rendered per reader, which is the whole
 * of the paragraph above.
 *
 * `/record` is the fifth, and it is the one page here whose whole point is to work with no
 * network at all — a hike is recorded on a ridge, not at a desk. It is auth-gated, so its
 * stored copy is the signed-in reader's own; that is the same per-reader trade already argued
 * for `/` two paragraphs up, and it holds for the same reason. The redirect is evaluated once,
 * on the server, at the moment the copy is fetched — offline there is no server to run it, and
 * the session cookie survives with no network, so what is served is the recorder as it was
 * rendered for the reader who installed it. The copy is only ever stored when the response was
 * *not* a redirect (see `precache` in `public/sw.js`): a signed-out install would otherwise
 * follow the 307 to `/signin` and cache a sign-in form under the key `/record`, which is worse
 * than a missing entry because it looks like it works. A missing entry is the correct outcome
 * there — `repairShell` retries on every successful navigation, and `refreshShell` puts the
 * real page in the first time that reader opens `/record` with a session.
 *
 * What used to be named here as a residual leak — on a shared device the stored `/record`
 * carries the last signed-in reader's units, default visibility, and the name and start time of
 * any recording they left open — is no longer residual and no longer a leak. `offline/
 * handover.ts` deletes the reader-specific entries of this cache, and every other `sb-` cache
 * whole, the moment the account on the browser changes, so a stored page outlives its reader
 * only until the next person signs in. The same argument covers `/` and its opening coordinate,
 * and the downloaded trail pages, which carry the reader's own hikes on those trails. Which
 * entries those are is `READER_SHELL_PAGES` below.
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
 *
 * A subset of `SHELL_PAGES`, and the difference is the whole point. `/` and `/explore` carry
 * the reader's own opening coordinate; `/record` is auth-gated and carries their units, their
 * default visibility, and the name and start time of any recording they left open. Those three
 * belong to the person who fetched them and go when that person does.
 *
 * `/offline` and `/downloads` take no server input at all — one stored copy is right for
 * everybody, as the note above says — and `/_next/static/*` is content-hashed build output.
 * `offline/handover.ts` used to delete `SHELL_CACHE` whole rather than these three entries,
 * which took the fallback page and every harvested chunk with them. Nothing refills that
 * promptly: `install` runs once per worker version, and `repairShell`/`refreshShell` only run
 * from a *navigation*, which App Router client routing never performs. So a hiker who signed
 * in at the trailhead and then lost signal got a plain-text 503 for `/`, `/downloads` and
 * `/record` — the last of which exists to work with no network at all. Nothing in those
 * entries was ever the departing reader's, so nothing was bought by deleting them.
 *
 * Not shared with the worker: the worker never runs a handover, so the two lists do not have
 * to agree and `test/offline-caches.test.ts` only checks that these are pages the shell
 * actually holds.
 */
export const READER_SHELL_PAGES = ['/', '/explore', '/record'] as const;

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
