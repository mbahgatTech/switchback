import { expect, test } from '@playwright/test';
import { PROBE_SESSION_TOKEN, VESPER } from './fixtures';

/**
 * Nothing throws on the pages that carry a map. Typecheck, lint, unit tests and a `curl` of
 * the server render are all blind to an uncaught exception in a React effect — only a real
 * browser mounting and unmounting the component sees it. Deliberately blunt: it does not know
 * what the next crash of this kind will be, which is the point.
 */

/** Every route that constructs a MapLibre instance. */
const MAP_ROUTES = ['/', `/trails/${VESPER.slug}`, '/plan', '/record'];

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
    // Long enough for the map to build and — under StrictMode — for the second pass to tear
    // the first one down. That teardown is the half of the lifecycle the bug lived in.
    await page.waitForTimeout(4_000);

    /*
     * Away and back through the client router, not a reload: a reload gets a fresh JS context
     * and would hide this class of defect, which needs a component to unmount while the page
     * keeps running. `/attribution` has no map of its own to confuse the trace.
     */
    await page.goto('/attribution', { waitUntil: 'domcontentloaded' });
    await page.goBack({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3_000);
  }

  await context.close();
  expect(thrown.join('\n'), 'uncaught exceptions').toBe('');
});
