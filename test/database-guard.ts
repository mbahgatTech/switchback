/**
 * Keeps `npm test` off any database that is not on this machine. Every database-backed test gates
 * itself on its own hostname check, so a run pointed elsewhere skips them and still reports green —
 * a silent loss of coverage, and a per-file control the next database test can forget to copy.
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
  if (optedIn(env[ALLOW_REMOTE_TEST_DB])) {
    // `loadEnv` reads the repository-root `.env`, so the opt-in can sit in the same file that
    // names the remote host. Announced rather than silent, or a bypassed run looks like a clean one.
    const url = env.DATABASE_URL;
    const host = url ? hostOf(url) : undefined;
    console.warn(
      `${ALLOW_REMOTE_TEST_DB} is set: the database guard is off for this run, which may reach ` +
        `${host ?? 'a database that was never checked'}.`,
    );
    return;
  }

  for (const key of GUARDED) {
    const url = env[key];
    if (!url || isLocalDatabase(url)) continue;

    throw new Error(
      `${key} names ${hostOf(url) ?? 'a host that cannot be parsed out of the value'}, which is ` +
        `not a database on this machine. Point it at the local one — \`npm run db:up\` starts ` +
        `it. Against anything else the database tests skip themselves, so the run stays green ` +
        `while covering nothing. To use a remote database deliberately, set ` +
        `${ALLOW_REMOTE_TEST_DB}=1.`,
    );
  }
}
