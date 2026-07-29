import { REPORT_TRAIL, expect, test, trailBySlug, trpcMutate } from './fixtures';

/**
 * Filing a report.
 *
 * The plan's verification line reads "sign in with Entra → post a review", and this is the
 * half of it that is ours. It writes to the real database through the real form: a rating
 * chosen from the radio cells, a body typed into the textarea, `reviews.upsert` over HTTP,
 * `refreshAggregates` in the same transaction, and the list refetching underneath.
 *
 * Reviews are the one thing in this product that cannot be re-derived from OpenStreetMap.
 * Every trail, stat, and profile in the database can be rebuilt by running ingest again;
 * what a hiker wrote about the snow line cannot. That asymmetry is why this path gets a
 * browser test rather than a unit test of the router.
 */

/**
 * Distinctive enough to assert on, and honest about where it came from.
 *
 * If a run is killed between the submit and the cleanup, this string is what makes the
 * stray row identifiable in the database rather than indistinguishable from a real report.
 */
const BODY =
  'Filed by the end-to-end suite. Snow to the saddle, boots fine below it, creek crossing straightforward.';

/**
 * Set by the test, read by the cleanup.
 *
 * The teardown runs whether or not the test passed, because the failure mode it guards
 * against is the interesting one: a spec that dies halfway through the form still leaves a
 * review behind, and the next run would find "Edit your report" where it expected "Report
 * on this trail" and fail for a reason that has nothing to do with the code.
 */
let filedTrailId: string | null = null;

test.afterEach(async ({ signedInPage }) => {
  if (filedTrailId === null) return;
  const trailId = filedTrailId;
  filedTrailId = null;
  try {
    await trpcMutate(signedInPage.request, 'reviews.remove', { trailId });
  } catch {
    // NOT_FOUND means the test never got as far as writing one, which is not a second
    // failure worth reporting on top of the first.
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

    // The form is closed until asked for. Its label doubles as the assertion that the
    // session cookie worked: signed out, this is a "Sign in" link instead.
    const open = page.getByRole('button', { name: 'Report on this trail' });
    await expect(open).toBeVisible();

    /*
     * The rating cells are `<label>`s wrapping a visually hidden radio, so the input itself
     * cannot be clicked — it has no box on the page. Clicking the label is what a person
     * does, and what the browser forwards to the input.
     */
    filedTrailId = trail.id;
    const rating = page.locator('label:has(input[name="rating"][value="4"])');

    /*
     * Click until the form is actually there, rather than once and hopefully.
     *
     * The button is server-rendered but its handler arrives with hydration, and on this
     * route hydration waits on a large RSC payload. A click that lands in that window is
     * accepted by the browser — the button takes focus, Playwright's actionability checks
     * all pass — and then does nothing, because there is no listener on it yet. Under load
     * that window is wide enough to lose a race in: this spec passes alone and failed once
     * as the forty-first test of a full run.
     *
     * Re-clicking is safe because opening is not a toggle. `setOpen(true)` unmounts the
     * button entirely, so the `isVisible` guard is what stops the second pass from firing
     * at something that is no longer there.
     */
    await expect(async () => {
      if (await open.isVisible()) await open.click({ timeout: 5_000 });
      await expect(rating).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    await rating.click();
    await expect(page.locator('input[name="rating"][value="4"]')).toBeChecked();

    await page.getByLabel('Anything else worth knowing').fill(BODY);
    await page.getByRole('button', { name: 'File report' }).click();

    // Read back from the list, not from the form. The claim is that it was written and
    // served; a form still holding the text it was handed proves neither.
    await expect(reports.getByText(BODY)).toBeVisible({ timeout: 60_000 });

    // The form closed itself and now offers the amendment instead, which is the visible
    // consequence of the server having accepted it.
    //
    // The long timeout is about the dev server, not about doubt. `save`'s `onSuccess` calls
    // `router.refresh()` so the server-rendered average above updates, and on a cold route
    // that RSC render fans out to Open-Meteo twice, the busyness model, the photo strip and
    // a PostGIS nearby query. React holds the pending client commit until it lands, so this
    // button can be a slow *arrival* on the first run of a session and instant thereafter.
    // A failure here still means the button never came, which is the thing worth catching.
    await expect(page.getByRole('button', { name: 'Edit your report' })).toBeVisible({
      timeout: 90_000,
    });
  });

  /**
   * The report filed before the page had finished loading.
   *
   * This one is a regression test with a date. The trail page opens by firing a single
   * batched tRPC request that carries the weather, the busyness week and the reviews
   * together, and the weather half of it goes out to Open-Meteo. Somebody who knows what
   * they want to say can pick a rating and press File report while that batch is still in
   * the air — and when they did, the write landed, the form closed, and the section
   * underneath said *nobody has reported on this trail yet*, because the reply that finally
   * came back was a picture of the trail taken before their report existed.
   *
   * **The reply is held, not the request.** The batch is let through the moment it is made,
   * so the server reads the database *before* the report is written — which is the whole
   * point. Delaying the outbound request instead would have the server read after the write
   * and hand back the right answer, proving nothing; that version of this test passed
   * against the bug.
   *
   * **Held until released, rather than for a fixed few seconds.** The window has to still be
   * open when File report is pressed, and a stopwatch cannot promise that: registering any
   * `page.route` puts every request in this page through CDP interception, including the
   * several hundred chunk requests the dev server serves, so hydration here is slower than
   * on a page with no route registered — and the delay is a build machine's mood, not a
   * constant. Releasing on the submit instead makes the ordering structural. The test is
   * also faster for it, because nothing waits out a timer that has already done its job.
   *
   * The open-form click is retried for the same reason. It is the first interaction on the
   * page, the button is in the server-rendered HTML, and a click that lands before React
   * attaches its handler is swallowed in silence — the button takes focus and the form
   * never opens. Every later interaction is safe: by then the form is proof of hydration.
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

    // Both halves of the claim: the report is on the trail, and the trail knows it is the
    // caller's. The second is what actually broke — the list can be right while the form
    // still offers to write a report the hiker has already written.
    await expect(reports.getByText(BODY)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Edit your report' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(reports.getByText('Nobody has reported on this trail yet.')).toHaveCount(0);
  });

  test('withdrawing a report takes it off the trail', async ({ signedInPage: page }) => {
    const trail = await trailBySlug(page.request, REPORT_TRAIL.slug);

    // Written through the API rather than the form: this test is about the removal, and
    // re-driving the form to set it up would make a failure ambiguous between the two.
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

    // Same hydration window as the sibling specs: the disclosure is painted by the server
    // and wired up by the client, and a click in between is silently dropped.
    const edit = page.getByRole('button', { name: 'Edit your report' });
    const remove = page.getByRole('button', { name: 'Remove', exact: true });
    await expect(async () => {
      if (await edit.isVisible()) await edit.click({ timeout: 5_000 });
      await expect(remove).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });

    /*
     * Two taps, and the second is the only control on this page allowed to take the survey
     * plate — not because losing a report is dangerous, but because it is the one control
     * here that destroys something. `exact` because a photograph cell's button is called
     * "Remove this photograph", and the default substring match would find it too.
     */
    await remove.click();
    await expect(page.getByText('Remove your report?')).toBeVisible();
    await remove.click();

    await expect(reports.getByText(BODY)).toHaveCount(0, { timeout: 60_000 });
    filedTrailId = null;

    // Back to the state a hiker who has never written here would see.
    await expect(page.getByRole('button', { name: 'Report on this trail' })).toBeVisible();
  });
});
