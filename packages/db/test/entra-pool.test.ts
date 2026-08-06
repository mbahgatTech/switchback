import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createEntraPool } from '../src/entra-client';
import { entraPoolConfig } from '../src/entra-pool';
import { CONNECTION_LIFETIME_S, CONNECT_BUDGET_MS, createTokenProvider } from '../src/entra-token';
import type { AccessToken } from '../src/entra-token';

const URL_WITHOUT_PASSWORD =
  'postgresql://sbapp_runtime@psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com:5432/switchback?sslmode=verify-full';

const sizing = { max: 7, connectionTimeoutMillis: 30_000 };
const password = () => Promise.resolve('a-token');

describe('entraPoolConfig', () => {
  it('bounds connection lifetime, which is what caps the revocation window', () => {
    expect(entraPoolConfig(URL_WITHOUT_PASSWORD, { ...sizing, password }).maxLifetimeSeconds).toBe(
      CONNECTION_LIFETIME_S,
    );
  });

  it('carries the sizing that a driver adapter stops Prisma reading off the URL', () => {
    const config = entraPoolConfig(URL_WITHOUT_PASSWORD, { ...sizing, password });
    expect(config.max).toBe(7);
    expect(config.connectionTimeoutMillis).toBe(30_000);
  });

  it('splits the URL into discrete fields rather than passing it through', () => {
    const config = entraPoolConfig(URL_WITHOUT_PASSWORD, { ...sizing, password });
    expect(config.connectionString).toBeUndefined();
    expect(config.user).toBe('sbapp_runtime');
    expect(config.database).toBe('switchback');
    expect(config.port).toBe(5432);
    expect(config.host).toBe('psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com');
  });

  it('refuses a URL that still carries a password', () => {
    expect(() =>
      entraPoolConfig('postgresql://sbapp:secret@host:5432/switchback', { ...sizing, password }),
    ).toThrow(/carries a password/);
  });

  it('reads sslmode, which Prisma silently ignored', () => {
    const verify = entraPoolConfig(URL_WITHOUT_PASSWORD, { ...sizing, password });
    expect(verify.ssl).toEqual({
      rejectUnauthorized: true,
      servername: 'psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com',
    });

    const off = entraPoolConfig('postgresql://u@h:5432/d?sslmode=disable', { ...sizing, password });
    expect(off.ssl).toBe(false);

    const weak = entraPoolConfig('postgresql://u@h:5432/d?sslmode=require', {
      ...sizing,
      password,
    });
    expect(weak.ssl).toEqual({ rejectUnauthorized: false });
  });
});

describe('the pool the client is actually built from', () => {
  it('carries maxLifetimeSeconds, not merely a constant that names it', async () => {
    const pool = createEntraPool(URL_WITHOUT_PASSWORD, sizing, 'entra');
    try {
      expect(pool.options.maxLifetimeSeconds).toBe(CONNECTION_LIFETIME_S);
      expect(pool.options.max).toBe(7);
    } finally {
      await pool.end();
    }
  });

  /**
   * The trap this design was built around. `pg` merges a parsed `connectionString` *over* the
   * explicit config, so a URL carrying no password replaces the callback with `null` — the
   * token would never be requested and every connection would authenticate with nothing.
   */
  it('keeps the password a function once pg has parsed the config', () => {
    const config = entraPoolConfig(URL_WITHOUT_PASSWORD, { ...sizing, password });
    expect(typeof new pg.Client(config).password).toBe('function');

    const viaUrl = new pg.Client({ connectionString: URL_WITHOUT_PASSWORD, password });
    expect(viaUrl.password).toBeNull();
  });
});

describe('the pool and the token cache together', () => {
  /**
   * Binds the two halves at the seam that actually exists. A session outlives its own token —
   * measured, run 31062754668 — so the pool's lifetime bound is not protecting the token, and
   * what the token cache owes the pool is narrower: every connection the pool opens must get a
   * token with more life left than the connection attempt is allowed to take.
   */
  it('serves every connection a token that outlasts the connect timeout', async () => {
    const pool = createEntraPool(URL_WITHOUT_PASSWORD, sizing, 'entra');
    const configuredLifetimeS = pool.options.maxLifetimeSeconds;
    const connectTimeoutMs = pool.options.connectionTimeoutMillis;
    await pool.end();
    // Thrown rather than expected: a `toBeGreaterThanOrEqual(undefined)` below would not fail,
    // and an unbounded pool would satisfy the invariant it is supposed to violate.
    if (typeof configuredLifetimeS !== 'number' || configuredLifetimeS <= 0) {
      throw new Error(`the pool reports no connection lifetime: ${String(configuredLifetimeS)}`);
    }
    if (typeof connectTimeoutMs !== 'number') {
      throw new Error(`the pool reports no connect timeout: ${String(connectTimeoutMs)}`);
    }
    // The margin the provider renews on is derived from this number, so they have to be the
    // same number rather than two that happen to agree.
    expect(connectTimeoutMs).toBe(CONNECT_BUDGET_MS);

    let t = 1_700_000_000_000;
    const clock = { now: () => t };
    const minted = new Map<string, number>();
    let n = 0;
    const token = createTokenProvider(
      async (): Promise<AccessToken> => {
        const issued = { token: `tok-${++n}`, expiresOnTimestamp: t + 60 * 60_000 };
        minted.set(issued.token, issued.expiresOnTimestamp);
        return issued;
      },
      { now: clock.now },
    );

    let worstRemainingMs = Infinity;
    for (let minute = 0; minute < 24 * 60; minute++) {
      const handed = await token();
      worstRemainingMs = Math.min(worstRemainingMs, minted.get(handed)! - t);
      t += 60_000;
    }

    expect(worstRemainingMs).toBeGreaterThanOrEqual(connectTimeoutMs);
  });
});
