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
const INSIDE = 'LINESTRING(10.1 45.1, 10.3 45.3)';
/** Starts in the box and runs off it: the normal shape of a route relation on a z9 tile. */
const CROSSING = 'LINESTRING(10.9 45.9, 11.5 46.5)';
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

interface Member {
  type: 'way' | 'node' | 'relation';
  ref: number;
  role?: string;
}

/** A member list in the shape `switchback.lua` writes: Overpass spellings, ordered. */
function members(...list: Member[]): string {
  return JSON.stringify(list.map(({ role = '', ...rest }) => ({ ...rest, role })));
}

/** The common case. Anything mixing member types builds its list with `members` instead. */
function wayMembers(...refs: number[]): string {
  return members(...refs.map((ref) => ({ type: 'way' as const, ref })));
}

async function insertWay(id: number, wkt: string): Promise<void> {
  await client.query(
    `INSERT INTO osm.trail_way (way_id, tags, geom)
     VALUES ($1, '{"highway":"path","name":"probe"}'::jsonb, ST_GeomFromText($2, 4326))`,
    [id, wkt],
  );
}

async function insertRelation(
  id: number,
  memberList: string,
  wkt: string,
  route = 'hiking',
): Promise<void> {
  await client.query(
    `INSERT INTO osm.trail_relation (relation_id, tags, members, geom)
     VALUES ($1, jsonb_build_object('type', 'route', 'route', $2::text, 'name', 'probe route'),
             $3::jsonb, ST_Multi(ST_GeomFromText($4, 4326)))`,
    [id, route, memberList, wkt],
  );
}

/** Creates the post-hoc table for one case, then removes it — its absence is the default. */
async function withNodeMemberTable(
  rows: ReadonlyArray<{ relationId: number; wkt: string }>,
  run: () => Promise<void>,
) {
  await client.query(`CREATE TABLE osm.relation_node_member (
    relation_id bigint, geom geometry(Point, 4326))`);
  try {
    for (const row of rows) {
      await client.query(
        'INSERT INTO osm.relation_node_member (relation_id, geom) VALUES ($1, ST_GeomFromText($2, 4326))',
        [row.relationId, row.wkt],
      );
    }
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
    await insertRelation(1, wayMembers(11, 12), INSIDE);

    const report = await tileCompleteness(client, BOX);

    expect(report.relations).toBe(1);
    expect(report.declaredWayMembers).toBe(2);
    expect(report.resolvedWayMembers).toBe(2);
    expect(report.incomplete).toEqual([]);
  });

  it('reports the relation and the ref when a declared way is not in the slice', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(21, 'LINESTRING(10.1 45.1, 10.2 45.2)');
    await insertRelation(2, wayMembers(21, 22), INSIDE);

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
    await insertRelation(3, wayMembers(31, 32), INSIDE);

    expect(await hasNodeMemberTable(client)).toBe(false);

    const report = await tileCompleteness(client, BOX);

    expect(report.relations).toBe(1);
    expect(report.incomplete.map((r) => r.relationId)).toEqual([3]);
  });

  /*
   * Containment and intersection agree on every relation that lies wholly inside or wholly
   * outside a tile, so only a relation crossing the edge tells the two apart — and that is the
   * ordinary case, not the exotic one. Both fixtures declare an absent member, so `incomplete`
   * names exactly which relations the predicate selected.
   */
  it('selects a relation crossing the tile edge and not one wholly outside it', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(41, CROSSING);
    await insertRelation(4, wayMembers(41, 49), CROSSING);
    await insertRelation(5, wayMembers(51, 59), OUTSIDE);

    const report = await tileCompleteness(client, BOX);

    expect(report.relations).toBe(1);
    expect(report.incomplete.map((r) => r.relationId)).toEqual([4]);
    expect(report.declaredWayMembers).toBe(2);
  });

  /*
   * A route relation carries guideposts and sub-routes alongside its ways. Counting those as
   * declared members invents missing ways out of nodes, and a gate that refuses tiles over
   * members that were never ways is a gate an operator turns off.
   */
  it('counts only way members, and never reports a node or relation member missing', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(61, 'LINESTRING(10.1 45.1, 10.2 45.2)');
    await insertWay(62, 'LINESTRING(10.2 45.2, 10.3 45.3)');
    await insertRelation(
      6,
      members(
        { type: 'way', ref: 61 },
        { type: 'node', ref: 6901, role: 'guidepost' },
        { type: 'way', ref: 62 },
        { type: 'relation', ref: 8801 },
      ),
      INSIDE,
    );

    const report = await tileCompleteness(client, BOX);

    expect(report.declaredWayMembers).toBe(2);
    expect(report.resolvedWayMembers).toBe(2);
    expect(report.incomplete).toEqual([]);
  });

  // OSM ids are unique per element type, so a node and a way can share a number. The join has to
  // discriminate on type or that collision resolves a member the slice does not actually hold.
  it('does not resolve a node member whose ref collides with a way in the slice', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(71, 'LINESTRING(10.1 45.1, 10.2 45.2)');
    await insertWay(72, 'LINESTRING(10.2 45.2, 10.3 45.3)');
    await insertRelation(7, members({ type: 'way', ref: 71 }, { type: 'node', ref: 72 }), INSIDE);

    const report = await tileCompleteness(client, BOX);

    expect(report.declaredWayMembers).toBe(1);
    expect(report.resolvedWayMembers).toBe(1);
    expect(report.incomplete).toEqual([]);
  });

  /*
   * The predicate must select the same relations the adapter reads. A relation it does not
   * select is one whose missing members it can never report, so the tile scores complete on a
   * thinner set than the adapter will fetch — the silent thinness this exists to catch.
   */
  it('scores every route value the adapter selects, and no others', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertRelation(81, wayMembers(8101), INSIDE, 'hiking');
    await insertRelation(82, wayMembers(8201), INSIDE, 'foot');
    await insertRelation(83, wayMembers(8301), INSIDE, 'walking');
    await insertRelation(84, wayMembers(8401), INSIDE, 'running');
    await insertRelation(85, wayMembers(8501), INSIDE, 'bicycle');
    await insertRelation(86, wayMembers(8601), INSIDE, 'mtb');

    const report = await tileCompleteness(client, BOX);

    expect(report.relations).toBe(4);
    expect(report.incomplete.map((r) => r.relationId)).toEqual([81, 82, 83, 84]);
  });

  it('selects a relation held in the box only by a member node when that table exists', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertWay(91, OUTSIDE);
    await insertRelation(9, wayMembers(91, 92), OUTSIDE);

    // Geometry outside the box: without the node-member term this relation is not selected at all,
    // and its missing member 92 is invisible rather than reported.
    expect((await tileCompleteness(client, BOX)).relations).toBe(0);

    await withNodeMemberTable([{ relationId: 9, wkt: 'POINT(10.5 45.5)' }], async () => {
      expect(await hasNodeMemberTable(client)).toBe(true);
      const report = await tileCompleteness(client, BOX);
      expect(report.relations).toBe(1);
      expect(report.incomplete.map((r) => r.missingRefs)).toEqual([[92]]);
    });
  });

  /*
   * One relation and one node row cannot tell a firing guard from a correct one: the EXISTS is
   * true either way. Three relations separate the two terms — 101 is held by a node in the box,
   * 102 by a node outside it, 103 by no node at all — so dropping either term changes the answer.
   */
  it('selects by member node only for that relation and only inside the tile', async (ctx) => {
    if (!reachable) ctx.skip();
    await insertRelation(101, wayMembers(10101), OUTSIDE);
    await insertRelation(102, wayMembers(10201), OUTSIDE);
    await insertRelation(103, wayMembers(10301), OUTSIDE);

    await withNodeMemberTable(
      [
        { relationId: 101, wkt: 'POINT(10.5 45.5)' },
        { relationId: 102, wkt: 'POINT(20.5 55.5)' },
      ],
      async () => {
        const report = await tileCompleteness(client, BOX);

        expect(report.relations).toBe(1);
        expect(report.incomplete.map((r) => r.relationId)).toEqual([101]);
      },
    );
  });
});
