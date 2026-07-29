import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';

/**
 * Photographs that never arrive.
 *
 * Almost none of the photograph URLs in this product are ours, and none of them are
 * permanent. Commons files are deleted while our cache still holds the link for up to thirty
 * days, Mapillary serves from a CDN that rotates, an R2 object can outlive or predecease its
 * row when an upload is interrupted, and an avatar belongs to whichever identity provider
 * signed the hiker in. Every one of those ends the same way in a browser: a torn-page glyph
 * and the alt text, drawn by the user agent in its own styling, inside a slot that was
 * composed down to the hairline.
 *
 * The suite blocks `upload.wikimedia.org` specifically rather than every image request. That
 * host is where the seeded photographs actually live, so a 404 from it is the real failure
 * rather than a synthetic one — and leaving every other host alone means MapLibre's sprites
 * and glyphs are untouched, so a failure here is about photographs and nothing else.
 */

/** A trail whose photographs all come from Commons. Twelve frames, one gallery. */
const PHOTOGRAPHED = 'boston-basin-trail';

/*
 * No service worker for this file.
 *
 * `packages`-wide the worker is part of the product and the offline spec exercises it, which
 * is why the config allows it. Here it is a measuring instrument that changes what it
 * measures. `apps/web/public/sw.js` ends with `fetch(request)` for anything it has not
 * cached — photographs included — and a fetch issued from inside a worker is not seen by
 * `page.route`. So whether a photograph is intercepted depends on whether the worker had
 * finished installing and claimed the page by the time that image was requested, and it
 * installs on `window.load`, which lands between the lazy strip below the fold and the click
 * that opens the lightbox. Against a production build that is exactly what happened: the
 * strip was blocked and the full-size frame sailed through, so the panel had a real
 * photograph to show and the spec failed on the absence of an error it had prevented.
 *
 * Blocking registration makes the interception total and the spec about the thing it names.
 */
test.use({ serviceWorkers: 'block' });

/** Every Commons file, gone — which is exactly how a deletion there reaches us. */
async function deleteTheFiles(page: Page): Promise<void> {
  await page.route('**://upload.wikimedia.org/**', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'Gone' }),
  );
}

/**
 * Elements the browser has finished loading and has no pixels for.
 *
 * `complete && naturalWidth === 0` is the definition of the broken-image box, and it is worth
 * asserting in exactly those terms: an image still in flight is `complete === false` and is
 * not a failure, so this cannot go green by running early or red by running fast.
 */
async function brokenImages(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('img')]
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.currentSrc || img.src),
  );
}

/**
 * Open the trail, scroll the strip into view, and wait for the plates.
 *
 * The scroll is not stage-setting. The strip is `loading="lazy"` and sits well below the
 * fold, so without it the browser never asks for a single photograph, nothing fails, and a
 * spec about failure goes green having proved nothing.
 */
async function openGalleryWithNothingInIt(page: Page): Promise<void> {
  await deleteTheFiles(page);
  await page.goto(`/trails/${PHOTOGRAPHED}`, { waitUntil: 'domcontentloaded' });

  // The gallery is on the page and believes it has photographs — the failure under test is
  // the file going missing, not the record. If this trail ever loses its rows the spec
  // should fail here, loudly, rather than pass by having nothing to draw.
  const heading = page.getByRole('heading', { name: 'Photographs' });
  await expect(heading).toBeVisible();
  await expect(page.getByText(/\d+ frames/u)).toBeVisible();
  await heading.scrollIntoViewIfNeeded();

  await expect(page.locator('[data-photograph="missing"]').first()).toBeVisible();
}

test.describe('Photographs', () => {
  test('a deleted photograph leaves a plate, not a broken image', async ({ page }) => {
    await openGalleryWithNothingInIt(page);

    /*
     * No `<img>` survives anywhere on the page. Not "the images look right" — the elements are
     * gone, replaced by the plate, and an element that does not exist is the only state in
     * which a browser has nothing to draw its glyph into.
     */
    expect(await brokenImages(page)).toEqual([]);
  });

  test('the lightbox says what happened rather than opening on nothing', async ({ page }) => {
    await openGalleryWithNothingInIt(page);

    // The frame that is holding a plate, rather than the first button on the page — the trail
    // page has several other lists of controls and which one comes first is not this spec's
    // business.
    await page
      .locator('button', { has: page.locator('[data-photograph="missing"]') })
      .first()
      .click();

    // Somebody opened a dialog to look at one specific picture. A silent plate at 1080 px is
    // a dead end; the panel is the one place in this fix that owes the reader words.
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('No photograph')).toBeVisible();
    await expect(dialog.getByText(/didn’t load/u)).toBeVisible();

    expect(await brokenImages(page)).toEqual([]);
  });
});
