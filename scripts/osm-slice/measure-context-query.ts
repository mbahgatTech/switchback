/**
 * The SQL equivalent of `buildRegionQuery` and `buildFeatureQuery`, timed and held to the
 * recorded Overpass answers. Reads the context slice built by `measure-context-extract.sh`.
 */

import { Client } from 'pg';
import { classifyWaypoint, featurePosition, featureSearchBBox } from '../../packages/ingest/src/enrich';
import { pickRegion } from '../../packages/ingest/src/tile-context';
import { loadRawFixture } from '../../packages/ingest/test/support/raw-fixture';
import type { OverpassElement } from '../../packages/ingest/src/overpass';

type BBox = [number, number, number, number];

/*
 * `is_in` returns the areas covering a point. An area is a closed boundary relation, so the SQL
 * equivalent is containment against the polygons the slice could close — which is not all of
 * them, and the gap is the finding rather than a bug to route around.
 */
const REGION_SQL = `
SELECT tags
FROM osm.admin_area
WHERE geom IS NOT NULL
  AND geom && ST_SetSRID(ST_MakePoint($1, $2), 4326)
  AND ST_Contains(geom, ST_SetSRID(ST_MakePoint($1, $2), 4326))`;

/** The eleven node classes buildFeatureQuery names, as one predicate over the tag jsonb. */
const FEATURE_NODE_SQL = `
SELECT 'node' AS type, node_id AS id, tags,
       ST_X(geom) AS lon, ST_Y(geom) AS lat
FROM osm.feature_node
WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
ORDER BY node_id`;

/**
 * `out center` reports the centre of the bounding box, but selection is by the way itself: a car
 * park straddling the tile edge is in Overpass's answer with its centre outside the box. So the
 * ring decides membership and the precomputed centre is what comes back.
 */
const FEATURE_WAY_SQL = `
SELECT 'way' AS type, way_id AS id, tags,
       ST_X(center) AS lon, ST_Y(center) AS lat
FROM osm.feature_way
WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
  AND ST_Intersects(geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
ORDER BY way_id`;

export interface ContextAnswer {
  region: OverpassElement[];
  features: OverpassElement[];
  regionMs: number;
  featureMs: number;
}

/** Both context lookups, shaped as the elements `pickRegion` and `buildFeatureIndex` read. */
export async function fetchContext(
  client: Client,
  bbox: BBox,
  at: [number, number],
): Promise<ContextAnswer> {
  const search = featureSearchBBox(bbox);

  const t0 = performance.now();
  const region = await client.query(REGION_SQL, [at[0], at[1]]);
  const regionMs = performance.now() - t0;

  const t1 = performance.now();
  const [nodes, ways] = await Promise.all([
    client.query(FEATURE_NODE_SQL, search),
    client.query(FEATURE_WAY_SQL, search),
  ]);
  const featureMs = performance.now() - t1;

  const features: OverpassElement[] = [
    ...nodes.rows.map(
      (r) => ({ type: 'node', id: Number(r.id), lat: r.lat, lon: r.lon, tags: r.tags }) as OverpassElement,
    ),
    ...ways.rows.map(
      (r) =>
        ({
          type: 'way',
          id: Number(r.id),
          center: { lat: r.lat, lon: r.lon },
          tags: r.tags,
        }) as OverpassElement,
    ),
  ];

  return {
    region: region.rows.map((r) => ({ type: 'area', id: 0, tags: r.tags }) as OverpassElement),
    features,
    regionMs,
    featureMs,
  };
}

/**
 * A feature reduced to what actually reaches a trail: the classifier's verdict and the point
 * `attachWaypoints` measures from. Features no rule classifies are dropped here exactly as
 * `buildFeatureIndex` drops them, so the comparison is over the set that can change an answer.
 */
interface FeatureRow {
  key: string;
  kind: string;
  lon: number;
  lat: number;
  name: string;
}

function featureSummary(elements: readonly OverpassElement[]): Map<string, FeatureRow> {
  const out = new Map<string, FeatureRow>();
  for (const element of elements) {
    if (element.type !== 'node' && element.type !== 'way') continue;
    const kind = classifyWaypoint(element.tags ?? {});
    if (!kind) continue;
    const at = featurePosition(element);
    if (!at) continue;
    const key = `${element.type}/${element.id}`;
    out.set(key, {
      key,
      kind,
      lon: at[0],
      lat: at[1],
      name: (element.tags?.name as string) ?? '',
    });
  }
  return out;
}

/** Metres between two lng/lat points, for reporting how far a centre moved. */
function metresApart(a: FeatureRow, b: FeatureRow): number {
  const R = 6371008.8;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const x = dLon * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

function compareFeatures(golden: readonly OverpassElement[], actual: readonly OverpassElement[]) {
  const g = featureSummary(golden);
  const a = featureSummary(actual);
  const missing = [...g.keys()].filter((k) => !a.has(k));
  const extra = [...a.keys()].filter((k) => !g.has(k));

  const kindChanged: string[] = [];
  const moved: Array<{ key: string; metres: number }> = [];
  for (const [key, gr] of g) {
    const ar = a.get(key);
    if (!ar) continue;
    if (gr.kind !== ar.kind) kindChanged.push(`${key} ${gr.kind}->${ar.kind}`);
    const d = metresApart(gr, ar);
    if (d > 0.5) moved.push({ key, metres: +d.toFixed(2) });
  }

  return {
    goldenKept: g.size,
    sqlKept: a.size,
    missing: missing.length,
    extra: extra.length,
    kindChanged: kindChanged.length,
    movedOver0m5: moved.length,
    maxMoveM: moved.length ? Math.max(...moved.map((m) => m.metres)) : 0,
    missingSample: missing.slice(0, 8),
    extraSample: extra.slice(0, 8),
    kindChangedSample: kindChanged.slice(0, 8),
    movedSample: moved.sort((x, y) => y.metres - x.metres).slice(0, 8),
  };
}

/**
 * Positive control. A parity run that has not been seen failing proves nothing, so `PERTURB`
 * damages the SQL answer in one named way and the diff must catch it.
 */
function perturb(answer: ContextAnswer, mode: string): ContextAnswer {
  if (mode === 'drop-feature') return { ...answer, features: answer.features.slice(1) };
  if (mode === 'shift-centre') {
    return {
      ...answer,
      features: answer.features.map((e) => {
        const w = e as { type: string; center?: { lat: number; lon: number } };
        if (w.type !== 'way' || !w.center) return e;
        return { ...e, center: { lat: w.center.lat, lon: w.center.lon + 1e-4 } } as OverpassElement;
      }),
    };
  }
  if (mode === 'drop-region') return { ...answer, region: [] };
  throw new Error(`unknown PERTURB mode "${mode}"`);
}

async function main(): Promise<void> {
  const [database, quadkey, ...box] = process.argv.slice(2);
  const bbox = box.map(Number) as BBox;
  const runs = Number(process.env.RUNS ?? 5);
  const centre: [number, number] = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];

  const client = new Client({
    host: 'localhost',
    port: 5433,
    user: 'switchback',
    password: 'switchback',
    database,
  });
  await client.connect();

  const timings: Array<{ regionMs: number; featureMs: number }> = [];
  let answer: ContextAnswer | null = null;
  for (let i = 0; i < runs; i++) {
    const fetched = await fetchContext(client, bbox, centre);
    answer = process.env.PERTURB ? perturb(fetched, process.env.PERTURB) : fetched;
    timings.push({ regionMs: fetched.regionMs, featureMs: fetched.featureMs });
  }

  const median = (xs: number[]): number => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const regionMs = median(timings.map((t) => t.regionMs));
  const featureMs = median(timings.map((t) => t.featureMs));

  console.log(
    JSON.stringify(
      {
        quadkey,
        database,
        runs,
        regionMsMedian: +regionMs.toFixed(1),
        featureMsMedian: +featureMs.toFixed(1),
        // The pipeline runs the pair in parallel, so a tile pays their maximum, not their sum.
        contextMsParallel: +Math.max(regionMs, featureMs).toFixed(1),
        regionAreas: answer!.region.length,
        featureElements: answer!.features.length,
      },
      null,
      2,
    ),
  );

  // Only the sparse tile has a recorded `is_in` answer. Where there is none the region half is
  // reported as unmeasured rather than skipped silently, and the feature half still runs.
  let goldenRegion: OverpassElement[] | null = null;
  try {
    goldenRegion = loadRawFixture('region', quadkey!).response.elements ?? [];
  } catch {
    goldenRegion = null;
  }
  const goldenFeature = loadRawFixture('feature', quadkey!).response.elements ?? [];

  console.log(
    JSON.stringify(
      {
        region: {
          golden: goldenRegion ? pickRegion(goldenRegion) : 'UNVERIFIED: no recording',
          sql: pickRegion(answer!.region),
          goldenAreas: goldenRegion ? goldenRegion.length : null,
          sqlAreas: answer!.region.length,
        },
        features: compareFeatures(goldenFeature, answer!.features),
      },
      null,
      2,
    ),
  );

  await client.end();
}

if (/measure-context-query/.test(process.argv[1] ?? '')) void main();
