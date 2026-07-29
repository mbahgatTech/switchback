import { defineConfig, devices } from '@playwright/test';

/**
 * The browser suite.
 *
 * Everything in `packages/*` is covered by vitest, which is the right tool for a pace
 * formula or a quadkey cover. None of it can answer the question this repo has actually
 * been asked twice: *does the map draw the trails*. That is a claim about a WebGL canvas
 * inside a hydrated React tree talking to a real Postgres, and the only honest way to
 * check it is to open a browser and look.
 *
 * So these specs run against a live server with a live database, not against fixtures.
 * They are slower and they can fail for reasons the code did not cause — an Open-Meteo
 * timeout, a cold Turbopack compile — and both of those are treated as things to wait
 * longer for rather than to mock away. A suite that passes with the weather stubbed out
 * would not have caught any bug this product has actually had. The compile is also paid up
 * front by the `warm` project below, so it is waited for once rather than inside whichever
 * spec happened to ask for a page first.
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',

  /*
   * One worker, deliberately.
   *
   * The bottleneck is a single Next dev server that compiles routes on first request, so
   * parallel workers do not divide the work — they queue on the same compile while each
   * one's clock runs. Worse, two of these specs write to the same database rows (a report
   * is unique per user and trail), and the fixture signs both of them in as the same probe
   * account. Serial is both faster here and correct.
   */
  workers: 1,
  fullyParallel: false,

  forbidOnly: !!process.env.CI,

  /*
   * No retries. A retry on a suite like this converts "the map intermittently fails to
   * paint" into a green tick, which is precisely the defect it exists to catch. Generous
   * timeouts instead: slow is a fact about a dev server, flaky is a fact about the product.
   */
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL,
    /*
     * A fixed viewport, because two of these specs project geographic coordinates onto the
     * canvas to click a trail line. Web Mercator needs the pixel size of the container, and
     * a viewport that changes with the window would make the arithmetic unreproducible.
     * 1400×900 also puts the layout past the `md` breakpoint, where the index sits beside
     * the sheet rather than under it.
     */
    viewport: { width: 1400, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    serviceWorkers: 'allow',
    // Every spec that waits on a map is waiting on network, not on script.
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },

  projects: [
    /*
     * Ask for every page once before anything is timed. See `e2e/warm.setup.ts` — in short,
     * the dev server compiles a route on first request, CI starts cold every time, and a
     * thirty-second `expect` budget spent on Turbopack looks exactly like a flaky product.
     */
    { name: 'warm', testMatch: /warm\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['warm'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1400, height: 900 },
        /*
         * The full Chromium build rather than the headless shell, and software GL enabled
         * explicitly.
         *
         * MapLibre needs a WebGL2 context or it throws on construction, and there is no
         * GPU behind a headless run. Chrome will fall back to SwiftShader but since M110 it
         * refuses to hand that fallback to WebGL unless asked, so without the flag every
         * map spec fails identically and misleadingly — "no map" rather than "no GPU".
         */
        channel: 'chromium',
        launchOptions: {
          args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
        },
      },
    },
  ],

  /*
   * Reuse whatever is already on :3000.
   *
   * The dev server is expected to be running while this repo is being worked on, and
   * killing it to run the tests would be the wrong trade. `reuseExistingServer` also means
   * this file works unchanged against a preview deployment: set `E2E_BASE_URL` and no
   * server is started at all.
   */
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
