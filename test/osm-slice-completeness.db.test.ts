import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { hasNodeMemberTable, tileCompleteness } from '../scripts/osm-slice/tile-completeness';

/**
 * The tile completeness predicate against a real PostGIS. The behaviour under test is entirely
 * decided by SQL — a LEFT JOIN that does not match, and a table that may not exist — so a fake
 * client would assert the query string rather than what the query does.
 */

type BBox = [number, number, number, number];

/** Well away from any real slice, so a stray row in the container cannot join this fixture. */
const BOX: BBox = [10, 45, 11, 46];
const OUTSIDE = 'LINESTRING(20 55, 20.1 55.1)';
const SCRATCH_DB = 'switchback_osm_completeness_test';

function connection(database: string): ConstructorParameters<typeof Client>[0] {
  const url = process.env.DATABASE_URL;
  if (url) {
    try {
      const parsed = new URL(url);
      return {
        host: parsed.hostname,
        port: Number(parsed.port || 5432),
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database,
      };
    } catch {
      // Unparseable: fall through to the container the osm-slice scripts document.
    }
  }
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5433),
    user: process.env.PGUSER ?? 'switchback',
    password: process.env.PGPASSWORD ?? 'switchback',
    database,
  };
}

let client: Client;
let reachable = true;

/** The two tables `switchback.lua` defines for the trail slice, and nothing else it does not. */
const SCHEMA_SQL = `
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS osm;
CREATE TABLE osm.trail_way (
  way_id bigint PRIMARY KEY,
  tags jsonb,
  geom geometry(LineString, 4326)
);
CREATE TABLE osm.trail_relation (
  relation_id bigint PRIMARY KEY,
  tags jsonb,
  members jsonb,
  geom geometry(MultiLineString, 4326)
);`;

/** A member list in the shape `switchback.lua` writes: Overpass spellings, ordered. */
function wayMembers(...refs: number[]): string {
  return JSON.stringify(refs.map((ref) => ({ type: 'way', ref, role: '' })));
}

async function insertWay(id: number, wkt: string): Promise<void> {
  await client.query(
    `INSERT INTO osm.trail_way (way_id, tags, geom)
     VALUES ($1, '{"highway":"path","name":"probe"}'::jsonb, ST_GeomFromText($2, 4326))`,
    [id, wkt],
  );
}

async function insertRelation(id: number, members: string, wkt: string): Promise<void> {
  await client.query(
    `INSERT INTO osm.trail_relation (relation_id, tags, members, geom)
     VALUES ($1, '{"type":"route","route":"hiking","name":"probe route"}'::jsonb, $2::jsonb,
             ST_Multi(ST_GeomFromText($3, 4326)))`,
    [id, members, wkt],
  );
}

/** Creates the post-hoc table for one case, then removes it — its absence is the default. */
async function withNodeMemberTable(relationId: number, wkt: string, run: () => Promise<void>) {
  await client.query(`CREATE TABLE osm.relation_node_member (
    relation_id bigint, geom geometry(Point, 4326))`);
  try {
    await client.query(
      'INSERT INTO osm.relation_node_member (relation_id, geom) VALUES ($1, ST_GeomFromText($2, 4326))',
      [relationId, wkt],
    );
    await run();
  } finally {
    await client.query('DROP TABLE osm.relation_node_member');
  }
}

beforeAll(async () => {
  const admin = new Client(connection('postgres'));
  try {
    await admin.connect();
  } catch {
    reachable = false;
    return;
  }
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.query(`CREATE DATABASE ${SCRATCH_DB}`);
  await admin.end();

  client = new Client(connection(SCRATCH_DB));
  await client.connect();
  await client.query(SCHEMA_SQL);
}, 120_000);

afterAll(async () => {
  if (!reachable) return;
  await client.end();
  const admin = new Client(connection('postgres'));
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH_DB}`);
  await admin.end();
}, 60_000);

beforeEach(async () => {
  if (!reachable) return;
  await client.query('TRUNCATE osm.trail_way, osm.trail_relation');
});

describe.sequential('tileCompleteness', () => {
  it('resolves every member of a relation whose ways are all in the slice', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(11, 'LINESTRING(10.1 45.1, 10.2 45.2)');
    await insertWay(12, 'LINESTRING(10.2 45.2, 10.3 45.3)');
    await insertRelation(1, wayMembers(11, 12), 'LINESTRING(10.1 45.1, 10.3 45.3)');

    const report = await tileCompleteness(client, BOX);

    expect(report.relations).toBe(1);
    expect(report.declaredWayMembers).toBe(2);
    expect(report.resolvedWayMembers).toBe(2);
    expect(report.incomplete).toEqual([]);
  });

  it('reports the relation and the ref when a declared way is not in the slice', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(21, 'LINESTRING(10.1 45.1, 10.2 45.2)');
    await insertRelation(2, wayMembers(21, 22), 'LINESTRING(10.1 45.1, 10.3 45.3)');

    const report = await tileCompleteness(client, BOX);

    expect(report.declaredWayMembers).toBe(2);
    expect(report.resolvedWayMembers).toBe(1);
    expect(report.incomplete).toEqual([
      { relationId: 2, name: 'probe route', declared: 2, resolved: 1, missingRefs: [22] },
    ]);
  });

  it('still scores the tile when osm.relation_node_member does not exist', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(31, 'LINESTRING(10.1 45.1, 10.2 45.2)');
    await insertRelation(3, wayMembers(31, 32), 'LINESTRING(10.1 45.1, 10.3 45.3)');

    expect(await hasNodeMemberTable(client)).toBe(false);

    const report = await tileCompleteness(client, BOX);

    expect(report.relations).toBe(1);
    expect(report.incomplete.map((r) => r.relationId)).toEqual([3]);
  });

  it('selects a relation held in the box only by a member node when that table exists', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(41, OUTSIDE);
    await insertRelation(4, wayMembers(41, 42), OUTSIDE);

    // Geometry outside the box: without the node-member term this relation is not selected at all,
    // and its missing member 42 is invisible rather than reported.
    expect((await tileCompleteness(client, BOX)).relations).toBe(0);

    await withNodeMemberTable(4, 'POINT(10.5 45.5)', async () => {
      expect(await hasNodeMemberTable(client)).toBe(true);
      const report = await tileCompleteness(client, BOX);
      expect(report.relations).toBe(1);
      expect(report.incomplete.map((r) => r.missingRefs)).toEqual([[42]]);
    });
  });
});
