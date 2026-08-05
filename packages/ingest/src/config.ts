/**
 * Process-wide ingest singletons. The Overpass queue only means anything if everyone shares
 * it: two clients at `maxConcurrent: 2` are one client at 4, which is what gets an IP blocked.
 * Lazy, because the constructor throws on a missing `OVERPASS_USER_AGENT` and a module that
 * throws at import time takes down routes that never touch ingest.
 */

import { OverpassClient } from './overpass';
import { TerrainSource } from './elevate';
import { subdivideMaxZoom } from './subdivide';
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
 * that collection whole — so dropping one entry silently restored the unbounded case. Paired with
 * `OVERPASS_DEADLINE_MS` in `apps/ingest-worker/src/drain.ts`, which is where the two are added up.
 */
export const OVERPASS_MAX_TOTAL_MS = 240_000;

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
    terrainSource = new TerrainSource({ urlTemplate: process.env.TERRAIN_TILE_URL });
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
    ...overrides,
  };
}

/** Test seam: drop the cached singletons so the next call rebuilds them from env. */
export function resetIngestSingletons(): void {
  overpassClient = null;
  terrainSource = null;
}
