/**
 * The SQL equivalent of `buildTileQuery`, timed and held to the committed golden. Reads the
 * PostGIS slice built by `measure-extract.sh` and emits the element shape `assembleTrails` reads.
 */

import { Client } from 'pg';
import { assembleSummary, loadAssembleGolden } from './raw-fixtures';
import type {
  OverpassElement,
  OverpassRelation,
  OverpassRelationMember,
} from '../../packages/ingest/src/overpass';

type BBox = [number, number, number, number];

/** `way["highway"~"^(...)$"]["name"]` — the trail query's way statement. */
const TRAIL_HIGHWAY = ['path', 'footway', 'track', 'bridleway', 'steps', 'cycleway'];

/*
 * `ORDER BY way_id` is not cosmetic. `chainWays` is greedy and seeds in iteration order, so the
 * order ways arrive in decides which line a branchy name group yields and therefore the
 * `Math.min(wayIds)` that becomes the trail's osmId. Overpass emits ascending by id; anything
 * else silently produces a different — not wrong-looking, just different — set of trails.
 */
const WAY_SQL = `
SELECT w.way_id, w.tags, ST_AsGeoJSON(w.geom, 9)::jsonb -> 'coordinates' AS coords
FROM osm.trail_way w
WHERE w.tags ->> 'highway' = ANY($5)
  AND w.tags ? 'name'
  AND w.geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
  AND ST_Intersects(w.geom, ST_MakeEnvelope($1, $2, $3, $4, 4326))
ORDER BY w.way_id`;

/*
 * One row per member, ordinality carried through: a route relation is an ordered member list in
 * OSM and `assembleTrails` chains by endpoint, so losing the order loses the chain.
 *
 * A relation is selected by its member WAYS' geometry or by a member NODE's position, because
 * `relation(bbox)` returns either. `measure-node-members.ts` builds that second table and reports
 * how much it adds — two relations in northern California, none in Idaho, for 24 kB.
 */
const RELATION_SQL = `
WITH box AS (SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS g),
rel AS (
  SELECT r.relation_id, r.tags, r.members
  FROM osm.trail_relation r, box
  WHERE r.tags ->> 'route' IN ('hiking', 'foot', 'walking', 'running')
    AND (
      (r.geom && box.g AND ST_Intersects(r.geom, box.g))
      OR EXISTS (
        SELECT 1 FROM osm.relation_node_member n
        WHERE n.relation_id = r.relation_id AND n.geom && box.g
      )
    )
)
SELECT rel.relation_id, rel.tags, m.ord,
       m.value ->> 'type' AS mtype,
       (m.value ->> 'ref')::bigint AS ref,
       m.value ->> 'role' AS role,
       ST_AsGeoJSON(w.geom, 9)::jsonb -> 'coordinates' AS coords
FROM rel
CROSS JOIN LATERAL jsonb_array_elements(rel.members) WITH ORDINALITY AS m(value, ord)
LEFT JOIN osm.trail_way w ON m.value ->> 'type' = 'way' AND w.way_id = (m.value ->> 'ref')::bigint
ORDER BY rel.relation_id, m.ord`;

type Coord = [number, number];

/** The two row shapes above, named so the rows arrive typed instead of as `any`. */
interface WayRow {
  way_id: string;
  tags: Record<string, string>;
  coords: Coord[] | null;
}

interface MemberRow {
  relation_id: string;
  tags: Record<string, string>;
  ord: string;
  mtype: string;
  ref: string;
  role: string | null;
  coords: Coord[] | null;
}

function toGeometry(coords: Coord[] | null): Array<{ lat: number; lon: number }> | undefined {
  if (!coords) return undefined;
  return coords.map(([lon, lat]) => ({ lat, lon }));
}

export async function fetchTileElements(
  client: Client,
  bbox: BBox,
): Promise<{ elements: OverpassElement[]; sqlMs: number; shapeMs: number }> {
  const [w, s, e, n] = bbox;
  const t0 = performance.now();
  const [ways, members] = await Promise.all([
    client.query<WayRow>(WAY_SQL, [w, s, e, n, TRAIL_HIGHWAY]),
    client.query<MemberRow>(RELATION_SQL, [w, s, e, n]),
  ]);
  const sqlMs = performance.now() - t0;

  const t1 = performance.now();
  const elements: OverpassElement[] = [];
  const byRelation = new Map<number, OverpassRelation>();

  // Ways first, then relations, each ascending by id — the order Overpass emits.
  for (const row of ways.rows) {
    elements.push({
      type: 'way',
      id: Number(row.way_id),
      tags: row.tags,
      geometry: toGeometry(row.coords),
    });
  }

  for (const row of members.rows) {
    let relation = byRelation.get(Number(row.relation_id));
    if (!relation) {
      relation = {
        type: 'relation',
        id: Number(row.relation_id),
        tags: row.tags,
        members: [],
      };
      byRelation.set(Number(row.relation_id), relation);
      elements.push(relation);
    }
    relation.members.push({
      type: row.mtype as OverpassRelationMember['type'],
      ref: Number(row.ref),
      role: row.role ?? '',
      geometry: toGeometry(row.coords),
    });
  }
  const shapeMs = performance.now() - t1;

  assertAscendingWayIds(elements);
  return { elements, sqlMs, shapeMs };
}

/**
 * The ordering `chainWays` depends on, checked rather than commented. osm2pgsql clusters by
 * geometry, so a query that loses `ORDER BY way_id` still returns the right trail *count* with
 * silently different trails — the failure this asserts against is invisible in every other number
 * the harness prints.
 */
function assertAscendingWayIds(elements: readonly OverpassElement[]): void {
  let previous = -Infinity;
  for (const element of elements) {
    if (element.type !== 'way') continue;
    if (element.id < previous) {
      throw new Error(
        `ways reached assembleTrails out of order: ${element.id} after ${previous}. ` +
          'chainWays seeds in iteration order, so this changes which trails are produced.',
      );
    }
    previous = element.id;
  }
}

interface Divergence {
  key: string;
  field: string;
  golden: unknown;
  sql: unknown;
}

function keyOf(t: { osmType: string; osmId: number }): string {
  return `${t.osmType}/${t.osmId}`;
}

/** Field-by-field diff of two summaries, keyed on the identity the catalogue stores. */
function compare(
  golden: ReturnType<typeof assembleSummary>,
  actual: ReturnType<typeof assembleSummary>,
): { missing: string[]; extra: string[]; divergences: Divergence[] } {
  const goldenBy = new Map(golden.map((t) => [keyOf(t), t]));
  const actualBy = new Map(actual.map((t) => [keyOf(t), t]));

  const missing = [...goldenBy.keys()].filter((k) => !actualBy.has(k));
  const extra = [...actualBy.keys()].filter((k) => !goldenBy.has(k));

  const divergences: Divergence[] = [];
  for (const [key, g] of goldenBy) {
    const a = actualBy.get(key);
    if (!a) continue;
    if (g.name !== a.name) divergences.push({ key, field: 'name', golden: g.name, sql: a.name });
    if (JSON.stringify(g.memberWayIds) !== JSON.stringify(a.memberWayIds)) {
      divergences.push({
        key,
        field: 'memberWayIds',
        golden: g.memberWayIds.length,
        sql: a.memberWayIds.length,
      });
    }
    if (Math.abs(g.lengthM - a.lengthM) > 0.5) {
      divergences.push({ key, field: 'lengthM', golden: g.lengthM, sql: a.lengthM });
    }
    if (g.coords.sha256 !== a.coords.sha256) {
      divergences.push({
        key,
        field: 'coords.sha256',
        golden: `${g.coords.vertices}v`,
        sql: `${a.coords.vertices}v`,
      });
    }
  }
  return { missing, extra, divergences };
}

/**
 * Positive control. A comparison that reports parity is worth nothing until it has been seen
 * failing, so `PERTURB` damages the SQL answer in one named way and the diff must catch it.
 */
function perturb(elements: OverpassElement[], mode: string): OverpassElement[] {
  if (mode === 'order') return [...elements].reverse();

  if (mode === 'drop') {
    const firstWay = elements.findIndex((e) => e.type === 'way');
    return elements.filter((_, i) => i !== firstWay);
  }

  if (mode === 'coords') {
    // 1e-6 degrees — ten times the quantum `digestCoords` rounds to, so it cannot hide.
    const shift = (g?: Array<{ lat: number; lon: number }>) =>
      g?.map((p) => ({ lat: p.lat, lon: p.lon + 1e-6 }));
    return elements.map((element) => {
      const e = element as { type: string; geometry?: []; members?: Array<{ geometry?: [] }> };
      if (e.type === 'way') return { ...element, geometry: shift(e.geometry) } as OverpassElement;
      return {
        ...element,
        members: e.members?.map((m) => ({ ...m, geometry: shift(m.geometry) })),
      } as OverpassElement;
    });
  }

  throw new Error(`unknown PERTURB mode "${mode}"`);
}

async function main(): Promise<void> {
  const [database, quadkey, ...box] = process.argv.slice(2);
  const bbox = box.map(Number) as BBox;
  const runs = Number(process.env.RUNS ?? 5);

  const client = new Client({
    host: 'localhost',
    port: 5433,
    user: 'switchback',
    password: 'switchback',
    database,
  });
  await client.connect();

  const timings: Array<{ sqlMs: number; shapeMs: number; assembleMs: number }> = [];
  let elements: OverpassElement[] = [];
  let summary: ReturnType<typeof assembleSummary> = [];

  for (let i = 0; i < runs; i++) {
    const fetched = await fetchTileElements(client, bbox);
    const mode = process.env.PERTURB;
    const used = mode ? perturb(fetched.elements, mode) : fetched.elements;
    const t2 = performance.now();
    summary = assembleSummary(used);
    const assembleMs = performance.now() - t2;
    elements = used;
    timings.push({ sqlMs: fetched.sqlMs, shapeMs: fetched.shapeMs, assembleMs });
  }

  const median = (xs: number[]): number =>
    xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  const report = {
    quadkey,
    database,
    runs,
    elements: elements.length,
    trails: summary.length,
    sqlMsMedian: +median(timings.map((t) => t.sqlMs)).toFixed(1),
    sqlMsAll: timings.map((t) => +t.sqlMs.toFixed(1)),
    shapeMsMedian: +median(timings.map((t) => t.shapeMs)).toFixed(1),
    assembleMsMedian: +median(timings.map((t) => t.assembleMs)).toFixed(1),
    sourceMsMedian: +median(timings.map((t) => t.sqlMs + t.shapeMs)).toFixed(1),
  };
  console.log(JSON.stringify(report, null, 2));

  const golden = loadAssembleGolden('tile', quadkey!);
  if (!golden) {
    // Timings above stand on their own; only the parity half needs a recording to compare against.
    console.log(
      JSON.stringify({ parity: 'UNVERIFIED: no golden recorded for this tile' }, null, 2),
    );
    await client.end();
    return;
  }
  const diff = compare(golden.trails, summary);
  console.log(
    JSON.stringify(
      {
        parity: {
          goldenTrails: golden.trails.length,
          sqlTrails: summary.length,
          missing: diff.missing.length,
          extra: diff.extra.length,
          divergences: diff.divergences.length,
          missingSample: diff.missing.slice(0, 10),
          extraSample: diff.extra.slice(0, 10),
          divergenceSample: diff.divergences.slice(0, 10),
        },
      },
      null,
      2,
    ),
  );

  await client.end();
}

// Guarded so the adapter above can be imported by the divergence diagnostic without running.
if (/measure-tile-query/.test(process.argv[1] ?? '')) void main();
