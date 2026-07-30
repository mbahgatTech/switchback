import {
  VESPER,
  expect,
  expectTrailsLanded,
  openSheet,
  project,
  readCamera,
  sheetOf,
  test,
  trailBySlug,
} from './fixtures';
import type { Locator, Page } from '@playwright/test';

/**
 * Explore — the sheet, the index, and getting from one to the other.
 *
 * This file exists because of a specific report: *"the trails are never fetched and
 * landed… when selecting a trail i expect to see the trail and a way to navigate to its
 * full page."* Both halves are asserted here, and the first one is asserted against the
 * map's data source rather than against the component's props, because the props were never
 * the thing that was broken.
 */

test.describe('Explore', () => {
  test('the sheet draws, and the trails land on it', async ({ page }) => {
    const sheet = await openSheet(page);

    // A canvas at all. MapLibre throws on construction without a WebGL2 context, and the
    // resulting page looks like an ordinary empty state rather than a failure.
    await expect(sheet.locator('canvas.maplibregl-canvas')).toBeVisible();

    const landed = await expectTrailsLanded(sheet);
    expect(landed).toBeGreaterThan(0);

    // And the index agrees with the canvas. Two readings of the same query taken from
    // opposite ends of the render: if these ever disagree, one of them is lying.
    await expect(page.locator('li[data-trail-id]')).toHaveCount(landed);
  });

  test('the index carries the trails the reader came for', async ({ page }) => {
    await openSheet(page);
    await expectTrailsLanded(sheetOf(page));

    await expect(page.getByRole('heading', { level: 3, name: VESPER.name })).toBeVisible();
  });

  test('picking an entry frames it, and the card opens the trail', async ({ page }) => {
    const sheet = await openSheet(page);
    await expectTrailsLanded(sheet);

    const row = page.locator('li[data-trail-id]').first();
    const name = (await row.getByRole('heading', { level: 3 }).innerText()).trim();
    const href = await row.getByRole('link', { name: `Open ${name}` }).getAttribute('href');

    // The reader's own instruction: *"when in explore and click on a trail default behavior
    // should be Frame not other way around."* The entry is the frame control — the whole
    // card — and it puts the trail on the sheet without leaving the page.
    await row.getByRole('button', { name: `Show ${name} on the map` }).click();

    const card = selectedCard(page);
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { level: 2 })).toHaveText(name);

    // And going to the trail is the second, named decision — *"they can click on a trail
    // then open trail if they wanna go to that page."*
    await card.getByRole('link', { name: 'Open trail' }).click();
    await page.waitForURL(`**${href ?? ''}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  });

  test('an entry carries its own way to the trail page', async ({ page }) => {
    const sheet = await openSheet(page);
    await expectTrailsLanded(sheet);

    const row = page.locator('li[data-trail-id]').first();
    const name = (await row.getByRole('heading', { level: 3 }).innerText()).trim();
    const open = row.getByRole('link', { name: `Open ${name}` });

    // Drawn at rest, not on hover. Its predecessor appeared on `:hover` only, which meant
    // there was no way to reach it at all on a touchscreen.
    await expect(open).toBeVisible();
    await open.click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  });

  test('the pick card stands clear of the map chrome', async ({ page }) => {
    const sheet = await openSheet(page);
    await expectTrailsLanded(sheet);

    const row = page.locator('li[data-trail-id]').first();
    const name = (await row.getByRole('heading', { level: 3 }).innerText()).trim();
    await row.getByRole('button', { name: `Show ${name} on the map` }).click();

    const card = selectedCard(page);
    await expect(card).toBeVisible();
    const over = await card.boundingBox();
    if (!over) throw new Error('the pick card is visible but has no box');

    /*
     * The reported bug, in a screenshot: the card printed straight across the "1000 ft"
     * scale bar. Both of MapLibre's bottom corners are checked, because the card is
     * full-width below `md` and reaches the zoom control as well.
     */
    for (const chrome of ['.maplibregl-ctrl-scale', '.maplibregl-ctrl-bottom-right']) {
      const under = await sheet.locator(chrome).first().boundingBox();
      if (!under) throw new Error(`${chrome} is not drawn on the sheet`);
      expect(overlaps(over, under), `the card covers ${chrome}`).toBe(false);
    }

    /*
     * The licence line is the more serious half — ODbL requires it to be legible — and it
     * is deliberately *not* map chrome: it sits in the neatline above the sheet, where a
     * basemap swap or a screenshot cannot lose it. Asserted here rather than as an overlap,
     * because "no card can ever reach it" is the property that decision bought.
     */
    await expect(page.getByRole('link', { name: '© OpenStreetMap contributors' })).toBeVisible();
  });

  test('clicking a trail on the sheet selects it', async ({ page, request }) => {
    const sheet = await openSheet(page);
    await expectTrailsLanded(sheet);

    const trail = await trailBySlug(request, VESPER.slug);
    await clickTrailLine(page, sheet, VESPER.slug);

    const card = selectedCard(page);
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { level: 2 })).toHaveText(trail.name);

    // Clearing puts the sheet back, which is the other half of a selection being real.
    await card.getByRole('button', { name: 'Clear selection' }).click();
    await expect(card).toBeHidden();
  });

  test('a shared link opens on its trail', async ({ page, request }) => {
    const trail = await trailBySlug(request, VESPER.slug);
    const sheet = await openSheet(page, `/?${VESPER.view}&trail=${trail.id}`);
    await expectTrailsLanded(sheet);

    // No click anywhere. A link someone sent should arrive with the trail already picked.
    const card = selectedCard(page);
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { level: 2 })).toHaveText(trail.name);
  });

  test('searching a place moves the sheet to it', async ({ page }) => {
    // Deliberately from a long way off — this is the reader's own complaint, that searching
    // "Vesper peak" got them nothing. The `map=` here is Snowdon, an explicit view rather than
    // any default: the sheet is parked on another continent so the search has somewhere to
    // travel from, and the assertion is that it arrives. Where a bare `/` opens is a separate
    // question (the reader's own place, else Seattle — `apps/web/src/lib/place.ts`) and this
    // test is insulated from it, since a URL view outranks everything.
    const sheet = await openSheet(page, '/?map=12/53.0685/-4.0763');

    await page.getByPlaceholder('Search trails, or a place').fill('Vesper Peak');

    const places = page.getByRole('listbox', { name: 'Places' });
    await expect(places).toBeVisible();

    // There are two Vesper Peaks in OSM — one in Alaska, one in Washington. The suggestion
    // carrying its county and state is the whole reason the list shows context at all.
    const wanted = places.getByRole('option').filter({ hasText: 'Washington' }).first();
    await expect(wanted).toBeVisible();
    await wanted.click();

    // The sheet moved, and it moved to somewhere with trails on it.
    await expect
      .poll(() => new URL(page.url()).searchParams.get('map'), { timeout: 30_000 })
      .not.toBe('12/53.0685/-4.0763');
    await expectTrailsLanded(sheet);
    await expect(page.getByRole('heading', { level: 3, name: VESPER.name })).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The pick card that appears over the sheet when a trail is selected. */
function selectedCard(page: Page): Locator {
  return page.locator('aside[aria-label="Selected trail"]');
}

/** Do two boxes share any pixel? Edge-to-edge touching does not count as covering. */
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Click a trail's line where it is drawn on the canvas.
 *
 * There is no element to target — the line is pixels in a WebGL context — so the test does
 * what MapLibre does: projects the trail's own coordinates through Web Mercator using the
 * camera the map published to the address bar, and clicks the result.
 *
 * Several vertices are tried in turn, and that is not flake-hiding. A LineString runs off
 * the edge of the viewport at both ends, doubles back over itself, and passes under the
 * sheet's own controls; a given vertex being unclickable is an ordinary fact about a map,
 * not a defect. What would be a defect is *no* vertex working, and that still fails.
 */
async function clickTrailLine(page: Page, sheet: Locator, slug: string): Promise<void> {
  const detail = await page.evaluate(async (trailSlug: string) => {
    const input = encodeURIComponent(JSON.stringify({ json: { slug: trailSlug } }));
    const response = await fetch(`/api/trpc/trails.bySlug?input=${input}`);
    const body = (await response.json()) as {
      result: { data: { json: { geometry: { coordinates: [number, number][] } } } };
    };
    return body.result.data.json;
  }, slug);

  const box = await sheet.boundingBox();
  if (!box) throw new Error('The map region has no box — it never mounted.');
  const camera = readCamera(page.url());

  // Every vertex that lands comfortably inside the container, ordered from the middle of
  // the line outwards: the middle of a trail is the part least likely to be under a control.
  const inside = detail.geometry.coordinates
    .map(([lng, lat]) => project(camera, { lng, lat }, box))
    .filter((p) => p.x > 60 && p.y > 60 && p.x < box.width - 60 && p.y < box.height - 60);
  if (inside.length === 0) {
    throw new Error(`No part of ${slug} is on screen at ${JSON.stringify(camera)}.`);
  }
  const middle = Math.floor(inside.length / 2);
  const order = inside
    .map((point, index) => ({ point, distance: Math.abs(index - middle) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 6);

  const card = selectedCard(page);
  for (const { point } of order) {
    await page.mouse.click(box.x + point.x, box.y + point.y);
    if (await card.isVisible()) return;
    // The map answers a click synchronously off its own rendered features, so a short wait
    // is enough to tell a miss from a slow hit.
    await page.waitForTimeout(400);
    if (await card.isVisible()) return;
  }

  throw new Error(`Clicked ${String(order.length)} points along ${slug} and nothing selected.`);
}
