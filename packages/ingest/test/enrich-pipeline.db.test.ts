/**
 * Enrichment through the whole pipeline, against a real PostGIS. The unit suite tests
 * `buildFeatureIndex` and `attachWaypoints` apart; this is the only place that proves the commit
 * path still puts waypoints on rows now that it reads them through the index.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '@switchback/db';
import type { LngLat } from '@switchback/core';
import { EARTH_RADIUS_M } from '@switchback/geo';
import { TerrainSource } from '../src/elevate';
import { attachWaypoints } from '../src/enrich';
import { processTile } from '../src/pipeline';
import type { PipelineDeps } from '../src/pipeline';
import type { OverpassElement, OverpassQuerier } from '../src/overpass';
import { trailEnrichJobKey } from '../src/jobs';
import { flatTile, pngResponse } from './fixtures/terrarium';

const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

const DEG = Math.PI / 180;
const PREFIX = 'ZZ Enrich';
const QUADKEY = '120230203';
/** Inside `120230203`, so `processTile`'s own bbox contains the line. */
const LAT = 46.3;
const LNG = 12.62;
const WAY_ID = 910_001;

function north(from: LngLat, metres: number): LngLat {
  return [from[0], from[1] + metres / (EARTH_RADIUS_M * DEG)];
}

function east(from: LngLat, metres: number): LngLat {
  return [from[0] + metres / (EARTH_RADIUS_M * DEG * Math.cos(from[1] * DEG)), from[1]];
}

const START: LngLat = [LNG, LAT];
const COORDS: LngLat[] = [START, east(START, 1_000), east(START, 2_000)];

const trailWay: OverpassElement = {
  type: 'way',
  id: WAY_ID,
  tags: { name: `${PREFIX} Ridge`, highway: 'path' },
  geometry: COORDS.map(([lon, lat]) => ({ lat, lon })),
};

function node(id: number, at: LngLat, tags: Record<string, string>): OverpassElement {
  return { type: 'node', id, lat: at[1], lon: at[0], tags };
}

/**
 * One of each outcome: on the line, inside the parking buffer but outside the waypoint one, and
 * beyond both. Without the third the test could not tell an index from no index at all.
 */
const SUMMIT = node(920_001, north(east(START, 1_000), 80), {
  natural: 'peak',
  name: `${PREFIX} Peak`,
});
const CAR_PARK = node(920_002, north(east(START, 500), 300), {
  amenity: 'parking',
  name: `${PREFIX} Trailhead`,
});
const FAR_PEAK = node(920_003, north(east(START, 1_000), 4_000), {
  natural: 'peak',
  name: `${PREFIX} Distant`,
});
const FEATURES = [SUMMIT, CAR_PARK, FAR_PEAK];

/** The tile query and the feature query hit the same mock, so they are told apart by shape. */
function overpass(): OverpassQuerier {
  return {
    query: (q: string) => {
      if (q.includes('is_in(')) return Promise.resolve({ elements: [] });
      if (q.includes('"natural"~"^(peak')) return Promise.resolve({ elements: [...FEATURES] });
      return Promise.resolve({ elements: [trailWay] });
    },
  };
}

const terrain = new TerrainSource({
  fetchImpl: () => Promise.resolve(pngResponse(flatTile(1000))),
});

function deps(): PipelineDeps {
  return {
    db: prisma,
    overpass: overpass(),
    terrain,
    trailIdentity: 'claim',
  } satisfies PipelineDeps;
}

async function reset(): Promise<void> {
  const doomed = await prisma.trail.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = doomed.map((row) => row.id);
  await prisma.ingestJob.deleteMany({ where: { dedupeKey: { in: ids.map(trailEnrichJobKey) } } });
  await prisma.trail.deleteMany({ where: { id: { in: ids } } });
  await prisma.trailWay.deleteMany({ where: { wayId: BigInt(WAY_ID) } });
  await prisma.ingestTile.deleteMany({ where: { quadkey: QUADKEY } });
  await prisma.ingestJob.deleteMany({ where: { dedupeKey: `ingest_tile:${QUADKEY}` } });
}

describe.skipIf(!IS_LOCAL).sequential('waypoints reach the row through the feature index', () => {
  beforeEach(reset);
  afterAll(async () => {
    await reset();
    await prisma.$disconnect();
  });

  it('attaches exactly what an unindexed pass would, and nothing beyond the buffers', async () => {
    // The control the assertion below is measured against, and the reason the fixture is not
    // just three ids in a list: if the buffers move, this moves with them.
    const expected = attachWaypoints(COORDS, FEATURES);
    expect(expected.map((waypoint) => Number(waypoint.osmId))).toEqual([SUMMIT.id, CAR_PARK.id]);

    const result = await processTile(QUADKEY, deps());
    expect(result.trailCount).toBe(1);

    const trail = await prisma.trail.findFirstOrThrow({
      where: { name: { startsWith: PREFIX } },
      select: { id: true },
    });
    const stored = await prisma.waypoint.findMany({
      where: { trailId: trail.id, osmId: { not: null } },
      orderBy: { distM: 'asc' },
      select: { osmId: true, kind: true, name: true, distM: true },
    });

    expect(stored.map((row) => Number(row.osmId))).toEqual(
      expected.map((waypoint) => Number(waypoint.osmId)),
    );
    expect(stored.map((row) => row.kind)).toEqual(expected.map((waypoint) => waypoint.kind));
    // Parking sits off the line, so its `distM` is null and the summit's is not — the two halves
    // of `attachWaypoints`'s buffer rule, both observed on a stored row.
    expect(stored.find((row) => row.kind === 'summit')!.distM).toBeGreaterThan(0);
    expect(stored.find((row) => row.kind === 'parking')!.distM).toBeNull();
    expect(stored.some((row) => Number(row.osmId) === FAR_PEAK.id)).toBe(false);
  }, 60_000);

  it('leaves the synthesised trailhead alone', async () => {
    await processTile(QUADKEY, deps());
    const trail = await prisma.trail.findFirstOrThrow({
      where: { name: { startsWith: PREFIX } },
      select: { id: true },
    });
    const trailhead = await prisma.waypoint.findMany({
      where: { trailId: trail.id, kind: 'trailhead' },
      select: { distM: true, lng: true, lat: true },
    });
    expect(trailhead).toHaveLength(1);
    expect(trailhead[0]!.distM).toBe(0);
  }, 60_000);
});
