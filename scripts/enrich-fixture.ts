/**
 * Records the live Overpass answers the ingest tests are held to. Every shape the repository
 * asks for gets one committed recording, so no test and no benchmark queries Overpass.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { LngLat } from '@switchback/core';
import { quadkeyToBBox } from '@switchback/geo';
import { tagsByIdQuery, type OsmType } from '../packages/db/scripts/peak-elevations';
import { assembleTrails } from '../packages/ingest/src/assemble';
import { getOverpass } from '../packages/ingest/src/config';
import { featureSearchBBox } from '../packages/ingest/src/enrich';
import { buildNetworkQuery, padBBox } from '../packages/ingest/src/network';
import {
  buildFeatureQuery,
  buildParentRouteQuery,
  buildRegionQuery,
  buildRelationSkeletonQuery,
  buildRouteQuery,
  buildTileQuery,
  buildWayGeometryQuery,
  type OverpassElement,
  type OverpassRelation,
  type OverpassResponse,
} from '../packages/ingest/src/overpass';
import {
  FIXTURE_DIR,
  type EnrichFixture,
  type FixtureTrail,
} from '../packages/ingest/test/support/enrich-fixture';
import {
  RAW_FIXTURE_DIR,
  assembleSummary,
  buildRawIndex,
  goldenFile,
  loadRawFixture,
  rawFixtureFile,
  type AssembleGolden,
  type RawRecording,
  type RawShape,
} from '../packages/ingest/test/support/raw-fixture';

const USAGE = `usage: tsx scripts/enrich-fixture.ts <command>

  tile <quadkey>...              record the tile and feature answers, and derive the golden
  route <id>...                  record one route answer, whole
  parent-route <id>...           record which routes contain these relations
  relation-parts <id>            record the same relation whole, as a skeleton, and as way geometry
  region <lng> <lat> <subject>   record the administrative areas containing a point
  network <quadkey>              record the routable ways over a tile
  tags-by-id <type> <id>...      record tags for elements selected by id
  enrich <quadkey>...            rebuild the enrichment benchmark fixture (moves committed counts)
  golden <shape> <subject>...    re-derive a golden from its committed recording, offline`;

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command) throw new Error(USAGE);

  await mkdir(RAW_FIXTURE_DIR, { recursive: true });

  switch (command) {
    case 'tile':
      return recordTiles(args);
    case 'route':
      return recordOne('route', args.join('+'), buildRouteQuery(args.map(Number)));
    case 'parent-route':
      return recordOne('parent-route', args.join('+'), buildParentRouteQuery(args.map(Number)));
    case 'relation-parts':
      return recordRelationParts(Number(args[0]));
    case 'region':
      return recordRegion(args);
    case 'network':
      return recordNetwork(args[0] ?? '');
    case 'tags-by-id':
      return recordTagsById(args[0] as OsmType, args.slice(1).map(Number));
    case 'enrich':
      return writeEnrichFixtures(args);
    case 'golden':
      return writeGolden(args[0] as RawShape, args.slice(1));
    default:
      throw new Error(USAGE);
  }
}

/**
 * Every recording goes through here, on the shared client. A second client would be a second
 * queue, and two clients at `maxConcurrent: 2` are one client at 4 — which is what gets an IP
 * blocked. Callers stay serial, so a recording run holds one slot, not two.
 */
async function record(shape: RawShape, subject: string, query: string): Promise<RawRecording> {
  const started = Date.now();
  const response = await getOverpass().query(query);
  const recording: RawRecording = {
    shape,
    subject,
    query,
    recordedAt: new Date().toISOString(),
    timestampOsmBase: response.osm3s?.timestamp_osm_base ?? null,
    response,
  };

  const packed = gzipSync(Buffer.from(JSON.stringify(recording)), { level: 9 });
  await writeFile(join(RAW_FIXTURE_DIR, rawFixtureFile(shape, subject)), packed);
  console.log(
    `[${shape} ${subject}] ${response.elements?.length ?? 0} elements, ` +
      `${(packed.byteLength / 1_048_576).toFixed(2)} MiB gzipped, ` +
      `base ${recording.timestampOsmBase ?? 'unpinned'}, ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  return recording;
}

async function recordOne(shape: RawShape, subject: string, query: string): Promise<void> {
  await record(shape, subject, query);
  await writeIndex();
}

async function recordTiles(quadkeys: readonly string[]): Promise<void> {
  for (const quadkey of quadkeys) {
    const bbox = quadkeyToBBox(quadkey);
    const tile = await record('tile', quadkey, buildTileQuery(bbox));
    await deriveGolden(tile);
    await record('feature', quadkey, buildFeatureQuery(featureSearchBBox(bbox)));
  }
  await writeIndex();
}

/**
 * The same relation three ways: whole, as a bare member list, and as the geometry of its ways.
 * `fetchRelationInParts` claims the last two splice back into the first; these recordings are
 * what lets a test hold it to that.
 */
async function recordRelationParts(id: number): Promise<void> {
  const whole = await record('route', String(id), buildRouteQuery([id]));
  await deriveGolden(whole);

  const skeleton = await record('relation-skeleton', String(id), buildRelationSkeletonQuery([id]));
  const relation = skeleton.response.elements?.find(
    (element): element is OverpassRelation => element.type === 'relation' && element.id === id,
  );
  if (!relation) throw new Error(`relation ${id} is not in its own skeleton answer`);

  const wayIds = [
    ...new Set(
      (relation.members ?? []).filter((m) => m.type === 'way').map((member) => member.ref),
    ),
  ];
  if (wayIds.length === 0) throw new Error(`relation ${id} has no member ways to fetch`);

  await record('way-geometry', String(id), buildWayGeometryQuery(wayIds));
  await writeIndex();
}

async function recordRegion(args: readonly string[]): Promise<void> {
  const [lng, lat, subject] = args;
  if (!lng || !lat || !subject) throw new Error(USAGE);
  const at: LngLat = [Number(lng), Number(lat)];
  await recordOne('region', subject, buildRegionQuery(at));
}

async function recordNetwork(quadkey: string): Promise<void> {
  if (!quadkey) throw new Error(USAGE);
  await recordOne('network', quadkey, buildNetworkQuery(padBBox(quadkeyToBBox(quadkey))));
}

async function recordTagsById(osmType: OsmType, ids: readonly number[]): Promise<void> {
  await recordOne('tags-by-id', `${osmType}.${ids.length}`, tagsByIdQuery(osmType, ids));
}

/** What `assembleTrails` makes of a recording today, committed so a change to it is a diff. */
async function deriveGolden(recording: RawRecording): Promise<void> {
  const golden: AssembleGolden = {
    shape: recording.shape,
    subject: recording.subject,
    timestampOsmBase: recording.timestampOsmBase,
    trails: assembleSummary(recording.response.elements ?? []),
  };
  await mkdir(join(RAW_FIXTURE_DIR, 'golden'), { recursive: true });
  await writeFile(goldenFile(recording.shape, recording.subject), serialiseGolden(golden));
  console.log(`[${recording.shape} ${recording.subject}] golden: ${golden.trails.length} trails`);
}

/**
 * One line per trail, rather than `JSON.stringify`'s indentation. A dense tile is 1,517 trails,
 * and at twenty lines each the diff is thirty thousand lines nobody reads — where one line each
 * makes a single changed trail a single changed line.
 */
function serialiseGolden(golden: AssembleGolden): string {
  const { trails, ...head } = golden;
  const header = JSON.stringify(head, null, 2).replace(/\n\}$/, '');
  const rows = trails.map((trail) => `    ${JSON.stringify(trail)}`).join(',\n');
  return `${header},\n  "trails": [\n${rows}\n  ]\n}\n`;
}

/** Re-derive a golden from what is already committed. No network; the diff is the review. */
async function writeGolden(shape: RawShape, subjects: readonly string[]): Promise<void> {
  for (const subject of subjects) await deriveGolden(loadRawFixture(shape, subject));
}

/**
 * The index every recording appears in, sorted so a re-record is a one-line diff. Rebuilt from
 * the files on disk rather than appended to, so a deleted recording leaves no phantom row — and
 * rebuilt by the function a test re-runs, so a stale index cannot pass for a current one.
 */
async function writeIndex(): Promise<void> {
  const entries = buildRawIndex();
  await writeFile(join(RAW_FIXTURE_DIR, 'index.json'), `${JSON.stringify(entries, null, 2)}\n`);
  console.log(`index: ${entries.length} recordings`);
}

/**
 * Rebuilds the enrichment benchmark fixtures. Separate from `tile` and never run incidentally:
 * `enrich-association.test.ts` asserts their element counts exactly, so a re-record is a
 * deliberate act that updates those numbers in the same change.
 */
async function writeEnrichFixtures(quadkeys: readonly string[]): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });

  for (const quadkey of quadkeys) {
    const bbox = quadkeyToBBox(quadkey);
    const featureBBox = featureSearchBBox(bbox);

    const tile = await getOverpass().query(buildTileQuery(bbox));
    const trails = assembleTrails(tile.elements ?? []).map((trail): FixtureTrail => ({
      osmType: trail.osmType,
      osmId: trail.osmId,
      name: trail.name,
      coords: trail.coords,
    }));

    const featureResponse: OverpassResponse = await getOverpass().query(
      buildFeatureQuery(featureBBox),
    );
    const features: OverpassElement[] = featureResponse.elements ?? [];

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
        `${trails.length} trails, ${features.length} features)`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
