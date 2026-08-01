/**
 * Process-wide ingest singletons. The Overpass queue only means anything if everyone shares
 * it: two clients at `maxConcurrent: 2` are one client at 4, which is what gets an IP blocked.
 * Lazy, because the constructor throws on a missing `OVERPASS_USER_AGENT` and a module that
 * throws at import time takes down routes that never touch ingest.
 */

import { OverpassClient } from './overpass';
import { TerrainSource } from './elevate';
import type { PipelineDeps } from './pipeline';

let overpassClient: OverpassClient | null = null;
let terrainSource: TerrainSource | null = null;

export function getOverpass(): OverpassClient {
  if (!overpassClient) {
    overpassClient = new OverpassClient({
      url: splitList(process.env.OVERPASS_URL),
      userAgent: process.env.OVERPASS_USER_AGENT ?? '',
      maxConcurrent: Number(process.env.OVERPASS_MAX_CONCURRENT ?? 2),
    });
  }
  return overpassClient;
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
    ...overrides,
  };
}

/** Test seam: drop the cached singletons so the next call rebuilds them from env. */
export function resetIngestSingletons(): void {
  overpassClient = null;
  terrainSource = null;
}
