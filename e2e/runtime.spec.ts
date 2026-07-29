import { expect, test } from '@playwright/test';
import { PROBE_SESSION_TOKEN, VESPER } from './fixtures';

/**
 * Nothing throws on the pages that carry a map.
 *
 * This exists because of a specific bug that shipped past every other gate. The scale bar
 * kept a reference to a MapLibre control and called `setUnit` on it after the map had been
 * torn down; the control had already had its `_map` cleared by `onRemove`, so the call
 * dereferenced `undefined` and the whole page went blank below the header.
 *
 * Typecheck was clean. Lint was clean. The unit tests were clean. `curl` returned a
 * complete, correct HTML document — the server render never runs the effect. Only a real
 * browser, mounting the component and then unmounting it, could see it, and the visible
 * symptom was "the trail page is empty", which reads as a data problem rather than a
 * client one.
 *
 * So the assertion is deliberately blunt and deliberately broad: open every route with a
 * map on it, leave, come back, and let nothing reach `window.onerror`. It does not know
 * what the next crash of this kind will be, which is the point — an uncaught exception in
 * a React effect is never acceptable, whatever it says.
 */

/** Every route that constructs a MapLibre instance. */
const MAP_ROUTES = ['/explore', `/trails/${VESPER.slug}`, '/plan', '/record'];

test('no uncaught errors on the routes that carry a map', async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const origin = baseURL ?? 'http://localhost:3000';
  const context = await browser.newContext({
    baseURL: origin,
    viewport: { width: 1400, height: 900 },
  });
  await context.addCookies([
    { name: 'authjs.session-token', value: PROBE_SESSION_TOKEN, url: origin },
  ]);
  const page = await context.newPage();

  const thrown: string[] = [];
  page.on('pageerror', (error) => {
    thrown.push(`${page.url()}\n    ${error.message.split('\n')[0]}`);
  });

  for (const route of MAP_ROUTES) {
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    // Long enough for the map to build, the controls to attach, and — under React's dev
    // StrictMode — for the second pass to tear the first one down again. That teardown is
    // the half of the lifecycle the original bug lived in.
    await page.waitForTimeout(4_000);

    /*
     * Away and back, through the client router rather than a reload.
     *
     * A reload gets a fresh JS context and would hide exactly this class of defect: the
     * failure needs a component to unmount while the page keeps running. `/attribution` is
     * the cheapest route in the app and has no map of its own to confuse the trace.
     */
    await page.goto('/attribution', { waitUntil: 'domcontentloaded' });
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);
  }

  await context.close();
  expect(thrown.join('\n'), 'uncaught exceptions').toBe('');
});
