/**
 * Process-wide ingest singletons. The Overpass queue only means anything if everyone shares
 * it: two clients at `maxConcurrent: 2` are one client at 4, which is what gets an IP blocked.
 * Lazy, because the constructor throws on a missing `OVERPASS_USER_AGENT` and a module that
 * throws at import time takes down routes that never touch ingest.
 */

import { OverpassClient } from './overpass';
import { TerrainSource } from './elevate';
import { terrainCacheFromEnv } from './terrain-cache';
import { subdivideMaxZoom } from './subdivide';
import { trailIdentityMode } from './identity';
import type { PipelineDeps } from './pipeline';

let overpassClient: OverpassClient | null = null;
let terrainSource: TerrainSource | null = null;

/**
 * Wall clock one `query()` may spend here when `OVERPASS_MAX_TOTAL_MS` does not say otherwise.
 *
 * The client's own default is no ceiling, which is the right default for a library and the wrong
 * one for every process this repo deploys: on the retry ladder an unbounded query is ~24 minutes,
 * longer than the Functions host will let an invocation live. It used to be supplied only by the
 * `appSettings` array in `infra/azure/ingest.bicep`, and an ARM application-settings write replaces
 * that collection whole — so dropping one entry silently restored the unbounded case.
 *
 * **190 s is `OverpassClient.requestTimeoutMs`, and that is the derivation.** Budget above one
 * attempt's abort window can only fund a *second* attempt, and a retry starting past 190 s of a
 * 190 s window cannot finish a query whose server-side `[timeout:]` is up to 180 s — so the excess
 * bought nothing and came straight out of `overpassDeadlineMs`'s start-by. Fast failures still
 * retry: a 429 at one second plus backoff leaves most of the window.
 *
 * Sized against measurement rather than assumed. The tile query is the largest of the four a tile
 * makes; over the 34 invocations that logged `assembled` between 2026-08-05 and 2026-08-08 it
 * completed at a median of 8.3 s, p90 65 s and a maximum of 168.4 s — inside this on every one.
 *
 * Paired with `overpassDeadlineMs` in `apps/ingest-worker/src/drain.ts`, where the three numbers
 * are added up.
 */
export const OVERPASS_MAX_TOTAL_MS = 190_000;

/**
 * Requests one `OverpassClient` will have in flight when `OVERPASS_MAX_CONCURRENT` does not say
 * otherwise. Overpass allots slots per client IP and two is the documented-safe figure.
 *
 * It goes through `positive()` for the same reason `maxTotalMs` does, but the failure is worse:
 * `Math.max(1, NaN)` is `NaN`, `active < NaN` is always false, so every caller parks in the
 * semaphore's wait list and nothing ever releases. Not a leaked IP — a silent, untimed stall of
 * the whole worker, and the variable is hand-settable in both the Azure portal and Vercel.
 */
export const OVERPASS_MAX_CONCURRENT = 2;

export function getOverpass(): OverpassClient {
  if (!overpassClient) {
    overpassClient = new OverpassClient({
      url: splitList(process.env.OVERPASS_URL),
      userAgent: process.env.OVERPASS_USER_AGENT ?? '',
      maxConcurrent: positive(process.env.OVERPASS_MAX_CONCURRENT) ?? OVERPASS_MAX_CONCURRENT,
      maxTotalMs: positive(process.env.OVERPASS_MAX_TOTAL_MS) ?? OVERPASS_MAX_TOTAL_MS,
    });
  }
  return overpassClient;
}

/** A variable's number, or `undefined` when it is absent, blank, mistyped or not positive. */
function positive(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : undefined;
}

/**
 * `OVERPASS_URL` as a list of mirrors, comma- or newline-separated. An unset or blank variable
 * yields an empty list, which the client reads as "use the defaults".
 */
function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function getTerrain(): TerrainSource {
  if (!terrainSource) {
    terrainSource = new TerrainSource({
      urlTemplate: process.env.TERRAIN_TILE_URL,
      // Unconfigured is `null`, which leaves the origin as the only source — the behaviour every
      // deployment had before the shared tier existed, and the one a bad configuration falls to.
      cache: terrainCacheFromEnv() ?? undefined,
    });
  }
  return terrainSource;
}

/** The dependency bundle every pipeline entry point takes, assembled from env. */
export function pipelineDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  return {
    overpass: getOverpass(),
    terrain: getTerrain(),
    mapillaryToken: process.env.MAPILLARY_TOKEN,
    userAgent: process.env.OVERPASS_USER_AGENT,
    subdivideMaxZoom: subdivideMaxZoom(),
    trailIdentity: trailIdentityMode(),
    ...overrides,
  };
}

/** Test seam: drop the cached singletons so the next call rebuilds them from env. */
export function resetIngestSingletons(): void {
  overpassClient = null;
  terrainSource = null;
}
