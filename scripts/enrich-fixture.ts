/**
 * Caches a tile's Overpass answers as a committed fixture, so no benchmark run queries Overpass.
 * Raw answers also land in the gitignored `.cache/overpass/`.
 */

import { gzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { quadkeyToBBox } from '@switchback/geo';
import { assembleTrails } from '../packages/ingest/src/assemble';
import { featureSearchBBox } from '../packages/ingest/src/enrich';
import {
  OverpassClient,
  buildFeatureQuery,
  buildTileQuery,
  type OverpassElement,
  type OverpassResponse,
} from '../packages/ingest/src/overpass';
import {
  FIXTURE_DIR,
  type EnrichFixture,
  type FixtureTrail,
} from '../packages/ingest/test/support/enrich-fixture';

const CACHE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'overpass');

/**
 * One at a time, not two. The 2-concurrent bound is per client IP across every Switchback
 * process, and a fixture build is not worth spending the production drainer's half of it.
 */
const MAX_CONCURRENT = 1;

async function main(): Promise<void> {
  const quadkeys = process.argv.slice(2);
  if (quadkeys.length === 0) {
    throw new Error('usage: tsx scripts/enrich-fixture.ts <quadkey> [quadkey...]');
  }

  const userAgent = process.env.OVERPASS_USER_AGENT;
  if (!userAgent) throw new Error('OVERPASS_USER_AGENT is required');

  const client = new OverpassClient({
    url: process.env.OVERPASS_URL?.split(','),
    userAgent,
    maxConcurrent: MAX_CONCURRENT,
    requestTimeoutMs: 300_000,
  });

  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(FIXTURE_DIR, { recursive: true });

  for (const quadkey of quadkeys) {
    const bbox = quadkeyToBBox(quadkey);
    const featureBBox = featureSearchBBox(bbox);

    console.log(`[${quadkey}] tile query over ${bbox.join(',')}`);
    const tile = await run(client, buildTileQuery(bbox), join(CACHE_DIR, `${quadkey}.tile.json`));
    const trails = assembleTrails(tile.elements ?? []).map((trail): FixtureTrail => ({
      osmType: trail.osmType,
      osmId: trail.osmId,
      name: trail.name,
      coords: trail.coords,
    }));
    console.log(`[${quadkey}] ${tile.elements?.length ?? 0} elements -> ${trails.length} trails`);

    console.log(`[${quadkey}] feature query over ${featureBBox.join(',')}`);
    const featureResponse = await run(
      client,
      buildFeatureQuery(featureBBox),
      join(CACHE_DIR, `${quadkey}.features.json`),
    );
    const features: OverpassElement[] = featureResponse.elements ?? [];
    console.log(`[${quadkey}] ${features.length} features`);

    const fixture: EnrichFixture = {
      quadkey,
      bbox,
      featureBBox,
      fetchedAt: new Date().toISOString(),
      timestampOsmBase: featureResponse.osm3s?.timestamp_osm_base ?? null,
      vertexCount: trails.reduce((sum, trail) => sum + trail.coords.length, 0),
      trails,
      features,
    };

    const path = join(FIXTURE_DIR, `${quadkey}.json.gz`);
    const packed = gzipSync(Buffer.from(JSON.stringify(fixture)), { level: 9 });
    await writeFile(path, packed);
    console.log(
      `[${quadkey}] wrote ${path} (${(packed.byteLength / 1_048_576).toFixed(2)} MiB gzipped, ` +
        `${fixture.vertexCount} vertices)`,
    );
  }
}

async function run(
  client: OverpassClient,
  ql: string,
  cachePath: string,
): Promise<OverpassResponse> {
  const started = Date.now();
  const response = await client.query(ql);
  console.log(`  ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await writeFile(cachePath, JSON.stringify(response));
  return response;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
