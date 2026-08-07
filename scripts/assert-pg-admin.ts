/**
 * The migrate job's gate: the minted token must authenticate a Postgres administrator, because
 * `prisma db push` reconciles the schema of the one database with real data in it and a
 * half-privileged push fails part-applied.
 *
 * A file rather than a string inside `ci.yml`. `tsx -e` hands its argument to esbuild with a
 * CommonJS output format, where top-level `await` is unrepresentable, so an inline version of
 * this cannot run at all — and nothing in the repository can see that, because `typecheck`,
 * `lint`, `format:check` and `vitest` all read files. `test/ci-steps-runnable.test.ts` executes
 * whatever `ci.yml` actually invokes here.
 *
 * A root `.ts` is CommonJS too (no `"type": "module"` in the root `package.json`), so this uses
 * an async `main` rather than top-level await; `.mts` would be ESM but falls outside the
 * `scripts/**\/*.ts` include in `tsconfig.json` and so would not be typechecked.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/** What the probe asks of the connection it was given. */
export const ADMIN_PROBE_SQL =
  "select current_user, pg_has_role(current_user, 'azure_pg_admin', 'member') as is_admin";

export interface AdminVerdict {
  currentUser: string;
  isAdmin: boolean;
}

/**
 * The verdict in `ADMIN_PROBE_SQL`'s single row. Anything but boolean `true` is read as "not an
 * administrator": the interesting failure is a driver returning `'t'` or `null` where a
 * truthiness test would wave it through and let the push start.
 */
export function readAdminVerdict(rows: readonly Record<string, unknown>[]): AdminVerdict {
  const row = rows[0];
  if (row === undefined) throw new Error(`no rows from: ${ADMIN_PROBE_SQL}`);
  return { currentUser: String(row.current_user), isAdmin: row.is_admin === true };
}

async function main(): Promise<void> {
  const connectionString = process.env.DIRECT_DATABASE_URL;
  if (!connectionString) {
    // Named rather than left to fail at connect: `pg-token-url.sh` exports this, and an empty
    // export reads as "connect to localhost" instead of "the token was never minted".
    console.error('::error::DIRECT_DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: true } });
  await client.connect();
  try {
    const { rows } = await client.query(ADMIN_PROBE_SQL);
    const verdict = readAdminVerdict(rows);
    console.log(`current_user=${verdict.currentUser} is_admin=${verdict.isAdmin}`);
    if (!verdict.isAdmin) {
      console.error('::error::not an administrator; db push will fail');
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
