/**
 * Whether a tile's route relations resolve every way member they declare. A pre-warmed tile is
 * marked ready and never re-fetched, so a member the slice lacks is silent permanent loss.
 */

import { Client } from 'pg';
import { quadkeyToBBox } from '../../packages/geo/src/tiles';

type BBox = [number, number, number, number];

/** A declared way member the slice does not hold, and where it sits in the relation's chain. */
export interface MissingMember {
  ref: number;
  ordinal: number;
}

/** A relation declaring more way members than the slice actually holds. */
export interface IncompleteRelation {
  relationId: number;
  name: string | null;
  declared: number;
  resolved: number;
  /** One entry per unresolved occurrence, so its length is always `declared - resolved`. */
  missingMembers: MissingMember[];
}

export interface TileCompletenessReport {
  relations: number;
  declaredWayMembers: number;
  resolvedWayMembers: number;
  incomplete: IncompleteRelation[];
}

/*
 * `osm.relation_node_member` is built after the fact by `measure-node-members.ts`; `switchback.lua`
 * never creates it. Naming it unconditionally makes this query fail outright on any database the
 * loader built alone, and dropping it unconditionally unselects the relations only a member node
 * puts inside the box — the same silent thinness this predicate exists to catch. So the table is
 * probed and the clause is included only when it is really there.
 */
export async function hasNodeMemberTable(client: Client): Promise<boolean> {
  const { rows } = await client.query<{ present: boolean }>(
    "SELECT to_regclass('osm.relation_node_member') IS NOT NULL AS present",
  );
  return rows[0]?.present ?? false;
}

/*
 * The `rel` term is the selection `RELATION_SQL` uses, because a predicate that selected a
 * different set of relations than the adapter reads would score a tile the adapter never fetches.
 * `WITH ORDINALITY` carries member position through so a gap can be named by where it sits in the
 * chain, and the LEFT JOIN is what turns an unresolved member into a NULL that `count` skips.
 * Ref and ordinal are aggregated as one object, never as two arrays paired by index: reordering
 * one of two arrays annotates every gap with another member's position while every count stays
 * right. `ORDER BY ord` is a guarantee rather than an observation — aggregate input order is not
 * promised — and the counts are of occurrences, not distinct ids, because a relation may declare
 * the same way twice and must still score complete when the slice holds both.
 */
function completenessSql(withNodeMembers: boolean): string {
  const nodeMemberClause = withNodeMembers
    ? `
      OR EXISTS (
        SELECT 1 FROM osm.relation_node_member n
        WHERE n.relation_id = r.relation_id AND n.geom && box.g
      )`
    : '';

  return `
WITH box AS (SELECT ST_MakeEnvelope($1, $2, $3, $4, 4326) AS g),
rel AS (
  SELECT r.relation_id, r.tags, r.members
  FROM osm.trail_relation r, box
  WHERE r.tags ->> 'route' IN ('hiking', 'foot', 'walking', 'running')
    AND (
      (r.geom && box.g AND ST_Intersects(r.geom, box.g))${nodeMemberClause}
    )
),
member AS (
  SELECT rel.relation_id,
         rel.tags ->> 'name' AS name,
         m.value ->> 'type' AS mtype,
         (m.value ->> 'ref')::bigint AS ref,
         m.ord,
         w.way_id
  FROM rel
  CROSS JOIN LATERAL jsonb_array_elements(rel.members) WITH ORDINALITY AS m(value, ord)
  LEFT JOIN osm.trail_way w ON m.value ->> 'type' = 'way' AND w.way_id = (m.value ->> 'ref')::bigint
)
SELECT relation_id,
       name,
       count(*) FILTER (WHERE mtype = 'way') AS declared,
       count(way_id) AS resolved,
       coalesce(
         jsonb_agg(jsonb_build_object('ref', ref, 'ordinal', ord) ORDER BY ord)
           FILTER (WHERE mtype = 'way' AND way_id IS NULL),
         '[]'::jsonb
       ) AS missing_members
FROM member
GROUP BY relation_id, name
ORDER BY relation_id`;
}

interface CompletenessRow {
  relation_id: string;
  name: string | null;
  declared: string;
  resolved: string;
  missing_members: MissingMember[];
}

async function queryRows(
  client: Client,
  bbox: BBox,
  withNodeMembers: boolean,
): Promise<CompletenessRow[]> {
  const { rows } = await client.query<CompletenessRow>(completenessSql(withNodeMembers), bbox);
  return rows;
}

function summarise(rows: readonly CompletenessRow[]): TileCompletenessReport {
  let declaredWayMembers = 0;
  let resolvedWayMembers = 0;
  const incomplete: IncompleteRelation[] = [];

  for (const row of rows) {
    const declared = Number(row.declared);
    const resolved = Number(row.resolved);
    declaredWayMembers += declared;
    resolvedWayMembers += resolved;
    if (declared === resolved) continue;
    incomplete.push({
      relationId: Number(row.relation_id),
      name: row.name,
      declared,
      resolved,
      missingMembers: row.missing_members,
    });
  }

  return { relations: rows.length, declaredWayMembers, resolvedWayMembers, incomplete };
}

/** Counts every way member the tile's route relations declare against the ways the slice holds. */
export async function tileCompleteness(
  client: Client,
  bbox: BBox,
): Promise<TileCompletenessReport> {
  return summarise(await queryRows(client, bbox, await hasNodeMemberTable(client)));
}

interface Args {
  database: string;
  bbox: BBox;
  label: string;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };

  const database = flag('database');
  if (!database) {
    throw new Error(
      'usage: tile-completeness.ts --database <db> (--quadkey <qk> | --bbox w,s,e,n)',
    );
  }
  const json = argv.includes('--json');

  const quadkey = flag('quadkey');
  if (quadkey) return { database, bbox: quadkeyToBBox(quadkey), label: quadkey, json };

  const bboxArg = flag('bbox');
  if (bboxArg) {
    const parts = bboxArg.split(',').map(Number);
    if (parts.length !== 4 || parts.some(Number.isNaN)) throw new Error(`bad --bbox "${bboxArg}"`);
    return { database, bbox: parts as BBox, label: bboxArg, json };
  }

  throw new Error('one of --quadkey or --bbox is required');
}

async function main(): Promise<void> {
  const { database, bbox, label, json } = parseArgs(process.argv.slice(2));

  const client = new Client({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5433),
    user: process.env.PGUSER ?? 'switchback',
    password: process.env.PGPASSWORD ?? 'switchback',
    database,
  });
  await client.connect();

  try {
    const nodeMembers = await hasNodeMemberTable(client);
    const report = summarise(await queryRows(client, bbox, nodeMembers));

    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(
      `tile ${label}  db ${database}  osm.relation_node_member ${nodeMembers ? 'present' : 'absent'}`,
    );
    console.log(
      `relations=${report.relations} declared=${report.declaredWayMembers} ` +
        `resolved=${report.resolvedWayMembers}`,
    );
    console.log(`incomplete=${report.incomplete.length}`);
    for (const rel of report.incomplete) {
      const missing = rel.missingMembers.map((m) => `${m.ref}@${m.ordinal}`).join(' ');
      console.log(
        `  ${rel.relationId}  ${rel.declared} declared / ${rel.resolved} resolved  ` +
          `missing ${missing}  ${rel.name ?? '(unnamed)'}`,
      );
    }
  } finally {
    await client.end();
  }
}

// Guarded so the predicate can be imported by tests and by the probe without opening a connection.
if (/tile-completeness/.test(process.argv[1] ?? '')) void main();
