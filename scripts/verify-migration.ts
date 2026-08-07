/**
 * Compares a source PostgreSQL database against a target and says exactly which claim failed.
 * Written for the 2026-07-30 Neon-to-Azure move, whose vocabulary it keeps; the source it names
 * was deleted on 2026-08-07, so today its use is any restore, rebuild or future move.
 *
 *   npm run verify:migration
 *
 * `pg_restore` exiting 0 only proves a program finished. Each check below covers one way a
 * migration can look complete and not be: missing table, empty table, corrupted rows, lost
 * SRID, an index that did not rebuild, rebuilt invalid, or rebuilt but unused by the planner,
 * and a DDL-capable web credential.
 *
 * The host tripwire runs FIRST: a script comparing a database to itself passes every other
 * check in this file perfectly, and that is one copy-paste away.
 *
 * Checksums are computed in SQL and handed in as files (`NEON_CHECKSUMS`, `AZURE_CHECKSUMS`)
 * because schema.prisma declares the geometry and tsvector columns `Unsupported`, so Prisma
 * Client cannot select them. `md5(row::text)` covers them as part of the same row hash.
 *
 * Nothing here prints a connection string, a password, or a row of user data.
 */
import { existsSync, readFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';

/** Every `@@map` in schema.prisma. A table missing from the target fails against this list. */
const EXPECTED_TABLES = [
  'accounts',
  'activities',
  'activity_samples',
  'busyness_buckets',
  'completions',
  'elevation_profiles',
  'ingest_jobs',
  'ingest_tiles',
  'lifeline_sessions',
  'mobile_auth_requests',
  'mobile_refresh_tokens',
  'path_segments',
  'photos',
  'planned_routes',
  'reviews',
  'routing_tiles',
  'sessions',
  'trail_list_items',
  'trail_lists',
  'trails',
  'users',
  'verification_tokens',
  'waypoints',
] as const;

/** The eight objects `packages/db/prisma/spatial.sql` creates. Asserted by name. */
const SPATIAL_INDEXES = [
  'trails_geom_gist',
  'trails_bbox_gist',
  'trails_geom_geography_gist',
  'waypoints_point_gist',
  'activities_geom_gist',
  'trails_search_vector_gin',
  'trails_name_trgm',
  'trail_lists_one_system_list_per_user',
] as const;

/**
 * `spatial.sql` drops this deliberately — superseded by `trails_geom_geography_gist` and left
 * behind as write amplification. Its absence is asserted because `pg_dump` would happily
 * bring the old index across, which is the one way a migrated database could disagree with a
 * freshly built one.
 */
const DROPPED_INDEX = 'trails_centroid_gist';

const CHECK_CONSTRAINTS = ['reviews_rating_range', 'busyness_buckets_slot_range'] as const;

/**
 * `btree_gist` is created only by spatial.sql, not named in schema.prisma, and is the one that
 * gets forgotten off the `azure.extensions` allowlist — `trails_bbox_gist` cannot exist
 * without it.
 */
const EXTENSIONS = ['postgis', 'pg_trgm', 'btree_gist'] as const;

/**
 * Floors, not expectations: a diff of two empty databases matches perfectly. Roughly 90% of
 * the corpus as last measured. A tripwire, not a specification — if the corpus is ever
 * deliberately reduced, lower these in the same commit.
 */
const CORPUS_FLOOR: Record<string, number> = {
  trails: 13_000,
  photos: 90_000,
  waypoints: 150_000,
  path_segments: 1_900,
  routing_tiles: 18,
};

/**
 * Tables whose contents legitimately move on their own. Only consulted when
 * `CHECKSUM_SNAPSHOT_CONSISTENT` is not `1` — a standalone `verify` run, where Neon's
 * checksums were taken now rather than from inside pg_dump's snapshot. A difference in any
 * other table is still a failure, as is a difference in these during a real `migrate` run.
 * `photos` is deliberately excluded: it also holds user uploads.
 */
const VOLATILE_TABLES = new Set([
  'trails',
  'waypoints',
  'elevation_profiles',
  'ingest_tiles',
  'ingest_jobs',
  'routing_tiles',
  'path_segments',
  'busyness_buckets',
  'sessions',
  'mobile_auth_requests',
  'verification_tokens',
]);

/**
 * Vesper Peak — the same point `e2e/` opens on and the tile the browser suite ingests, so
 * there is real geometry around it on any database worth migrating.
 */
const NEAR = { lng: -121.51188, lat: 48.01213, radiusM: 25_000 };

/** The trail the CI smoke test fetches, so a failure here has a visible counterpart. */
const SPOT_SLUG = 'llanberis-path';

/** Relative tolerance on the geodesic length sum. Floating point, two PostGIS builds. */
const LENGTH_TOLERANCE = 1e-9;

type Status = 'pass' | 'fail' | 'warn';

interface Check {
  name: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];

function record(name: string, status: Status, detail: string): void {
  checks.push({ name, status, detail });
}

/** `expected === actual` as a check, with both values in the detail either way. */
function expectEqual(name: string, expected: string, actual: string, note = ''): void {
  const suffix = note ? ` — ${note}` : '';
  if (expected === actual) {
    record(name, 'pass', `${actual}${suffix}`);
  } else {
    record(name, 'fail', `expected ${expected}, found ${actual}${suffix}`);
  }
}

// Counts come back as bigint, which Prisma maps to BigInt and `JSON.stringify` refuses to
// serialise. Every count below is cast to text in SQL and compared as a string.

type Row = Record<string, unknown>;

/**
 * A `$queryRaw` value rendered as text. `String()` is a trap: a json/jsonb column or a
 * Postgres array comes back as an object and would compare the literal `[object Object]` on
 * both sides — matching every time, for every row.
 */
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value) ?? '';
}

function scalar(rows: Row[], column: string): string {
  return text(rows[0]?.[column]);
}

function num(rows: Row[], column: string): number {
  const raw = scalar(rows, column);
  return raw === '' ? Number.NaN : Number(raw);
}

interface TableChecksum {
  rows: string;
  md5: string;
}

/**
 * Parses `table|count|md5` lines. A malformed line is reported rather than skipped: a
 * silently dropped line is a table that stops being checked.
 */
function readChecksums(path: string, label: string): Map<string, TableChecksum> | null {
  if (!existsSync(path)) {
    record(`checksums · ${label} file`, 'fail', `not found at ${path}`);
    return null;
  }
  const parsed = new Map<string, TableChecksum>();
  let malformed = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const parts = trimmed.split('|');
    if (parts.length !== 3 || parts[0] === undefined) {
      malformed += 1;
      continue;
    }
    parsed.set(parts[0], { rows: parts[1] ?? '', md5: parts[2] ?? '' });
  }
  if (malformed > 0) {
    record(`checksums · ${label} file`, 'fail', `${malformed} unparseable line(s)`);
    return null;
  }
  record(`checksums · ${label} file`, 'pass', `${parsed.size} tables`);
  return parsed;
}

function compareChecksums(
  neon: Map<string, TableChecksum>,
  azure: Map<string, TableChecksum>,
  snapshotConsistent: boolean,
): void {
  const tables = [...new Set([...neon.keys(), ...azure.keys()])].sort();

  for (const table of tables) {
    const left = neon.get(table);
    const right = azure.get(table);
    const soft = !snapshotConsistent && VOLATILE_TABLES.has(table);
    const downgrade: Status = soft ? 'warn' : 'fail';

    if (!left) {
      record(`rows · ${table}`, 'fail', 'present on Azure, absent from the Neon checksums');
      continue;
    }
    if (!right) {
      record(`rows · ${table}`, 'fail', 'present on Neon, MISSING from Azure');
      continue;
    }
    if (left.rows !== right.rows) {
      record(
        `rows · ${table}`,
        downgrade,
        `count differs — Neon ${left.rows}, Azure ${right.rows}` +
          (soft ? ' (ingest-derived, source was live)' : ''),
      );
      continue;
    }
    if (left.md5 !== right.md5) {
      record(
        `rows · ${table}`,
        downgrade,
        `${left.rows} rows on both sides but the content hash differs` +
          (soft ? ' (ingest-derived, source was live)' : ''),
      );
      continue;
    }
    record(`rows · ${table}`, 'pass', `${left.rows} rows, hashes match`);
  }

  const missing = EXPECTED_TABLES.filter((t) => !azure.has(t));
  if (missing.length > 0) {
    record('rows · every expected table checked', 'fail', `not checksummed: ${missing.join(', ')}`);
  } else {
    record(
      'rows · every expected table checked',
      'pass',
      `all ${EXPECTED_TABLES.length} tables from schema.prisma`,
    );
  }

  for (const [table, floor] of Object.entries(CORPUS_FLOOR)) {
    const entry = azure.get(table);
    if (!entry) {
      record(`corpus · ${table}`, 'fail', 'table not present on Azure');
      continue;
    }
    const count = Number(entry.rows);
    if (!Number.isFinite(count) || count < floor) {
      record(
        `corpus · ${table}`,
        'fail',
        `${entry.rows} rows is below the floor of ${floor} — a restore that loaded nothing ` +
          'would otherwise pass every equality check in this file',
      );
    } else {
      record(`corpus · ${table}`, 'pass', `${entry.rows} rows (floor ${floor})`);
    }
  }
}

// Structure, asserted against the target only: invisible to a row count, load-bearing at runtime.

async function checkStructure(azure: PrismaClient, neon: PrismaClient): Promise<void> {
  const tableRows = await azure.$queryRaw<Row[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `;
  const present = new Set(tableRows.map((r) => text(r.tablename)));
  const absent = EXPECTED_TABLES.filter((t) => !present.has(t));
  if (absent.length > 0) {
    record('tables · present', 'fail', `missing from Azure: ${absent.join(', ')}`);
  } else {
    record(
      'tables · present',
      'pass',
      `all ${EXPECTED_TABLES.length}, plus ${present.size - EXPECTED_TABLES.length} unlisted`,
    );
  }

  const indexRows = await azure.$queryRaw<Row[]>`
    SELECT indexname FROM pg_indexes WHERE schemaname = 'public'
  `;
  const indexes = new Set(indexRows.map((r) => text(r.indexname)));
  for (const name of SPATIAL_INDEXES) {
    record(
      `index · ${name}`,
      indexes.has(name) ? 'pass' : 'fail',
      indexes.has(name) ? '' : 'absent',
    );
  }
  record(
    `index · ${DROPPED_INDEX} absent`,
    indexes.has(DROPPED_INDEX) ? 'fail' : 'pass',
    indexes.has(DROPPED_INDEX)
      ? 'restored from Neon but spatial.sql drops it — the two databases disagree'
      : 'correctly absent',
  );

  const invalid = await azure.$queryRaw<Row[]>`
    SELECT count(*)::text AS n
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE NOT i.indisvalid AND n.nspname = 'public'
  `;
  expectEqual('index · none invalid', '0', scalar(invalid, 'n'), 'pg_index.indisvalid, public');

  const constraintRows = await azure.$queryRaw<Row[]>`
    SELECT c.conname
      FROM pg_constraint c
      JOIN pg_namespace n ON n.oid = c.connamespace
     WHERE c.contype = 'c' AND n.nspname = 'public'
  `;
  const constraints = new Set(constraintRows.map((r) => text(r.conname)));
  for (const name of CHECK_CONSTRAINTS) {
    record(`constraint · ${name}`, constraints.has(name) ? 'pass' : 'fail', '');
  }

  /**
   * Foreign keys, counted **in `public` only** — which is not fussiness, it is the difference
   * between this check passing and failing on a flawless migration.
   *
   * The dump is taken with `pg_dump --schema=public`, so `public` is the entire scope of what
   * this migration is supposed to reproduce. Neon carries a second schema, `neon_auth`, created
   * by the Neon Auth integration (see `NEON_AUTH_BASE_URL` in the Vercel production
   * environment); it holds 6 foreign keys of its own and is deliberately not migrated. An
   * unscoped `SELECT count(*) FROM pg_constraint WHERE contype = 'f'` therefore reads 33 on
   * Neon against 27 on Azure and reports a byte-perfect migration as a missing-constraint
   * failure — measured, not hypothesised.
   *
   * Scoping both sides to `public` compares like with like: 27 against 27.
   */
  const fkCount = (db: PrismaClient) =>
    db.$queryRaw<Row[]>`
      SELECT count(*)::text AS n
        FROM pg_constraint c
        JOIN pg_namespace n ON n.oid = c.connamespace
       WHERE c.contype = 'f' AND n.nspname = 'public'
    `;
  const [neonFks, azureFks] = await Promise.all([fkCount(neon), fkCount(azure)]);
  expectEqual(
    'constraint · foreign key count',
    scalar(neonFks, 'n'),
    scalar(azureFks, 'n'),
    'public schema only — proves the post-data section actually ran',
  );

  const extRows = await azure.$queryRaw<Row[]>`
    SELECT extname, extversion FROM pg_extension ORDER BY extname
  `;
  const versions = new Map(extRows.map((r) => [text(r.extname), text(r.extversion)]));
  for (const name of EXTENSIONS) {
    const version = versions.get(name);
    record(
      `extension · ${name}`,
      version ? 'pass' : 'fail',
      version ?? 'not installed — check the azure.extensions server parameter allowlist',
    );
  }

  // Tokenisation has to agree or future ingest indexes words differently from the rows that
  // arrived, and search quietly returns nothing for trails that used to be findable.
  const [neonTs, azureTs] = await Promise.all([
    neon.$queryRaw<Row[]>`SHOW default_text_search_config`,
    azure.$queryRaw<Row[]>`SHOW default_text_search_config`,
  ]);
  expectEqual(
    'search · default_text_search_config',
    scalar(neonTs, 'default_text_search_config'),
    scalar(azureTs, 'default_text_search_config'),
  );

  // Restore succeeds under either collation, which is exactly what makes a mismatch
  // dangerous: `ORDER BY name` silently reorders and the partial unique index on
  // trail_lists is built under different rules.
  const [neonColl, azureColl] = await Promise.all([
    neon.$queryRaw<Row[]>`
      SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()
    `,
    azure.$queryRaw<Row[]>`
      SELECT datcollate, datctype FROM pg_database WHERE datname = current_database()
    `,
  ]);
  expectEqual(
    'collation · datcollate',
    scalar(neonColl, 'datcollate'),
    scalar(azureColl, 'datcollate'),
  );
  expectEqual('collation · datctype', scalar(neonColl, 'datctype'), scalar(azureColl, 'datctype'));
}

/**
 * The privilege boundary the Bicep firewall rule lists as a compensating control: the Vercel
 * credential may read and write rows and nothing else. ARM cannot create the role, so this is
 * checked rather than assumed.
 *
 * The third check is the one that matters — `pg_roles` saying the role is not in
 * `azure_pg_admin` is a statement about the catalog; a connection *as that role* being refused
 * a CREATE is a statement about what an attacker holding the credential could do. The CREATE
 * runs in a transaction that is always rolled back, and its success is the failure.
 */
async function checkPrivileges(azure: PrismaClient, appUrl: string): Promise<void> {
  if (!appUrl) {
    record(
      'privilege · application role',
      'fail',
      'AZURE_APP_VERIFY_URL is not set, so the least-privilege role that infra/azure/' +
        'postgres.bicep lists as a compensating control for the internet-wide firewall ' +
        'cannot be checked — and an unchecked control is what that list must not contain',
    );
    return;
  }

  let appRole = '';
  try {
    appRole = decodeURIComponent(new URL(appUrl).username);
  } catch {
    record('privilege · application role', 'fail', 'AZURE_APP_VERIFY_URL is not a valid URL');
    return;
  }

  const roleRows = await azure.$queryRaw<Row[]>`
    SELECT rolname,
           rolsuper::text                                              AS is_super,
           rolcreatedb::text                                           AS can_createdb,
           rolcreaterole::text                                         AS can_createrole,
           pg_has_role(rolname, 'azure_pg_admin', 'member')::text      AS is_pg_admin
      FROM pg_roles
     WHERE rolname = ${appRole}
  `;

  if (roleRows.length === 0) {
    record(
      `privilege · ${appRole} exists`,
      'fail',
      'the application role named by AZURE_APP_VERIFY_URL does not exist on the target — ' +
        'production would be connecting as the server administrator',
    );
    return;
  }
  record(`privilege · ${appRole} exists`, 'pass', 'created by the runbook role step');

  for (const [label, column] of [
    ['not a superuser', 'is_super'],
    ['cannot create databases', 'can_createdb'],
    ['cannot create roles', 'can_createrole'],
    ['not in azure_pg_admin', 'is_pg_admin'],
  ] as const) {
    const value = scalar(roleRows, column);
    record(
      `privilege · ${appRole} ${label}`,
      value === 'false' ? 'pass' : 'fail',
      value === 'false' ? '' : `pg_roles reports ${column} = ${value}`,
    );
  }

  // And the assertion the catalog cannot make: connect as the role and try.
  const app = new PrismaClient({ datasourceUrl: appUrl, log: ['error'] });
  try {
    const probe = `verify_ddl_probe_${Date.now().toString(36)}`;
    let refused = false;
    // The refusal reason, kept and reported. `permission denied for schema public` is the
    // expected one; anything else — a connection failure, a missing table — would also be
    // caught by the `catch` and would otherwise be indistinguishable from a real refusal,
    // which would turn this check into one that passes for the wrong reason.
    let refusal = '';
    try {
      await app.$executeRawUnsafe(`CREATE TABLE public."${probe}" (id int)`);
      // It worked, which is the failure. Undo it with the admin credential, since the
      // application role may not be able to drop what it just created.
      await azure.$executeRawUnsafe(`DROP TABLE IF EXISTS public."${probe}"`);
    } catch (error) {
      refused = true;
      // The first *non-empty* line. A Prisma error message opens with a blank line and an
      // `Invalid \`prisma.$executeRawUnsafe()\` invocation:` banner, so `split('\n')[0]` is
      // the empty string and the reason this check exists to show would be dropped.
      refusal =
        error instanceof Error
          ? (error.message
              .split('\n')
              .map((line) => line.trim())
              .find((line) => line.length > 0 && !line.startsWith('Invalid `prisma')) ?? '')
          : '';
    }

    record(
      `privilege · ${appRole} cannot execute DDL`,
      refused ? 'pass' : 'fail',
      refused
        ? `CREATE TABLE refused${refusal ? ` — ${refusal}` : ''}`
        : 'CREATE TABLE succeeded — the credential Vercel carries can reshape the database, ' +
            'which is the boundary postgres.bicep claims exists',
    );

    // The other half: the role has to actually work, or the migration has produced a
    // production credential that cannot serve a page.
    const readable = await app.$queryRaw<Row[]>`SELECT count(*)::text AS n FROM trails`;
    const n = scalar(readable, 'n');
    record(
      `privilege · ${appRole} can read`,
      n !== '' ? 'pass' : 'fail',
      n !== '' ? `${n} trails visible` : 'SELECT on trails returned nothing at all',
    );
  } finally {
    await app.$disconnect();
  }
}

// The checksums prove the bytes moved; this proves Azure's PostGIS reads them as Neon's did.

async function geometryFacts(db: PrismaClient): Promise<{
  withGeom: string;
  npoints: string;
  lengthM: number;
  srids: string;
  nullTrails: string;
  nullActivities: string;
  nullWaypoints: string;
}> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT count("geom")::text                          AS with_geom,
           coalesce(sum(ST_NPoints("geom")), 0)::text    AS npoints,
           coalesce(sum(ST_Length("geom"::geography)), 0) AS length_m,
           coalesce(
             (SELECT array_to_string(
                       array_agg(DISTINCT ST_SRID("geom") ORDER BY ST_SRID("geom")), ',')
                FROM trails WHERE "geom" IS NOT NULL),
             ''
           )                                            AS srids,
           (count(*) FILTER (WHERE "geom" IS NULL))::text AS null_trails,
           (SELECT (count(*) FILTER (WHERE "geom" IS NULL))::text FROM activities)
                                                        AS null_activities,
           (SELECT (count(*) FILTER (WHERE "point" IS NULL))::text FROM waypoints)
                                                        AS null_waypoints
      FROM trails
  `;
  return {
    withGeom: scalar(rows, 'with_geom'),
    npoints: scalar(rows, 'npoints'),
    lengthM: num(rows, 'length_m'),
    srids: scalar(rows, 'srids'),
    nullTrails: scalar(rows, 'null_trails'),
    nullActivities: scalar(rows, 'null_activities'),
    nullWaypoints: scalar(rows, 'null_waypoints'),
  };
}

async function checkGeometry(azure: PrismaClient, neon: PrismaClient): Promise<void> {
  const [left, right] = await Promise.all([geometryFacts(neon), geometryFacts(azure)]);

  expectEqual('geometry · trails with geometry', left.withGeom, right.withGeom);
  expectEqual('geometry · total vertices', left.npoints, right.npoints, 'sum(ST_NPoints)');
  expectEqual('geometry · trails with NULL geom', left.nullTrails, right.nullTrails);
  expectEqual('geometry · activities with NULL geom', left.nullActivities, right.nullActivities);
  expectEqual('geometry · waypoints with NULL point', left.nullWaypoints, right.nullWaypoints);

  // A lost or zeroed SRID is a classic dump/restore casualty: every row count stays perfect
  // and every `::geography` cast silently computes the wrong distance.
  expectEqual('geometry · distinct SRID', '4326', right.srids, 'must be exactly {4326}');
  expectEqual('geometry · SRID matches source', left.srids, right.srids);

  // Geodesic length over the whole corpus, computed the way packages/db/src/spatial.ts
  // computes it. Two PostGIS builds summing 15k spheroid lengths will not agree to the last
  // bit, so this is a relative tolerance — but it is a tight one: anything that truncated a
  // line moves this far more than 1e-9.
  const denominator = Math.max(Math.abs(left.lengthM), 1);
  const drift = Math.abs(left.lengthM - right.lengthM) / denominator;
  if (Number.isFinite(drift) && drift <= LENGTH_TOLERANCE) {
    record(
      'geometry · sum(ST_Length(geom::geography))',
      'pass',
      `${right.lengthM.toFixed(3)} m, relative drift ${drift.toExponential(2)}`,
    );
  } else {
    record(
      'geometry · sum(ST_Length(geom::geography))',
      'fail',
      `Neon ${left.lengthM.toFixed(3)} m vs Azure ${right.lengthM.toFixed(3)} m — ` +
        `relative drift ${Number.isFinite(drift) ? drift.toExponential(2) : 'not computable'}`,
    );
  }
}

/**
 * Two named trails, vertex for vertex: `llanberis-path` because the deploy smoke test fetches
 * it, and the longest trail because truncation shows up there first and is invisible to every
 * aggregate.
 */
async function spotCheck(azure: PrismaClient, neon: PrismaClient): Promise<void> {
  const query = (db: PrismaClient, slug: string) =>
    db.$queryRaw<Row[]>`
      SELECT slug,
             ST_NPoints("geom")::text            AS npoints,
             ST_Length("geom"::geography)        AS length_m,
             ST_SRID("geom")::text               AS srid,
             md5(ST_AsBinary("geom"))            AS geom_md5
        FROM trails
       WHERE slug = ${slug}
    `;

  const longest = await neon.$queryRaw<Row[]>`
    SELECT slug FROM trails WHERE "geom" IS NOT NULL ORDER BY "lengthM" DESC, slug ASC LIMIT 1
  `;
  const longestSlug = scalar(longest, 'slug');

  const slugs = [SPOT_SLUG, ...(longestSlug && longestSlug !== SPOT_SLUG ? [longestSlug] : [])];

  for (const slug of slugs) {
    const [left, right] = await Promise.all([query(neon, slug), query(azure, slug)]);
    if (left.length === 0) {
      record(`spot · ${slug}`, 'warn', 'not present on Neon either — nothing to compare');
      continue;
    }
    if (right.length === 0) {
      record(`spot · ${slug}`, 'fail', 'present on Neon, absent from Azure');
      continue;
    }
    const same =
      scalar(left, 'npoints') === scalar(right, 'npoints') &&
      scalar(left, 'srid') === scalar(right, 'srid') &&
      scalar(left, 'geom_md5') === scalar(right, 'geom_md5');
    if (same) {
      record(
        `spot · ${slug}`,
        'pass',
        `${scalar(right, 'npoints')} vertices, ${num(right, 'length_m').toFixed(1)} m, ` +
          'identical WKB',
      );
    } else {
      record(
        `spot · ${slug}`,
        'fail',
        `Neon ${scalar(left, 'npoints')} vertices / SRID ${scalar(left, 'srid')} vs ` +
          `Azure ${scalar(right, 'npoints')} / SRID ${scalar(right, 'srid')}` +
          (scalar(left, 'geom_md5') === scalar(right, 'geom_md5') ? '' : ', WKB differs'),
      );
    }
  }
}

/**
 * The query the product actually runs, from `packages/db/src/spatial.ts`. The id set matching
 * proves the data and spheroid maths agree; the plan naming `trails_geom_geography_gist`
 * proves the index is used at all — a GiST built with a geometry operator class cannot serve
 * a geography operator, so it can be present, valid and completely unused while a row-count
 * check passes happily.
 */
async function checkNearbyPath(azure: PrismaClient, neon: PrismaClient): Promise<void> {
  const ids = (db: PrismaClient) =>
    db.$queryRaw<Row[]>`
      WITH origin AS (
        SELECT ST_SetSRID(ST_MakePoint(${NEAR.lng}, ${NEAR.lat}), 4326)::geography AS g
      )
      SELECT id
        FROM trails, origin
       WHERE "geom" IS NOT NULL
         AND ST_DWithin("geom"::geography, origin.g, ${NEAR.radiusM})
       ORDER BY id
    `;

  const [left, right] = await Promise.all([ids(neon), ids(azure)]);
  const leftIds = left.map((r) => text(r.id));
  const rightIds = right.map((r) => text(r.id));

  if (leftIds.length === 0 && rightIds.length === 0) {
    record(
      'nearby · id set',
      'warn',
      'no trails within 25 km of Vesper Peak on either side — the corpus may not cover it, ' +
        'so this check proved nothing',
    );
  } else if (leftIds.join(',') === rightIds.join(',')) {
    record('nearby · id set', 'pass', `${rightIds.length} trails, identical on both sides`);
  } else {
    const onlyNeon = leftIds.filter((id) => !rightIds.includes(id)).length;
    const onlyAzure = rightIds.filter((id) => !leftIds.includes(id)).length;
    record(
      'nearby · id set',
      'fail',
      `Neon returned ${leftIds.length}, Azure ${rightIds.length} — ` +
        `${onlyNeon} only on Neon, ${onlyAzure} only on Azure`,
    );
  }

  const plan = await azure.$queryRawUnsafe<Row[]>(
    `EXPLAIN WITH origin AS (
       SELECT ST_SetSRID(ST_MakePoint(${NEAR.lng}, ${NEAR.lat}), 4326)::geography AS g
     )
     SELECT id FROM trails, origin
      WHERE "geom" IS NOT NULL
        AND ST_DWithin("geom"::geography, origin.g, ${NEAR.radiusM})`,
  );
  const planText = plan.map((r) => text(Object.values(r)[0])).join('\n');

  if (planText.includes('trails_geom_geography_gist')) {
    record('nearby · planner uses the geography index', 'pass', 'index scan');
  } else {
    record(
      'nearby · planner uses the geography index',
      'fail',
      'the plan does not name trails_geom_geography_gist — /nearby will sequential-scan ' +
        'every trail. Has ANALYZE run since the restore?',
    );
  }
}

/**
 * Prints the report and sets the exit code. Returns the failure count so a caller can stop
 * early — the host tripwire in `main` invalidates every later check, so it must not be
 * followed by a page of reassuring passes.
 */
function report(snapshotConsistent: boolean): number {
  const width = Math.max(...checks.map((c) => c.name.length), 1);
  const symbol: Record<Status, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' };

  console.log('');
  for (const check of checks) {
    console.log(`${symbol[check.status]}  ${check.name.padEnd(width)}  ${check.detail}`.trimEnd());
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  console.log('');
  console.log(
    `${checks.length} checks · ${checks.length - failed - warned} passed · ` +
      `${warned} warnings · ${failed} failed`,
  );
  if (!snapshotConsistent && checks.some((c) => c.name.startsWith('rows · '))) {
    console.log(
      'Checksums were not taken from the dump snapshot, so differences in ingest-derived ' +
        'tables are reported as warnings rather than failures.',
    );
  }

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed — the migration is not verified.`);
    process.exitCode = 1;
  }
  return failed;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const neonUrl = process.env.NEON_VERIFY_URL ?? '';
  const azureUrl = process.env.AZURE_VERIFY_URL ?? '';
  const snapshotConsistent = process.env.CHECKSUM_SNAPSHOT_CONSISTENT === '1';

  if (!neonUrl || !azureUrl) {
    console.error('NEON_VERIFY_URL and AZURE_VERIFY_URL must both be set.');
    process.exitCode = 1;
    return;
  }

  // Before a single query: the two URLs must name different servers. This is the only failure
  // mode here that produces a false *green* rather than a false red.
  const neonHost = hostOf(neonUrl);
  const azureHost = hostOf(azureUrl);
  if (neonHost === '' || azureHost === '') {
    record('endpoints · both URLs parse', 'fail', 'one of the two connection strings is not a URL');
  } else if (neonHost === azureHost) {
    record(
      'endpoints · source and target differ',
      'fail',
      'both connection strings name the same host — this run would compare a database to ' +
        'itself and pass everything',
    );
  } else {
    record('endpoints · source and target differ', 'pass', 'two distinct hosts');
    if (!azureHost.endsWith('.postgres.database.azure.com')) {
      record(
        'endpoints · target looks like Azure',
        'warn',
        'the target host is not *.postgres.database.azure.com',
      );
    }
  }

  // Stop rather than running the suite anyway: thirty green lines under one red read as green.
  if (checks.some((c) => c.status === 'fail')) {
    report(snapshotConsistent);
    return;
  }

  const neon = new PrismaClient({ datasourceUrl: neonUrl, log: ['error'] });
  // Deliberately the *pooled* Azure URL, which is what Vercel uses. On General Purpose that is
  // PgBouncer on 6432, and these reads are the only thing in the migration that would surface
  // `prepared statement "s0" already exists` before a user does.
  const azure = new PrismaClient({ datasourceUrl: azureUrl, log: ['error'] });

  try {
    const [neonVersion, azureVersion] = await Promise.all([
      neon.$queryRaw<Row[]>`SELECT current_setting('server_version') AS v`,
      azure.$queryRaw<Row[]>`SELECT current_setting('server_version') AS v`,
    ]);
    record(
      'endpoints · both reachable through Prisma',
      'pass',
      `source ${scalar(neonVersion, 'v')}, target ${scalar(azureVersion, 'v')}`,
    );

    const neonSums = readChecksums(process.env.NEON_CHECKSUMS ?? '', 'source');
    const azureSums = readChecksums(process.env.AZURE_CHECKSUMS ?? '', 'target');
    if (neonSums && azureSums) {
      compareChecksums(neonSums, azureSums, snapshotConsistent);
    }

    await checkStructure(azure, neon);
    await checkPrivileges(azure, process.env.AZURE_APP_VERIFY_URL ?? '');
    await checkGeometry(azure, neon);
    await spotCheck(azure, neon);
    await checkNearbyPath(azure, neon);
  } finally {
    await Promise.all([neon.$disconnect(), azure.$disconnect()]);
  }

  report(snapshotConsistent);
}

main().catch((error: unknown) => {
  // `.message` only, never the error object: a driver-level failure can carry the datasource
  // it was constructed with, and this output is read by whoever can see the log.
  console.error('verification could not complete:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
