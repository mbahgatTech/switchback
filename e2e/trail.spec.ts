import { LONG_TRAIL, VESPER, expect, test } from './fixtures';

/**
 * A trail's own page.
 *
 * The plan's verification line for this phase reads "search → trail detail → weather strip
 * renders", and the weather strip is the reason this file is not a snapshot test. Along-trail
 * forecasting is the product's flagship claim: eight points sampled by distance, each read at
 * the hour a hiker would actually arrive there. It talks to Open-Meteo over the network, and
 * that is left in on purpose — a stubbed forecast would assert that our own component renders
 * an object we handed it, which is not the claim.
 */

test.describe('Trail detail', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`/trails/${VESPER.slug}`, { waitUntil: 'domcontentloaded' });
  });

  test('the page opens on the trail and states its measurements', async ({ page }) => {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(VESPER.name);

    /*
     * The stat rail. Every one of these is derived in ingest from OSM geometry and a terrarium
     * DEM, so a missing row means the pipeline dropped something rather than that the layout
     * moved.
     *
     * Scoped to the description-list terms rather than looked up as page text, because the
     * page legitimately says "High point" twice: once as this rail's `<dt>`, and once as the
     * name of the max-elevation sample in the along-route forecast table below. Both are
     * correct. A page-wide text locator resolves to two elements and fails strict mode — but
     * only once the live Open-Meteo call lands, so it fails by the clock rather than by the
     * defect, which is exactly the flake that reaches CI and nowhere else.
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

    // The strip proper. It is a live region because changing the departure day rewrites
    // every reading in it, and that is what the test is actually confirming exists.
    const strip = page.getByRole('region', { name: 'Forecast at each point along the route' });
    await expect(strip).toBeVisible({ timeout: 60_000 });

    // A temperature at a sampled point, in the units the renderer converts to at the edge.
    await expect(strip.getByText(/-?\d+\s*°C/).first()).toBeVisible();

    // And the departure control that makes the whole thing time-shifted rather than a
    // trailhead reading repeated eight times.
    await expect(page.getByLabel('Leaving')).toBeVisible();
  });

  test('busy times, reports and the offline control are all on the page', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Busy times' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Reports from the trail' })).toBeVisible();

    // The offline control sizes the download before offering it, so its label is the
    // estimate — which is also proof the corridor was planned rather than guessed.
    await expect(page.getByRole('button', { name: /Take offline/ })).toBeVisible({
      timeout: 60_000,
    });
  });

  test('the page credits OpenStreetMap', async ({ page }) => {
    // ODbL is a licence condition, not a nicety: the data under every number above is OSM's,
    // and the attribution has to be on the page that shows it.
    await expect(page.getByRole('link', { name: /OpenStreetMap/ }).first()).toBeVisible();
  });
});

test.describe('The section collar', () => {
  /**
   * Nothing in the strip of paper above the drawing may be printed on anything else in it.
   *
   * The collar holds the weather callouts, and a callout points at a place on the trail: the
   * trailhead at the left edge, the high point wherever the range put it. On a day hike those
   * are half a plot apart. On the Appalachian Trail the high point is 7% of the way along, and
   * the two blocks were drawn one over the other — `TRAILHEAD 07:0HIGH POINT 09:54`, with the
   * high point's rule ruled through the trailhead's words on its way past.
   *
   * The assertion is geometric rather than textual because the words are a live forecast and
   * change every hour. It is also deliberately not scoped to callouts: anything that ends up
   * in the collar later inherits the same rule, and a test written against the *place* rather
   * than against today's occupants is the one that still catches it.
   */
  test('never prints one annotation over another, however early the high point comes', async ({
    page,
  }) => {
    await page.goto(`/trails/${LONG_TRAIL.slug}`, { waitUntil: 'domcontentloaded' });

    const section = page.getByRole('img', { name: /Elevation profile/i }).first();
    await expect(section).toBeVisible();
    // The callouts are the forecast, so they arrive with it rather than with the document.
    await expect(section.locator('text.collar')).toHaveCount(2, { timeout: 60_000 });

    const boxes = await section.evaluate((svg) => {
      // The plot's own top edge, read off the graphic rather than hard-coded: every gridline
      // spans the full width, so the highest of them is where the drawing starts and the
      // collar ends.
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
