import { defineConfig, devices } from '@playwright/test';

/**
 * The browser suite: real server, real database, no fixtures — it exists to answer "does the
 * map draw the trails", which nothing below a hydrated WebGL canvas can answer.
 * CI runs this nightly and on workflow_dispatch only, never on a pull request, so a green PR
 * tick does NOT mean Playwright ran. See the note at the top of `.github/workflows/ci.yml`.
 */

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './e2e',

  /*
   * One worker. Parallel workers queue on the same Next dev-server compile rather than
   * dividing the work, and two specs write the same rows as the same probe account.
   */
  workers: 1,
  fullyParallel: false,

  forbidOnly: !!process.env.CI,

  /*
   * No retries: a retry turns "the map intermittently fails to paint" into a green tick,
   * which is the defect this suite exists to catch. Generous timeouts instead.
   */
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 30_000 },

  reporter: [['list'], ['html', { open: 'never' }]],

  use: {
    baseURL,
    /*
     * Fixed, because two specs project geographic coordinates onto the canvas to click a
     * trail line and Web Mercator needs the container's pixel size. 1400×900 also puts the
     * layout past `md`, where the index sits beside the sheet rather than under it.
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
    // Ask for every page once before anything is timed: the dev server compiles a route on
    // first request, and a 30 s `expect` budget spent on Turbopack looks like a flaky product.
    { name: 'warm', testMatch: /warm\.setup\.ts/ },
    {
      name: 'chromium',
      dependencies: ['warm'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1400, height: 900 },
        /*
         * The full Chromium build, not the headless shell, with software GL asked for
         * explicitly: MapLibre throws without a WebGL2 context, and since M110 Chrome will
         * not hand the SwiftShader fallback to WebGL unless the flag says so.
         */
        channel: 'chromium',
        launchOptions: {
          args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
        },
      },
    },
  ],

  // Reuse whatever is already on :3000. This also lets the file run unchanged against a
  // deployment: set `E2E_BASE_URL` and no server is started at all.
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
