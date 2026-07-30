import { test as setup } from '@playwright/test';
import { REPORT_TRAIL, VESPER } from './fixtures';

/**
 * Ask for every page once before anything is timed.
 *
 * The dev server compiles a route the first time it is requested, and the routes this suite
 * opens are the heavy ones — a trail sheet pulls in MapLibre, the elevation chart, the
 * forecast strip and the busyness model. On a machine that already has a warm `.next` this
 * costs a few hundred milliseconds and nobody notices. On a cold one it is the difference
 * between a spec that passes and a spec that spends its thirty-second `expect` budget
 * waiting for Turbopack.
 *
 * That is not hypothetical: the whole suite was re-run immediately after Prettier rewrote
 * every file in the repo, which invalidated the entire compile cache, and one report spec
 * failed in a run that took nearly three times as long as usual. Re-run warm, it passed.
 * CI is cold every single time, so what happened once here would happen there routinely —
 * and it would look like a flaky product rather than a cold cache.
 *
 * A setup *project* rather than `globalSetup`, because a setup project is an ordinary test:
 * it is guaranteed to run after `webServer` has answered on `url`, which is the one thing
 * this needs to be true. It makes no assertions and cannot fail the run — a server that
 * cannot answer here will fail the actual specs, with a better message than this file
 * could write.
 */

/** The pages the specs open, plus the two trails they open by slug. */
const PAGES = [
  '/',
  '/explore',
  '/nearby',
  '/plan',
  '/record',
  '/lists',
  '/routes',
  '/profile',
  '/settings',
  '/downloads',
  '/attribution',
  '/offline',
  '/signin',
  `/trails/${VESPER.slug}`,
  `/trails/${REPORT_TRAIL.slug}`,
  // The gallery spec's trail — twelve Commons frames, and the only sheet with a full strip.
  '/trails/boston-basin-trail',
];

setup('compile the pages the suite opens', async ({ request }) => {
  // Fifteen cold compiles, one after another. The default 120 s would not cover it, and a
  // warm-up that times out is a red run for the least interesting reason available.
  setup.setTimeout(600_000);

  for (const path of PAGES) {
    /*
     * Sequential on purpose. Turbopack compiles one route at a time regardless, so firing
     * these in parallel only moves the queue from this loop into the server, where it is
     * invisible and where one slow compile stalls the rest behind a shared timeout.
     *
     * Signed out is fine. A page that redirects to `/signin` has already been compiled and
     * executed by the time it can decide to redirect — the compile is the expensive part and
     * it has happened either way.
     */
    try {
      await request.get(path, { timeout: 180_000, failOnStatusCode: false });
    } catch (error) {
      // Warming is an optimisation, never a gate. Say so and carry on.
      console.warn(
        `Warm-up could not reach ${path}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
});
