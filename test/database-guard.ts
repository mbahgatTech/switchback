/**
 * Keeps `npm test` off any database that is not on this machine. The suite creates and deletes
 * rows, and a checkout whose `.env` names a hosted server turns a routine test run into a write
 * against it — so the run is refused before a client is ever constructed.
 */

import { isLocalDatabase } from '../packages/db/scripts/local-database';

/** Set to `1` (or `true`) to run the suite against a database that is not on this machine. */
export const ALLOW_REMOTE_TEST_DB = 'SWITCHBACK_ALLOW_REMOTE_TEST_DB';

/**
 * Both, not just the pooled one. `schema.prisma` binds `directUrl` to the second, so it is the
 * variable a Prisma CLI invocation would do DDL through, and vitest hands every test process both.
 */
const GUARDED = ['DATABASE_URL', 'DIRECT_DATABASE_URL'] as const;

/** `0`, `false` and empty are not opt-ins — an escape hatch that opens on any value is a trap. */
function optedIn(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}

/** The host for the refusal message. The decision itself belongs to `isLocalDatabase`. */
function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Throws unless every database variable names this machine. The message carries the host and
 * nothing else: these values hold a live password, so echoing one would leak it to any terminal,
 * CI log or screenshot that captured the failure.
 */
export function assertLocalTestDatabase(env: Record<string, string | undefined>): void {
  if (optedIn(env[ALLOW_REMOTE_TEST_DB])) return;

  for (const key of GUARDED) {
    const url = env[key];
    if (!url || isLocalDatabase(url)) continue;

    throw new Error(
      `${key} names ${hostOf(url) ?? 'a host that cannot be parsed out of the value'}, not a ` +
        `database on this machine, and the test suite writes: it creates and deletes rows in ` +
        `whatever it is pointed at. Start the local database with \`npm run db:up\`, or set ` +
        `${ALLOW_REMOTE_TEST_DB}=1 to run against it anyway.`,
    );
  }
}
