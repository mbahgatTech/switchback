import { test as setup } from '@playwright/test';
import { REPORT_TRAIL, VESPER } from './fixtures';

/**
 * Ask for every page once before anything is timed. The dev server compiles a route on first
 * request, and CI is cold every run, so a spec can spend its whole `expect` budget waiting on
 * Turbopack and look like a flaky product. A setup *project* rather than `globalSetup` because
 * it is then guaranteed to run after `webServer` has answered; it makes no assertions.
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
  // Sixteen cold compiles in series; the default 120 s would not cover it.
  setup.setTimeout(600_000);

  for (const path of PAGES) {
    /*
     * Sequential on purpose: Turbopack compiles one route at a time anyway, so parallel
     * requests only move the queue into the server where one slow compile stalls the rest
     * behind a shared timeout. Signed out is fine — a page that redirects to `/signin` has
     * already been compiled by the time it can decide to redirect.
     */
    try {
      await request.get(path, { timeout: 180_000, failOnStatusCode: false });
    } catch (error) {
      // Warming is an optimisation, never a gate.
      console.warn(
        `Warm-up could not reach ${path}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
});
