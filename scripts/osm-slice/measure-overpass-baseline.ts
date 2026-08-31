/**
 * A freshly measured Overpass baseline for the fixture tiles, through the shared client so the
 * queue, mirror rotation and budget are the ones production uses. Serial by design: a second
 * process is a second queue against a per-IP slot allowance.
 */

import { buildTileQuery } from '../../packages/ingest/src/overpass';
import { getOverpass } from '../../packages/ingest/src/config';

const TILES: Array<{ quadkey: string; bbox: [number, number, number, number] }> = [
  { quadkey: '021231030', bbox: [-116.71875, 47.5172006978394, -116.015625, 47.98992166741418] },
  {
    quadkey: '023010230',
    bbox: [-122.34375, 37.160316546736766, -121.640625, 37.718590325588146],
  },
];

async function main(): Promise<void> {
  const overpass = getOverpass();
  for (const { quadkey, bbox } of TILES) {
    const startedAt = performance.now();
    try {
      const response = await overpass.query(buildTileQuery(bbox));
      const ms = performance.now() - startedAt;
      console.log(
        JSON.stringify({
          quadkey,
          overpassMs: Math.round(ms),
          elements: response.elements?.length ?? 0,
          timestampOsmBase: response.osm3s?.timestamp_osm_base ?? null,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          quadkey,
          overpassMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
}

void main();
