import { VESPER, expect, test } from './fixtures';

/**
 * Download a trail, then cut the network at the socket. Nothing is stubbed: a stub would only
 * assert that our cache-writing code writes to our own cache. The claim is that Chromium,
 * offline, serves a page it has never re-requested.
 */

/**
 * The cache `sw.js` keeps map tiles in. Named rather than imported — `sw.js` is a plain script
 * served from `public/` with no module boundary. If the two disagree this fails with "no tiles
 * were stored", which is the right failure: a renamed cache is a download that stops working.
 */
const TILE_CACHE = 'sb-tiles-v1';

test.describe('Offline', () => {
  test('a downloaded trail still opens with the network cut', async ({ page, context }) => {
    // Real tiles over a real network, on a dev server compiling routes underneath.
    test.setTimeout(300_000);

    await page.goto(`/trails/${VESPER.slug}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(VESPER.name);

    /*
     * Registered by hand: `RegisterServiceWorker` returns early unless production, because a
     * worker caching `/_next/static` in front of a dev server that rebuilds those files on
     * every keystroke is the worst debugging experience this stack can produce.
     */
    await page.evaluate(async () => {
      await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
    });

    // `ready` says installed; `controller` says it is in front of *this* page, which is what
    // the reload below depends on.
    await expect
      .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), {
        timeout: 60_000,
      })
      .toBe(true);

    // The estimate existing at all means the corridor was planned rather than guessed.
    const take = page.getByRole('button', { name: /^Take offline/ });
    await expect(take).toBeVisible({ timeout: 60_000 });
    await take.click();

    // Planning → page → tiles → media → saving. Only the page step is fatal; a terrarium tile
    // 404ing over a ridge is ordinary and non-fatal by design.
    await expect(page.getByText(/^Offline ·/)).toBeVisible({ timeout: 240_000 });

    // Tiles actually landed in Cache Storage. "Offline until you zoom past the ridge" is the
    // failure this feature exists to prevent, and the size in the label would not catch it.
    const tiles = await page.evaluate(async (cacheName: string) => {
      const cache = await caches.open(cacheName);
      return (await cache.keys()).length;
    }, TILE_CACHE);
    expect(tiles).toBeGreaterThan(0);

    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded' });

    /*
     * Served by `handleNavigation` falling through to `fromOurCaches` after `fetch` threw.
     * The heading is server-rendered, so this holds in dev even though the dev build's chunk
     * URLs never matched `STATIC_ASSET_PATTERN` and so never got stored — offline in
     * development renders without hydrating. This assertion is true of both builds.
     */
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(VESPER.name);

    // And the numbers a hiker in a car park with no signal is actually looking at.
    for (const label of ['Length', 'Ascent', 'High point']) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }

    /*
     * A fresh page, not a reload: the document on screen was served out of Cache Storage, and
     * reloading it in the same beat as the network returning races Chromium's teardown of the
     * requests that failed while offline (`net::ERR_ABORTED`, reliably). A new page in the
     * same context shares the caches, the worker and the storage.
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
    // A slug the database must NOT hold: seeding or ingesting it would delete the subject of this
    // test, which is what a browser gets for a trail that was never downloaded.
    // not-in-suite: exempt from the declaration test/e2e-trail-sources.test.ts holds trails to.
    await page.goto('/trails/mount-dickerman-trail', { waitUntil: 'domcontentloaded' });

    /*
     * `/offline` is precached at install precisely for this: a real screen saying what is
     * available rather than the browser's dinosaur. Both assertions are on server-rendered
     * markup, because this page's own doctrine is that it works with its JavaScript missing.
     */
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'This page was not downloaded',
    );
    await expect(page.getByRole('link', { name: 'Manage downloads' })).toBeVisible();

    await context.setOffline(false);
  });
});
