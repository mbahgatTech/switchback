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
 * Explore — the sheet, the index, and getting from one to the other. Trails landing is
 * asserted against the map's data source, not the component's props: the props were never the
 * thing that broke.
 */

test.describe('Explore', () => {
  test('the sheet draws, and the trails land on it', async ({ page }) => {
    const sheet = await openSheet(page);

    // A canvas at all: MapLibre throws on construction without a WebGL2 context, and the
    // resulting page looks like an ordinary empty state rather than a failure.
    await expect(sheet.locator('canvas.maplibregl-canvas')).toBeVisible();

    const landed = await expectTrailsLanded(sheet);
    expect(landed).toBeGreaterThan(0);

    // Two readings of the same query from opposite ends of the render: if these ever
    // disagree, one of them is lying.
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

    // The whole card is the frame control: picking puts the trail on the sheet without
    // leaving the page. Opening the trail is a second, separately named decision.
    await row.getByRole('button', { name: `Show ${name} on the map` }).click();

    const card = selectedCard(page);
    await expect(card).toBeVisible();
    await expect(card.getByRole('heading', { level: 2 })).toHaveText(name);

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

    // Drawn at rest, not on hover: its predecessor appeared on `:hover` only, so there was
    // no way to reach it on a touchscreen.
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

    /*
     * Every box in one evaluation, because the clearance is a *layout* the card is responsible
     * for producing: read one box per round trip and the card's can be measured before the
     * chrome has moved out of its way and the chrome's after, reporting a clearance that was
     * never on screen at once. Both bottom corners, because the card is full-width below `md`
     * and reaches the zoom control as well as the scale bar.
     */
    const CHROME = ['.maplibregl-ctrl-scale', '.maplibregl-ctrl-bottom-right'];
    const boxes = await page.evaluate((chrome) => {
      const rect = (element: Element | null | undefined) => {
        if (!element) return null;
        const { x, y, width, height } = element.getBoundingClientRect();
        return { x, y, width, height };
      };
      const pane = document.querySelector('[aria-label="Map of trails in the current view"]');
      return {
        card: rect(document.querySelector('aside[aria-label="Selected trail"]')),
        under: chrome.map((selector) => ({ selector, box: rect(pane?.querySelector(selector)) })),
      };
    }, CHROME);

    if (!boxes.card) throw new Error('the pick card is visible but has no box');

    for (const { selector, box } of boxes.under) {
      if (!box) throw new Error(`${selector} is not drawn on the sheet`);
      expect(overlaps(boxes.card, box), `the card covers ${selector}`).toBe(false);
    }

    /*
     * The licence line is deliberately *not* map chrome: it sits in the neatline above the
     * sheet, where a basemap swap or a screenshot cannot lose it. Asserted as presence rather
     * than as an overlap, because "no card can ever reach it" is what that decision bought.
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
    // Parked on another continent (Snowdon) so the search has somewhere to travel from. A
    // URL view outranks the default landing place, so this is insulated from that question.
    const sheet = await openSheet(page, '/?map=12/53.0685/-4.0763');

    await page.getByPlaceholder('Search trails, or a place').fill('Vesper Peak');

    const places = page.getByRole('listbox', { name: 'Places' });
    await expect(places).toBeVisible();

    // There are two Vesper Peaks in OSM — Alaska and Washington. The suggestion carrying its
    // county and state is why the list shows context at all.
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
 * Click a trail's line where it is drawn on the canvas. There is no element to target, so this
 * does what MapLibre does: projects the trail's coordinates through Web Mercator using the
 * camera the map published to the address bar. Several vertices are tried because a line runs
 * off the viewport, doubles back and passes under controls — but *no* vertex working still fails.
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

  // Vertices comfortably inside the container, ordered from the middle outwards: the middle
  // of a trail is the part least likely to be under a control.
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
    // The map answers a click synchronously off its rendered features, so a short wait is
    // enough to tell a miss from a slow hit.
    await page.waitForTimeout(400);
    if (await card.isVisible()) return;
  }

  throw new Error(`Clicked ${String(order.length)} points along ${slug} and nothing selected.`);
}
