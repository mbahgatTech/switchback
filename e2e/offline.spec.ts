import { VESPER, expect, test } from './fixtures';

/**
 * Taking a trail offline, and then taking the network away.
 *
 * This is the last line of the plan's verification and the only one that cannot be faked:
 * *"download offline → network killed → trail still loads."* Everything else in this suite
 * would still pass against a product that merely had a button labelled "Take offline".
 *
 * The download is done for real — the corridor is planned, the tiles are fetched from the
 * keyless hosts the relief basemap actually uses, and the page HTML is stored — and then
 * Playwright cuts the context's network at the socket. Nothing is stubbed, because a stub
 * would be asserting that our own cache-writing code writes to our own cache, which is not
 * the claim. The claim is that Chromium, offline, serves a page it has never re-requested.
 */

/**
 * The cache the service worker keeps map tiles in.
 *
 * Named here rather than imported because `sw.js` is a plain script served from `public/`
 * and has no module boundary to import from. If the two ever disagree, this test fails with
 * "no tiles were stored", which is the right failure — a renamed cache is a download that
 * quietly stops working.
 */
const TILE_CACHE = 'sb-tiles-v1';

test.describe('Offline', () => {
  test('a downloaded trail still opens with the network cut', async ({ page, context }) => {
    // Real tiles over a real network, on a dev server that is compiling routes underneath.
    // Slow is expected here; the assertions are all specific, so slow never reads as passing.
    test.setTimeout(300_000);

    await page.goto(`/trails/${VESPER.slug}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(VESPER.name);

    /*
     * Register the worker by hand.
     *
     * `RegisterServiceWorker` returns early unless `NODE_ENV === 'production'`, deliberately:
     * a worker that caches `/_next/static` in front of a dev server which rebuilds those
     * files on every keystroke is the worst debugging experience this stack can produce. The
     * test opts in for itself, in a browser context that is thrown away afterwards.
     */
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    });

    // `ready` says installed; `controller` says it is in front of *this* page, which is what
    // the reload below depends on. `sw.js` calls `clients.claim()` on activate to get there.
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
        timeout: 60_000,
      })
      .toBe(true);

    // The control says what it will cost before it costs it. That estimate existing at all
    // means the corridor was planned rather than guessed.
    const take = page.getByRole('button', { name: /^Take offline/ });
    await expect(take).toBeVisible({ timeout: 60_000 });
    await take.click();

    // Planning → page → tiles → media → saving. The only fatal step is the page itself; a
    // terrarium tile 404ing over a ridge is ordinary and non-fatal by design.
    await expect(page.getByText(/^Offline ·/)).toBeVisible({ timeout: 240_000 });

    /*
     * Tiles actually landed in Cache Storage.
     *
     * "Offline" that means "offline until you zoom in past the ridge" is the exact failure
     * this feature exists to prevent, and the size in the label alone would not catch it —
     * the page HTML has a size too.
     */
    const tiles = await page.evaluate(async (cacheName: string) => {
      const cache = await caches.open(cacheName);
      return (await cache.keys()).length;
    }, TILE_CACHE);
    expect(tiles).toBeGreaterThan(0);

    // ── The part that matters ────────────────────────────────────────────────────────
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });

    /*
     * The trail is still there.
     *
     * Served by `handleNavigation` falling through to `fromOurCaches` after `fetch` threw.
     * The heading is server-rendered, so this holds even though the dev build's chunk URLs
     * contain characters `STATIC_ASSET_PATTERN` does not match and therefore never got
     * stored — offline in development renders without hydrating. In a production build the
     * hashed chunks are stored alongside the page and it hydrates too; the assertion below
     * is the one that is true of both, which is why it is the one being made.
     */
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(VESPER.name);

    // And the numbers a hiker in a car park with no signal is actually looking at.
    for (const label of ['Length', 'Ascent', 'High point']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    // ── Back on the network, and give the storage back ───────────────────────────────
    /*
     * A fresh page rather than a reload of this one.
     *
     * The document currently on screen was served by the worker out of Cache Storage, and
     * reloading it in the same beat as the network returning races Chromium's own teardown
     * of the requests that failed while offline — `net::ERR_ABORTED`, reliably, and about
     * the browser rather than about us. A new page in the same context shares the caches,
     * the worker and the storage, which is all this last step needs.
     */
    await context.setOffline(false);
    const fresh = await context.newPage();
    await fresh.goto(`/trails/${VESPER.slug}`, { waitUntil: 'domcontentloaded' });

    await fresh.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(fresh.getByRole('button', { name: /^Take offline/ })).toBeVisible({
      timeout: 60_000,
    });
    await fresh.close();
  });

  test('a trail that was never downloaded says so rather than failing blank', async ({
    page,
    context,
  }) => {
    test.setTimeout(180_000);

    await page.goto('/downloads', { waitUntil: 'domcontentloaded' });
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    });
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
        timeout: 60_000,
      })
      .toBe(true);

    await context.setOffline(true);
    await page.goto('/trails/mount-dickerman-trail', { waitUntil: 'domcontentloaded' });

    /*
     * `/offline` is precached at install precisely for this: a real screen that says what is
     * available, rather than the browser's dinosaur. The distinction is the whole reason the
     * shell cache exists, and it only shows up in a test that goes somewhere it did not
     * download. Both assertions are on server-rendered markup, because this page's own
     * doctrine is that it has to work with its JavaScript missing.
     */
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This page was not downloaded',
    );
    await expect(page.getByRole('link', { name: 'Manage downloads' })).toBeVisible();

    await context.setOffline(false);
  });
});
