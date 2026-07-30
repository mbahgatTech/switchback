import {
  expect,
  test as base,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';

/**
 * Shared ground for the browser suite.
 *
 * Two things live here that every spec needs: a way to be signed in, and a way to talk to
 * the same map the browser is looking at.
 */

// ---------------------------------------------------------------------------
// The probe account
// ---------------------------------------------------------------------------

/**
 * A database session row, not a sign-in flow.
 *
 * Driving Entra ID from a headless browser would test Microsoft's login page, which is not
 * ours and is not the thing under test; it would also make the suite depend on a live
 * tenant and a real credential. Auth.js keeps web sessions in the database, so a row with a
 * known token *is* a signed-in user by the same code path a real one takes — the cookie is
 * looked up, the session is loaded, `ctx.user` is populated. Everything downstream of the
 * identity provider is exercised for real; only the provider itself is skipped.
 *
 * Created by `seedProbeAccount` in `packages/db/scripts/seed.ts`, so `npm run db:seed` is
 * all a fresh clone needs. If it is missing the review spec fails at its first assertion
 * with "Sign in", which is the correct and legible failure.
 */
export const PROBE_SESSION_TOKEN = 'probe-session-token-switchback';

// ---------------------------------------------------------------------------
// Where we look
// ---------------------------------------------------------------------------

/**
 * Vesper Peak, which is where this suite exists.
 *
 * The reader's report was "I search Vesper peak and get nothing… no map cant check
 * places", so the suite opens on the same mountain rather than on a synthetic fixture. At
 * z13 the sheet holds twenty-odd trails from a tile that is already ingested, so nothing
 * here waits on Overpass.
 */
export const VESPER = {
  slug: 'vesper-peak-summit-trail',
  name: 'Vesper Peak summit trail',
  /** `map=zoom/lat/lng`, the same format the sheet writes back into the address bar. */
  view: 'map=13/48.01213/-121.51188',
} as const;

/** A quieter trail on the same sheet, used where a spec has to write to the database. */
export const REPORT_TRAIL = { slug: 'greider-lakes-trail' } as const;

/**
 * A trail long enough that the section's annotations fight for room.
 *
 * 3,404 km, with its high point roughly 240 km in — 7% of the way across the plot, which is
 * near enough to the trailhead that the two weather callouts were drawn on top of each other:
 * `TRAILHEAD 07:0HIGH POINT 09:54` on one line, two interleaved temperatures on the next. A
 * day hike puts its summit halfway along and proves nothing about this.
 */
export const LONG_TRAIL = { slug: 'appalachian-trail-dauphin-county' } as const;

export const SHEET_AT_VESPER = `/?${VESPER.view}`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface Fixtures {
  /** A page whose context already carries the probe session cookie. */
  signedInPage: Page;
}

export const test = base.extend<Fixtures>({
  signedInPage: async ({ browser, baseURL }, use) => {
    const origin = baseURL ?? 'http://localhost:3000';
    // A context of its own rather than the shared `page`: a cookie added to the default
    // context would leak into whichever spec ran next in the same worker, and "why is this
    // signed in" is a miserable thing to debug.
    const context = await browser.newContext({
      baseURL: origin,
      viewport: { width: 1400, height: 900 },
      serviceWorkers: 'allow',
    });
    await context.addCookies([
      { name: 'authjs.session-token', value: PROBE_SESSION_TOKEN, url: origin },
    ]);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

/** The map container, found the way a screen reader finds it. */
export function sheetOf(page: Page): Locator {
  return page.getByRole('region', { name: 'Map of trails in the current view' });
}

/**
 * Open the sheet and hand back the map region.
 *
 * `domcontentloaded`, not the default `load`. A MapLibre canvas streams tiles for as long
 * as it is on screen, so `load` on this route resolves late or not at all — which is what
 * made an earlier attempt at this suite hang for half an hour rather than fail. Every wait
 * after this point is a wait on something specific.
 */
export async function openSheet(page: Page, search: string = SHEET_AT_VESPER): Promise<Locator> {
  await page.goto(search, { waitUntil: 'domcontentloaded' });
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * Wait until trails are actually in the map's data source, and say how many.
 *
 * `data-trails` is written by `reportLanded` in `trail-map.tsx` on the one path where
 * `setTrailData` returned true, so it is a claim about the GeoJSON source rather than about
 * the React render. That distinction is the entire point: the bug this suite was written
 * for had a correct query, a correct response, a component that rendered with twenty trails
 * in its props — and an empty sheet, because the push landed on a listener that never fired.
 * Asserting on the props would have passed.
 */
export async function expectTrailsLanded(sheet: Locator): Promise<number> {
  await expect(sheet).toHaveAttribute('data-trails', /^[1-9]\d*$/, { timeout: 90_000 });
  return Number(await sheet.getAttribute('data-trails'));
}

// ---------------------------------------------------------------------------
// Clicking a line on a canvas
// ---------------------------------------------------------------------------

export interface Camera {
  zoom: number;
  lat: number;
  lng: number;
}

/**
 * Read the camera back out of the address bar.
 *
 * The sheet writes `map=zoom/lat/lng` after every settled move, which makes the URL the one
 * published, non-private handle on where the map actually is. Reading it rather than
 * assuming the value we navigated with means a spec that clicks the canvas is projecting
 * against the real camera even if something moved it.
 */
export function readCamera(url: string): Camera {
  const raw = new URL(url).searchParams.get('map');
  const parts = raw?.split('/') ?? [];
  const [zoom, lat, lng] = [Number(parts[0]), Number(parts[1]), Number(parts[2])];
  if (!Number.isFinite(zoom) || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error(`No camera in the URL — expected ?map=zoom/lat/lng, got ${url}`);
  }
  return { zoom, lat, lng };
}

/** MapLibre's tile size. Every pixel below is derived from it. */
const TILE_PX = 512;

function mercatorX(lng: number, world: number): number {
  return ((lng + 180) / 360) * world;
}

function mercatorY(lat: number, world: number): number {
  const sin = Math.sin((lat * Math.PI) / 180);
  return world * (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI));
}

/**
 * Where a coordinate lands inside the map container, in CSS pixels.
 *
 * The same Web Mercator MapLibre uses, and exact for the sheet's camera because explore
 * never pitches or rotates it — a pitched map would need the full perspective matrix and
 * this would silently drift instead of failing. Clicking a trail line is the interaction
 * the reader described and the only one that cannot be reached through the DOM, so it is
 * worth the twelve lines of arithmetic.
 */
export function project(
  camera: Camera,
  point: { lng: number; lat: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const world = TILE_PX * Math.pow(2, camera.zoom);
  return {
    x: mercatorX(point.lng, world) - mercatorX(camera.lng, world) + size.width / 2,
    y: mercatorY(point.lat, world) - mercatorY(camera.lat, world) + size.height / 2,
  };
}

// ---------------------------------------------------------------------------
// Talking to the API the app talks to
// ---------------------------------------------------------------------------

/**
 * Call a tRPC query over HTTP.
 *
 * Specs use this to learn what the sheet is *supposed* to be showing — the geometry to aim
 * a click at, the id of a trail to clean up afterwards — never to assert with. An assertion
 * that both fetches and checks the same value through the same layer proves nothing.
 *
 * The `{ json: … }` wrapper is superjson's envelope, which is how the real clients send it.
 */
export async function trpcQuery<T>(
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<T> {
  const response = await request.get(`/api/trpc/${path}`, {
    params: { input: JSON.stringify({ json: input }) },
  });
  const body = (await response.json()) as
    { result: { data: { json: T } } } | { error: { json: { message: string } } };
  if ('error' in body) throw new Error(`${path} failed: ${body.error.json.message}`);
  return body.result.data.json;
}

/** The same, for a mutation. Used only to undo what a spec wrote. */
export async function trpcMutate<T>(
  request: APIRequestContext,
  path: string,
  input: unknown,
): Promise<T> {
  const response = await request.post(`/api/trpc/${path}`, { data: { json: input } });
  const body = (await response.json()) as
    { result: { data: { json: T } } } | { error: { json: { message: string } } };
  if ('error' in body) throw new Error(`${path} failed: ${body.error.json.message}`);
  return body.result.data.json;
}

/** Resolve a trail by slug, failing with something a person can act on. */
export async function trailBySlug(
  request: APIRequestContext,
  slug: string,
): Promise<{ id: string; name: string; slug: string }> {
  try {
    return await trpcQuery<{ id: string; name: string; slug: string }>(request, 'trails.bySlug', {
      slug,
    });
  } catch {
    throw new Error(
      `No trail "${slug}" in this database. The suite reads the Vesper Peak sheet; ` +
        `run \`npm run db:seed\` or \`npm run ingest:tile\` over that area first.`,
    );
  }
}
