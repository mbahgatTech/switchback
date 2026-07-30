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
 * **Two kinds of version, and the difference matters.** Three of these carry a hand-bumped
 * `-v1`, because what is in them belongs to the reader: tiles, pages and photographs are a
 * download somebody made on purpose, possibly for a trip they are on, and a deploy must not
 * throw them away. The shell is the opposite — it holds `/_next/static/*`, which is this
 * build's code, so it is versioned off the build id and collected automatically when a new
 * build takes over. Left on a fixed name it never was collected, which is how a compromised
 * script could have outlived the deploy that removed it.
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
 * The application shell: the offline page, and the hashed assets it needs to render.
 *
 * Named after the build, so every deploy starts a clean one and `activate` collects the last.
 * Content-hashed URLs make cache-first exact, which is what lets a downloaded page render
 * offline — and also what made a bad asset permanent, since a URL that resolves once was
 * never fetched again. Scoping the cache to the build is what puts a floor under that.
 *
 * The cost is one cold shell per deploy: the first navigation after an upgrade refetches the
 * chunks. They are on the network at that moment by definition — the reader is online, or
 * they would still be on the old worker.
 */
export const SHELL_CACHE = `sb-shell-${BUILD_ID}`;

export const OFFLINE_CACHES = [TILE_CACHE, PAGE_CACHE, MEDIA_CACHE, SHELL_CACHE] as const;

/** Where the worker sends a navigation it cannot satisfy from either network or cache. */
export const OFFLINE_FALLBACK_PATH = '/offline';

/**
 * Pages kept from the moment the worker installs, before anything is downloaded.
 *
 * Four, and each earns it. `/` is the manifest's `start_url`, so it is what an installed app
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
 */
export const SHELL_PAGES = [OFFLINE_FALLBACK_PATH, '/downloads', '/', '/explore'] as const;

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
