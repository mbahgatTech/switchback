/**
 * The relation-node-member gap, closed rather than assumed away. Overpass returns a route
 * relation when a NODE member falls in the tile bbox; a slice that selects relations by the
 * geometry of their member WAYS cannot see that. This loads the node-member positions and
 * reports how much selection area they add — which is the size of the gap.
 */

import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

interface Member {
  relationId: string;
  nodeId: string;
  role: string;
}

/** Every node member of a route relation, with the relation it belongs to. */
const MEMBERS_SQL = `
SELECT relation_id::text AS "relationId", m->>'ref' AS "nodeId", coalesce(m->>'role','') AS role
FROM osm.trail_relation, jsonb_array_elements(members) m
WHERE m->>'type' = 'node'`;

/** Positions read straight from the extract: the slice never stored them, which is the gap. */
function resolvePositions(pbf: string, ids: readonly string[]): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  if (ids.length === 0) return out;
  const args = [
    'run',
    '--rm',
    '-v',
    '/c/osm-p4:/data',
    process.env.OSMIUM_IMAGE ?? 'sb-osmium:1',
    'osmium',
    'getid',
    `/data/${pbf}`,
    '-f',
    'opl',
    ...ids.map((id) => `n${id}`),
  ];
  // `osmium getid` exits non-zero when an id is absent, which is the interesting case here:
  // a member outside the extract is a member no tile of this slice can reach. Read its output
  // either way, and let the count of what came back say how many resolved.
  let opl = '';
  try {
    opl = execFileSync('docker', args, {
      encoding: 'utf8',
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    opl = String((error as { stdout?: string }).stdout ?? '');
  }
  for (const line of opl.split('\n')) {
    const m = /^n(\d+) .*x(-?[\d.]+) y(-?[\d.]+)/.exec(line.trim());
    if (m) out.set(m[1]!, [Number(m[2]), Number(m[3])]);
  }
  return out;
}

async function main(): Promise<void> {
  const [database, pbf] = process.argv.slice(2);
  const client = new Client({
    host: 'localhost',
    port: 5433,
    user: 'switchback',
    password: 'switchback',
    database,
  });
  await client.connect();

  const { rows: members } = await client.query<Member>(MEMBERS_SQL);
  const ids = [...new Set(members.map((m) => m.nodeId))];
  const positions = resolvePositions(pbf!, ids);

  await client.query('DROP TABLE IF EXISTS osm.relation_node_member');
  await client.query(
    `CREATE TABLE osm.relation_node_member (
       relation_id bigint NOT NULL,
       node_id bigint NOT NULL,
       role text,
       geom geometry(Point,4326) NOT NULL)`,
  );
  for (const m of members) {
    const at = positions.get(m.nodeId);
    if (!at) continue;
    await client.query(
      `INSERT INTO osm.relation_node_member VALUES ($1,$2,$3,ST_SetSRID(ST_MakePoint($4,$5),4326))`,
      [m.relationId, m.nodeId, m.role, at[0], at[1]],
    );
  }
  await client.query('CREATE INDEX ON osm.relation_node_member USING gist (geom)');
  await client.query('ANALYZE osm.relation_node_member');

  /*
   * A stored member only widens the answer when it sits outside its own relation's way
   * envelope: inside it, any bbox reaching the node already reaches the geometry, so the
   * way-geometry select returns the relation anyway.
   */
  const { rows: outside } = await client.query(
    `SELECT n.relation_id::text AS rid, n.node_id::text AS nid, n.role,
            (r.geom IS NULL) AS "relationGeomNull"
     FROM osm.relation_node_member n
     JOIN osm.trail_relation r USING (relation_id)
     WHERE r.geom IS NULL OR NOT ST_Intersects(ST_Envelope(r.geom), n.geom)`,
  );

  const { rows: size } = await client.query<{ bytes: string }>(
    `SELECT pg_total_relation_size('osm.relation_node_member')::text AS bytes`,
  );
  const { rows: totals } = await client.query<{
    relations: string;
    withNode: string;
    nullGeom: string;
  }>(
    `SELECT count(*)::text AS relations,
            count(*) FILTER (WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(members) m WHERE m->>'type'='node'))::text AS "withNode",
            count(*) FILTER (WHERE geom IS NULL)::text AS "nullGeom"
     FROM osm.trail_relation`,
  );

  console.log(
    JSON.stringify(
      {
        database,
        routeRelations: Number(totals[0]!.relations),
        relationsWithNodeMember: Number(totals[0]!.withNode),
        relationsWithNullGeometry: Number(totals[0]!.nullGeom),
        nodeMembersDeclared: members.length,
        nodeMembersResolvedInExtract: [...positions.keys()].length,
        nodeMembersOutsideExtract: ids.length - positions.size,
        storedBytes: Number(size[0]!.bytes),
        membersAddingSelectionArea: outside.length,
        detail: outside,
      },
      null,
      2,
    ),
  );

  await client.end();
}

void main();
