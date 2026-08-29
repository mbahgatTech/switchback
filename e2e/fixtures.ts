import {
  expect,
  test as base,
  type APIRequestContext,
  type Locator,
  type Page,
} from '@playwright/test';
import * as trails from './trails';

/** Shared ground for the browser suite: a way to be signed in, and a way to talk to the map. */

export * from './trails';

/**
 * A database session row, not a sign-in flow — driving Entra ID headless would test
 * Microsoft's login page and tie the suite to a live tenant. Auth.js reads web sessions from
 * the database, so everything downstream of the identity provider still runs for real.
 * Created by `seedProbeAccount`, so `npm run db:seed` is all a fresh clone needs.
 */
export const PROBE_SESSION_TOKEN = 'probe-session-token-switchback';

interface Fixtures {
  /** A page whose context already carries the probe session cookie. */
  signedInPage: Page;
}

export const test = base.extend<Fixtures>({
  signedInPage: async ({ browser, baseURL }, use) => {
    const origin = baseURL ?? 'http://localhost:3000';
    // Its own context: a cookie on the default context leaks into whichever spec runs next
    // in the same worker.
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

/** The map container, found the way a screen reader finds it. */
export function sheetOf(page: Page): Locator {
  return page.getByRole('region', { name: 'Map of trails in the current view' });
}

/**
 * Open the sheet and hand back the map region. `domcontentloaded`, not `load`: a MapLibre
 * canvas streams tiles for as long as it is on screen, so `load` here resolves late or never.
 */
export async function openSheet(
  page: Page,
  search: string = trails.SHEET_AT_VESPER,
): Promise<Locator> {
  await page.goto(search, { waitUntil: 'domcontentloaded' });
  const sheet = sheetOf(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * Wait until trails are in the map's GeoJSON source, and say how many. `data-trails` is a
 * claim about the source, not the React render: the bug this suite was written for rendered
 * twenty trails in its props onto an empty sheet, so asserting on props would have passed.
 */
export async function expectTrailsLanded(sheet: Locator): Promise<number> {
  await expect(sheet).toHaveAttribute('data-trails', /^[1-9]\d*$/, { timeout: 90_000 });
  return Number(await sheet.getAttribute('data-trails'));
}

export interface Camera {
  zoom: number;
  lat: number;
  lng: number;
}

/**
 * Read the camera back out of the address bar. Reading it rather than assuming the value we
 * navigated with means a spec projecting onto the canvas uses the real camera.
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
 * Where a coordinate lands inside the map container, in CSS pixels. Exact only because
 * explore never pitches or rotates the camera; a pitched map needs the full perspective
 * matrix and this would silently drift instead of failing.
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

/**
 * Call a tRPC query over HTTP. Specs use this to learn what the sheet is *supposed* to show,
 * never to assert with: a check that fetches and asserts through the same layer proves nothing.
 * The `{ json: … }` wrapper is superjson's envelope, as the real clients send it.
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
  } catch (cause) {
    // `cause` is carried because this branch also catches a dead port and a 500, and the missing
    // row is only the likeliest of the three. Without it the reader is told confidently to reseed
    // a database that was never the problem.
    throw new Error(`No trail "${slug}" in this database. ${trails.missingTrailAdvice(slug)}`, {
      cause,
    });
  }
}
