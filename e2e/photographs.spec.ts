import { PHOTOGRAPHED, expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Photographs that never arrive. Almost no photograph URL here is ours or permanent, and every
 * way they die ends the same in a browser: a torn-page glyph in a slot composed to the hairline.
 * Only `upload.wikimedia.org` is blocked — where the seeded photographs live — so MapLibre's
 * sprites and glyphs are untouched and a failure here is about photographs and nothing else.
 */

/*
 * No service worker: `sw.js` falls through to `fetch(request)` for anything uncached, and a
 * fetch issued from inside a worker is invisible to `page.route`. The worker installs on
 * `window.load` — between the lazy strip and the lightbox click — so without this, interception
 * is partial and the spec fails on the absence of an error it prevented.
 */
test.use({ serviceWorkers: 'block' });

/** Every Commons file, gone — which is exactly how a deletion there reaches us. */
async function deleteTheFiles(page: Page): Promise<void> {
  await page.route('**://upload.wikimedia.org/**', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Gone' }),
  );
}

/**
 * Elements the browser has finished loading and has no pixels for. `complete && naturalWidth
 * === 0` is the broken-image box exactly: an image still in flight is `complete === false`, so
 * this cannot go green by running early or red by running fast.
 */
async function brokenImages(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.src),
  );
}

/**
 * Open the trail, scroll the strip into view, and wait for the plates. The scroll is not
 * stage-setting: the strip is `loading="lazy"` and below the fold, so without it the browser
 * never asks for a photograph and a spec about failure goes green having proved nothing.
 */
async function openGalleryWithNothingInIt(page: Page): Promise<void> {
  await deleteTheFiles(page);
  await page.goto(`/trails/${PHOTOGRAPHED.slug}`, { waitUntil: 'domcontentloaded' });

  // The failure under test is the file going missing, not the record. If this trail ever
  // loses its rows the spec should fail here rather than pass by having nothing to draw.
  const heading = page.getByRole('heading', { name: 'Photographs' });
  await expect(heading).toBeVisible();
  await expect(page.getByText(/\d+ frames/u)).toBeVisible();
  await heading.scrollIntoViewIfNeeded();

  await expect(page.locator('[data-photograph="missing"]').first()).toBeVisible();
}

test.describe('Photographs', () => {
  test('a deleted photograph leaves a plate, not a broken image', async ({ page }) => {
    await openGalleryWithNothingInIt(page);

    // The elements are gone, replaced by the plate — an element that does not exist is the
    // only state in which a browser has nothing to draw its glyph into.
    expect(await brokenImages(page)).toEqual([]);
  });

  test('the lightbox says what happened rather than opening on nothing', async ({ page }) => {
    await openGalleryWithNothingInIt(page);

    // The frame holding a plate, not the first button on the page: the trail page has several
    // other lists of controls.
    await page
      .locator('button', { has: page.locator('[data-photograph="missing"]') })
      .first()
      .click();

    // A silent plate at 1080 px is a dead end; the panel is the one place that owes words.
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('No photograph')).toBeVisible();
    await expect(dialog.getByText(/didn’t load/u)).toBeVisible();

    expect(await brokenImages(page)).toEqual([]);
  });
});
