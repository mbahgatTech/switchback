import { REPORT_TRAIL, expect, test, trailBySlug, trpcMutate } from './fixtures';

/**
 * Filing a report, through the real form against the real database. Reviews are the one thing
 * in this product that cannot be re-derived from OpenStreetMap, which is why this path gets a
 * browser test rather than a unit test of the router.
 */

/** Distinctive enough to assert on, and identifiable in the database if a run dies mid-test. */
const BODY =
  'Filed by the end-to-end suite. Snow to the saddle, boots fine below it, creek crossing straightforward.';

/**
 * Set by the test, read by the cleanup. The teardown runs whether or not the test passed: a
 * leftover review makes the next run find "Edit your report" and fail for an unrelated reason.
 */
let filedTrailId: string | null = null;

test.afterEach(async ({ signedInPage }) => {
  if (filedTrailId === null) return;
  const trailId = filedTrailId;
  filedTrailId = null;
  try {
    await trpcMutate(signedInPage.request, 'reviews.remove', { trailId });
  } catch {
    // NOT_FOUND means the test never got as far as writing one.
  }
});

test.describe('Reports', () => {
  test('a signed-in hiker can file a report and read it back on the trail', async ({
    signedInPage: page,
  }) => {
    const trail = await trailBySlug(page.request, REPORT_TRAIL.slug);
    await page.goto(`/trails/${trail.slug}`, { waitUntil: 'domcontentloaded' });

    const reports = page.locator('section[aria-labelledby="reviews-heading"]');
    await expect(reports).toBeVisible();

    // Its label doubles as the assertion that the session cookie worked: signed out, this is
    // a "Sign in" link instead.
    const open = page.getByRole('button', { name: 'Report on this trail' });
    await expect(open).toBeVisible();

    /*
     * The rating cells are `<label>`s wrapping a visually hidden radio, so the input has no
     * box to click; clicking the label is what the browser forwards to the input.
     */
    filedTrailId = trail.id;
    const rating = page.locator('label:has(input[name="rating"][value="4"])');

    /*
     * The button is server-rendered but its handler arrives with hydration, and on this route
     * hydration waits on a large RSC payload. A click landing in that window passes every
     * actionability check and does nothing. Re-clicking is safe because opening is not a
     * toggle: `setOpen(true)` unmounts the button, so `isVisible` guards the second pass.
     */
    await expect(async () => {
      if (await open.isVisible()) await open.click({ timeout: 5_000 });
      await expect(rating).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await rating.click();
    await expect(page.locator('input[name="rating"][value="4"]')).toBeChecked();

    await page.getByLabel('Anything else worth knowing').fill(BODY);
    await page.getByRole('button', { name: 'File report' }).click();

    // Read back from the list, not the form: a form still holding the text it was handed
    // proves neither that it was written nor that it was served.
    await expect(reports.getByText(BODY)).toBeVisible({ timeout: 60_000 });

    // The long timeout is the dev server, not doubt: `save`'s `onSuccess` calls
    // `router.refresh()`, and on a cold route that RSC render fans out to Open-Meteo, the
    // busyness model, the photo strip and a PostGIS query before React commits.
    await expect(page.getByRole('button', { name: 'Edit your report' })).toBeVisible({
      timeout: 90_000,
    });
  });

  /**
   * Regression: a report filed while the trail page's batched tRPC request was still in the
   * air was overwritten by the stale reply. The *reply* is held, not the request — the batch
   * goes out immediately so the server reads the database before the write lands, which is
   * the whole point; delaying the request instead makes the server read after it and proves
   * nothing. Held until the submit releases it rather than for a fixed time, because
   * registering any `page.route` slows hydration by an amount no timer can predict.
   */
  test('a report filed while the page is still loading is not lost', async ({
    signedInPage: page,
  }) => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    await page.route(/weather\.alongRoute/u, async (route) => {
      const response = await route.fetch();
      const body = await response.body();
      await held;
      await route.fulfill({ response, body });
    });

    const trail = await trailBySlug(page.request, REPORT_TRAIL.slug);
    filedTrailId = trail.id;
    await page.goto(`/trails/${trail.slug}`, { waitUntil: 'domcontentloaded' });

    const reports = page.locator('section[aria-labelledby="reviews-heading"]');
    const rating = page.locator('label:has(input[name="rating"][value="5"])');

    await expect(async () => {
      await page.getByRole('button', { name: 'Report on this trail' }).click();
      await expect(rating).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 60_000 });

    await rating.click();
    await page.getByLabel('Anything else worth knowing').fill(BODY);
    await page.getByRole('button', { name: 'File report' }).click();
    release();

    // Both halves: the report is on the trail, and the trail knows it is the caller's. The
    // second is what broke — the list can be right while the form still offers to write it.
    await expect(reports.getByText(BODY)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Edit your report' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(reports.getByText('Nobody has reported on this trail yet.')).toHaveCount(0);
  });

  test('withdrawing a report takes it off the trail', async ({ signedInPage: page }) => {
    const trail = await trailBySlug(page.request, REPORT_TRAIL.slug);

    // Written through the API, not the form: this test is about the removal, and re-driving
    // the form to set it up would make a failure ambiguous between the two.
    await trpcMutate(page.request, 'reviews.upsert', {
      trailId: trail.id,
      rating: 3,
      body: BODY,
      conditions: [],
    });
    filedTrailId = trail.id;

    await page.goto(`/trails/${trail.slug}`, { waitUntil: 'domcontentloaded' });
    const reports = page.locator('section[aria-labelledby="reviews-heading"]');
    await expect(reports.getByText(BODY)).toBeVisible();

    // Same hydration window as the sibling specs.
    const edit = page.getByRole('button', { name: 'Edit your report' });
    const remove = page.getByRole('button', { name: 'Remove', exact: true });
    await expect(async () => {
      if (await edit.isVisible()) await edit.click({ timeout: 5_000 });
      await expect(remove).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    // Two taps: this is the one control on the page that destroys something. `exact` because
    // a photograph cell's button is called "Remove this photograph".
    await remove.click();
    await expect(page.getByText('Remove your report?')).toBeVisible();
    await remove.click();

    await expect(reports.getByText(BODY)).toHaveCount(0, { timeout: 60_000 });
    filedTrailId = null;

    // Back to the state a hiker who has never written here would see.
    await expect(page.getByRole('button', { name: 'Report on this trail' })).toBeVisible();
  });
});
