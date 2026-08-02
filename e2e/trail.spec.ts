import { LONG_TRAIL, VESPER, expect, test } from './fixtures';

/**
 * A trail's own page. The along-trail forecast talks to Open-Meteo over the network on
 * purpose: a stubbed forecast would only assert that our component renders an object we
 * handed it.
 */

test.describe('Trail detail', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/trails/${VESPER.slug}`, { waitUntil: 'domcontentloaded' });
  });

  test('the page opens on the trail and states its measurements', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(VESPER.name);

    /*
     * Every stat is derived in ingest from OSM geometry and a terrarium DEM, so a missing row
     * means the pipeline dropped something rather than that the layout moved.
     *
     * Scoped to the description-list terms rather than page text: the page legitimately says
     * "High point" twice, and a page-wide locator fails strict mode only once the live
     * Open-Meteo call lands — a flake by the clock that reaches CI and nowhere else.
     */
    const terms = page.getByRole('term');
    for (const label of ['Length', 'Ascent', 'Descent', 'High point', 'Low point', 'Moving time']) {
      await expect(terms.filter({ hasText: new RegExp(`^${label}$`, 'u') })).toBeVisible();
    }

    // The elevation profile is the product's signature graphic and its own control surface.
    await expect(page.getByRole('slider', { name: 'Position along the trail' })).toBeVisible();
  });

  test('the weather strip renders a forecast along the route', async ({ page }) => {
    const conditions = page.getByRole('heading', { name: 'Conditions on the way' });
    await expect(conditions).toBeVisible();

    // A live region because changing the departure day rewrites every reading in it.
    const strip = page.getByRole('region', { name: 'Forecast at each point along the route' });
    await expect(strip).toBeVisible({ timeout: 60_000 });

    /*
     * The upstream is `e2e/weather-stub.ts`, pinned by `playwright.config.ts`. Before that this
     * asserted only that some digits and a degree sign appeared, and went red in CI when the
     * runner could not reach api.open-meteo.com — reporting a third party's downtime as a defect
     * in this repository. A fixed forecast lets it assert the reading instead of its shape.
     *
     * The stub cools with altitude, so a summit sample differs from the trailhead. That is the
     * property worth guarding: the strip is time- and place-shifted, not one reading repeated at
     * eight points.
     */
    const readings = await strip.getByText(/-?\d+\s*°/).allInnerTexts();
    expect(readings.length).toBeGreaterThanOrEqual(2);

    const degrees = readings.map((t) => Number(/(-?\d+)/.exec(t)?.[1] ?? NaN));
    expect(degrees.every((n) => Number.isFinite(n))).toBe(true);
    // Trailhead is the warmest sample: every other point on this trail is higher.
    expect(Math.max(...degrees)).toBeLessThanOrEqual(11);
    expect(new Set(degrees).size).toBeGreaterThan(1);

    // The departure control is what makes the strip time-shifted rather than a trailhead
    // reading repeated eight times.
    await expect(page.getByLabel('Leaving')).toBeVisible();
  });

  test('busy times, reports and the offline control are all on the page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Busy times' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reports from the trail' })).toBeVisible();

    // The offline control sizes the download before offering it, so its label is the estimate.
    await expect(page.getByRole('button', { name: /Take offline/ })).toBeVisible({
      timeout: 60_000,
    });
  });

  test('the page credits OpenStreetMap', async ({ page }) => {
    // ODbL is a licence condition: the data under every number above is OSM's.
    await expect(page.getByRole('link', { name: /OpenStreetMap/ }).first()).toBeVisible();
  });
});

test.describe('The section collar', () => {
  /**
   * Nothing in the collar above the drawing may be printed over anything else in it. The
   * assertion is geometric because the words are a live forecast, and deliberately not scoped
   * to callouts: anything that lands in the collar later inherits the same rule.
   */
  test('never prints one annotation over another, however early the high point comes', async ({
    page,
  }) => {
    await page.goto(`/trails/${LONG_TRAIL.slug}`, { waitUntil: 'domcontentloaded' });

    const section = page.getByRole('img', { name: /Elevation profile/i }).first();
    await expect(section).toBeVisible();
    // The callouts are the forecast, so they arrive with it rather than with the document. A lower
    // bound, not an exact count: `.collar` is a typeface, and the freezing-level annotation wears it
    // too while being drawn inside the plot — so the exact number depends on whether the forecast
    // puts the freezing level below the summit, which is a function of hemisphere and season. The
    // overprint check below reads the collar off the geometry instead, and is the real guard.
    await expect
      .poll(async () => section.locator('text.collar').count(), { timeout: 60_000 })
      .toBeGreaterThanOrEqual(2);

    const boxes = await section.evaluate((svg) => {
      // The plot's top edge read off the graphic rather than hard-coded: every gridline spans
      // the full width, so the highest of them is where the drawing starts and the collar ends.
      const rules = [...svg.querySelectorAll('line')].map((line) => ({
        y: Number(line.getAttribute('y1')),
        span: Math.abs(Number(line.getAttribute('x2')) - Number(line.getAttribute('x1'))),
      }));
      const plotTop = Math.min(...rules.filter((r) => r.span > 800).map((r) => r.y));
      return [...svg.querySelectorAll('text')]
        .map((el) => {
          const b = el.getBBox();
          return { text: el.textContent ?? '', x: b.x, y: b.y, w: b.width, h: b.height };
        })
        .filter((b) => b.w > 0 && b.y + b.h <= plotTop);
    });

    expect(boxes.length).toBeGreaterThanOrEqual(4);
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) {
        const shared = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(shared, `"${a.text}" overprints "${b.text}"`).toBe(false);
      }
    }
  });
});
