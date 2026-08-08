/**
 * Converge what the application role may do, over the tables `prisma db push` has just created.
 *
 * `ALTER DEFAULT PRIVILEGES` is registered per creating role, and the only registration in this
 * database is `FOR ROLE sbadmin`. The migrate job pushes as `id-switchback-postgres-ci`, so every
 * table it creates is owned by that role and inherits nothing — `sbapp` holds no privilege on it
 * at all. `trail_ways` and `trail_slug_aliases` were the first two tables to arrive that way, and
 * `INGEST_TRAIL_IDENTITY=claim` was unreachable in production for as long as that was true:
 * `resolveTrail`'s first read raised `42501 permission denied for table trail_ways` and took every
 * trail in the tile with it.
 *
 * Runs after the push rather than beside it, and unconditionally rather than only on a schema
 * change, so a database that has drifted converges on the next push instead of on the next table.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** The role the web app and the ingest worker connect as. */
const RUNTIME_ROLE = 'sbapp';

/**
 * Roles that create application tables. `spatial_ref_sys` belongs to PostGIS and is owned by
 * `azuresu`; granting the runtime role DELETE on it would be a privilege nothing asks for, so
 * ownership is the scope rather than "everything in `public`".
 */
const SCHEMA_OWNERS = ['sbadmin', 'id-switchback-postgres-ci'];

/** What the application does to its own tables. `sbapp`'s existing grants are exactly these. */
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** Application tables in `public`, whoever created them. Shared by the grant and the assertion. */
const OWNED_TABLES = `
  select c.oid, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_roles o on o.oid = c.relowner
   where n.nspname = 'public'
     and c.relkind in ('r', 'p')
     and o.rolname = any($1::text[])`;

/**
 * Idempotent, and in this order deliberately: the default privileges cover every table the *next*
 * push creates, the loop covers the ones already on the ground. Either alone leaves a gap — the
 * first does nothing for `trail_ways`, the second has to be re-run for every new table forever.
 */
export const CONVERGE_GRANTS_SQL = `
  alter default privileges for role "id-switchback-postgres-ci" in schema public
    grant ${TABLE_PRIVILEGES.join(', ')} on tables to ${RUNTIME_ROLE};
  alter default privileges for role "id-switchback-postgres-ci" in schema public
    grant usage, select on sequences to ${RUNTIME_ROLE};

  do $$
  declare target text;
  begin
    for target in
      select quote_ident(c.relname)
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_roles o on o.oid = c.relowner
       where n.nspname = 'public'
         and c.relkind in ('r', 'p')
         and o.rolname in (${SCHEMA_OWNERS.map((role) => `'${role}'`).join(', ')})
    loop
      execute format(
        'grant ${TABLE_PRIVILEGES.join(', ')} on public.%s to ${RUNTIME_ROLE}', target
      );
    end loop;
  end $$;`;

/** One row per application table, carrying whether the runtime role can do each thing to it. */
export const GRANT_AUDIT_SQL = `
  select table_name,
         ${TABLE_PRIVILEGES.map(
           (privilege) =>
             `has_table_privilege('${RUNTIME_ROLE}', oid, '${privilege}') as "${privilege.toLowerCase()}"`,
         ).join(',\n         ')}
    from (${OWNED_TABLES}) owned
   order by table_name`;

/**
 * Tables the runtime role cannot fully use. A missing privilege reads as denied: the failure this
 * exists to catch produced `false` on all four, and a driver answering `null` for an unknown
 * column must not be waved through as permitted.
 */
export function ungrantedTables(rows: readonly Record<string, unknown>[]): string[] {
  return rows
    .filter((row) => TABLE_PRIVILEGES.some((privilege) => row[privilege.toLowerCase()] !== true))
    .map((row) => String(row.table_name));
}

async function main(): Promise<void> {
  const connectionString = process.env.DIRECT_DATABASE_URL;
  if (!connectionString) {
    console.error('::error::DIRECT_DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    await client.query(CONVERGE_GRANTS_SQL);
    const { rows } = await client.query(GRANT_AUDIT_SQL, [SCHEMA_OWNERS]);
    const ungranted = ungrantedTables(rows);
    console.log(`switchback-runtime-grants tables=${rows.length} ungranted=${ungranted.length}`);
    if (ungranted.length > 0) {
      console.error(`::error::${RUNTIME_ROLE} cannot use: ${ungranted.join(', ')}`);
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
