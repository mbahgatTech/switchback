/**
 * The tile-wide Overpass lookups every trail needs — which region the ground is in, and which
 * waypoints sit on it. Both take the tile bbox and nothing from the tile query's answer.
 */

import type { BBox, LngLat } from '@switchback/core';
import { featureSearchBBox } from './enrich';
import { OVERPASS_SKIPPED_MARKER, buildFeatureQuery, buildRegionQuery } from './overpass';
import type { OverpassElement, OverpassQuerier } from './overpass';

/**
 * What these lookups need, which is much less than `PipelineDeps` — and declared here rather
 * than imported so the dependency runs one way, from the pipeline to its lookups.
 */
export interface TileContextDeps {
  /** The shared client, or a `withDeadline` view of it — never a second client. */
  overpass: OverpassQuerier;
  /** Set false in tests that only exercise geometry; the waypoint query is then never sent. */
  enrichWaypoints?: boolean;
  logger?: (message: string, detail?: Record<string, unknown>) => void;
}

export interface RegionInfo {
  regionName: string | null;
  countryCode: string | null;
}

/** Everything a tile's trails need that is true of the tile rather than of any one trail. */
export interface TileContext {
  region: RegionInfo;
  features: OverpassElement[];
}

/**
 * Both tile-wide lookups at once. Neither half rejects — each fails soft to an empty answer — so
 * one refusal cannot discard the other's result, which is what lets them share a window.
 */
export async function fetchTileContext(
  quadkey: string,
  bbox: BBox,
  deps: TileContextDeps,
): Promise<TileContext> {
  /*
   * Two slots is what an instance allots one IP, and this fills that budget rather than widening
   * it: both calls go through the one `deps.overpass` queue, so `OVERPASS_MAX_CONCURRENT` bounds
   * the process however many callers overlap. `test/tile-context.test.ts` is what holds that.
   *
   * **A deadline cannot separate the two.** `withDeadline` refuses synchronously at call time, so
   * a serial pair refuses the second lookup when the budget expires during the first, and this
   * pair refuses neither — one request more than serial, on that path alone, and not separable
   * from the overlap. Whether the estate sends more in aggregate is UNVERIFIED: a tile that
   * finishes sooner is a tile less likely to reach a deadline at all. Settling it needs the
   * population of tiles whose budget expires inside that window, which no counter records today.
   */
  const [region, features] = await Promise.all([
    lookupRegion(bbox, deps),
    lookupFeatures(quadkey, bbox, deps),
  ]);
  return { region, features };
}

/**
 * Country and region for a tile, from one `is_in` query at its centre. Fails soft to nulls: a
 * trail with no region name is fully usable, and a boundary lookup is not worth failing a tile of
 * otherwise good data over. Soft but never silent — the log line is what makes the loss countable.
 */
export async function lookupRegion(bbox: BBox, deps: TileContextDeps): Promise<RegionInfo> {
  const centre: LngLat = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
  try {
    const response = await deps.overpass.query(buildRegionQuery(centre));
    return pickRegion(response.elements ?? []);
  } catch (error) {
    (deps.logger ?? (() => {}))(`${OVERPASS_SKIPPED_MARKER} region lookup failed`, {
      error: String(error),
    });
    return { regionName: null, countryCode: null };
  }
}

/**
 * Waypoints for the whole tile in one query rather than one per trail: forty trails would be
 * forty Overpass requests at two concurrent, for overlapping data. The per-trail assignment is
 * local, through the grid `buildFeatureIndex` puts over the answer.
 */
async function lookupFeatures(
  quadkey: string,
  bbox: BBox,
  deps: TileContextDeps,
): Promise<OverpassElement[]> {
  if (deps.enrichWaypoints === false) return [];
  try {
    const response = await deps.overpass.query(buildFeatureQuery(featureSearchBBox(bbox)));
    return response.elements ?? [];
  } catch (error) {
    // Waypoints are decoration; a trail without them is still a trail.
    (deps.logger ?? (() => {}))(`${OVERPASS_SKIPPED_MARKER} features failed`, {
      quadkey,
      error: String(error),
    });
    return [];
  }
}

/**
 * Choose the most useful administrative level present. Descending from 6 (county) to 4
 * (state/region), because the more local name is the more informative one on a trail card.
 * Level 2 is only ever read for its ISO country code, never as a display name.
 */
export function pickRegion(elements: readonly OverpassElement[]): RegionInfo {
  let regionName: string | null = null;
  let countryCode: string | null = null;
  let bestLevel = -1;

  for (const element of elements) {
    const tags = element.tags;
    if (!tags) continue;
    const level = Number(tags.admin_level);
    if (!Number.isFinite(level)) continue;

    if (level === 2) {
      const code = tags['ISO3166-1:alpha2'] ?? tags['ISO3166-1'];
      if (code && code.length === 2) countryCode = code.toUpperCase();
      continue;
    }

    const name = tags['name:en'] ?? tags.name;
    if (name && level > bestLevel) {
      regionName = name;
      bestLevel = level;
    }
  }

  return { regionName, countryCode };
}
