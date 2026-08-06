import type { PoolConfig } from 'pg';
import { CONNECTION_LIFETIME_S } from './entra-token';

/**
 * Turns `DATABASE_URL` into `pg.Pool` options whose password is a function, not a string.
 *
 * Discrete fields rather than `connectionString`, because `pg` merges a parsed connection
 * string *over* the explicit config — a URL carrying no password would blank the callback.
 */

export interface EntraPoolOptions {
  /** Called once per physical connection; returns a currently-valid access token. */
  password: () => Promise<string>;
  max: number;
  connectionTimeoutMillis: number;
}

/**
 * `sslmode` as libpq spells it, mapped onto what `pg` accepts.
 *
 * Prisma silently ignores connection parameters it does not recognise, so the `verify-full`
 * already in the deployed URLs has never actually been enforced. Here it is read.
 */
function tlsFor(sslmode: string | null, host: string): PoolConfig['ssl'] {
  switch (sslmode) {
    case 'disable':
      return false;
    case 'allow':
    case 'prefer':
    case 'require':
      return { rejectUnauthorized: false };
    default:
      return { rejectUnauthorized: true, servername: host };
  }
}

export function entraPoolConfig(databaseUrl: string, options: EntraPoolOptions): PoolConfig {
  const url = new URL(databaseUrl);
  if (url.password) {
    throw new Error('DATABASE_URL carries a password, which Entra authentication replaces.');
  }

  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
    user: decodeURIComponent(url.username),
    ssl: tlsFor(url.searchParams.get('sslmode'), url.hostname),
    password: options.password,
    max: options.max,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    // Bounds how long a connection authenticated by a since-revoked identity keeps serving.
    // A session survives its own token's expiry — measured, run 31062754668 — so nothing
    // retires it on credential grounds and revocation would otherwise take effect only at the
    // next cold start. With the firewall spanning the whole IPv4 internet, identity is the
    // only boundary here, which makes that window a security parameter rather than a nicety.
    maxLifetimeSeconds: CONNECTION_LIFETIME_S,
  };
}
