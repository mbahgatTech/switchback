/**
 * What the tile context costs against a live mirror. `fetchTileContext` runs the pair in
 * parallel, so the tile pays their maximum — the figure that decides whether a faster trail
 * source is visible end to end at all.
 */

import { buildFeatureQuery, buildRegionQuery } from '../../packages/ingest/src/overpass';
import { featureSearchBBox } from '../../packages/ingest/src/enrich';
import { getOverpass } from '../../packages/ingest/src/config';
import type { BBox, LngLat } from '../../packages/core/src/index';

const BBOX: BBox = [-122.34375, 37.160316546736766, -121.640625, 37.718590325588146];

async function main(): Promise<void> {
  const overpass = getOverpass();
  const centre: LngLat = [(BBOX[0] + BBOX[2]) / 2, (BBOX[1] + BBOX[3]) / 2];

  const startedAt = performance.now();
  const [region, features] = await Promise.all([
    (async () => {
      const t = performance.now();
      const r = await overpass.query(buildRegionQuery(centre));
      return { ms: performance.now() - t, elements: r.elements?.length ?? 0 };
    })(),
    (async () => {
      const t = performance.now();
      const r = await overpass.query(buildFeatureQuery(featureSearchBBox(BBOX)));
      return { ms: performance.now() - t, elements: r.elements?.length ?? 0 };
    })(),
  ]);
  const wallMs = performance.now() - startedAt;

  console.log(
    JSON.stringify({
      regionMs: Math.round(region.ms),
      regionElements: region.elements,
      featureMs: Math.round(features.ms),
      featureElements: features.elements,
      contextWallMs: Math.round(wallMs),
    }),
  );
}

void main();
