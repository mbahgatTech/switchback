/**
 * Which member ways a divergent trail gained or lost, and what the slice knows about them.
 * The question a count cannot answer: stale extract, clipped region, or a real adapter defect.
 */

import { Client } from 'pg';
import { loadAssembleGolden } from '../../packages/ingest/test/support/raw-fixture';
import { assembleSummary } from '../../packages/ingest/test/support/raw-fixture';
import { fetchTileElements } from './measure-tile-query';

const KEYS = (process.env.KEYS ?? '').split(',').filter(Boolean);

async function main(): Promise<void> {
  const [database, quadkey, ...box] = process.argv.slice(2);
  const bbox = box.map(Number) as [number, number, number, number];

  const client = new Client({
    host: 'localhost',
    port: 5433,
    user: 'switchback',
    password: 'switchback',
    database,
  });
  await client.connect();

  const { elements } = await fetchTileElements(client, bbox);
  const actual = assembleSummary(elements);
  const golden = loadAssembleGolden('tile', quadkey!);

  const actualBy = new Map(actual.map((t) => [`${t.osmType}/${t.osmId}`, t]));

  for (const key of KEYS) {
    const g = golden.trails.find((t) => `${t.osmType}/${t.osmId}` === key);
    const a = actualBy.get(key);
    if (!g || !a) {
      console.log(key, 'missing from', !g ? 'golden' : 'sql');
      continue;
    }
    const lost = g.memberWayIds.filter((id) => !a.memberWayIds.includes(id));
    const gained = a.memberWayIds.filter((id) => !g.memberWayIds.includes(id));
    console.log(`\n=== ${key} "${g.name}" ===`);
    console.log('golden memberWayIds:', g.memberWayIds.join(','));
    console.log('sql    memberWayIds:', a.memberWayIds.join(','));
    console.log('lost:', lost.join(',') || '(none)', ' gained:', gained.join(',') || '(none)');
    console.log('lengthM golden', g.lengthM.toFixed(1), 'sql', a.lengthM.toFixed(1));

    for (const id of [...lost, ...gained]) {
      const row = await client.query(
        `SELECT w.way_id, w.tags ->> 'highway' AS highway, w.tags ->> 'name' AS name,
                ST_NPoints(w.geom) AS npoints,
                ST_Intersects(w.geom, ST_MakeEnvelope($2,$3,$4,$5,4326)) AS in_box,
                ST_AsText(ST_Envelope(w.geom)) AS envelope
         FROM osm.trail_way w WHERE w.way_id = $1`,
        [id, bbox[0], bbox[1], bbox[2], bbox[3]],
      );
      console.log(`  way ${id} in slice:`, row.rows[0] ? JSON.stringify(row.rows[0]) : 'ABSENT');
    }
  }
  await client.end();
}

void main();
