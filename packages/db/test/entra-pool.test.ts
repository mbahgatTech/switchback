import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createEntraPool } from '../src/entra-client';
import { entraPoolConfig } from '../src/entra-pool';
import { CONNECTION_LIFETIME_S, MAX_CHECKOUT_S, createTokenProvider } from '../src/entra-token';
import type { AccessToken } from '../src/entra-token';

const URL_WITHOUT_PASSWORD =
  'postgresql://sbapp_vercel@psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com:5432/switchback?sslmode=verify-full';

const sizing = { max: 7, connectionTimeoutMillis: 30_000 };
const password = () => Promise.resolve('a-token');

describe('entraPoolConfig', () => {
  it('bounds connection lifetime, which is what the renewal margin is derived from', () => {
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
    expect(config.user).toBe('sbapp_vercel');
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
   * Binds the two halves: whatever lifetime the pool is configured with, plus the longest a
   * checkout may hold a connection, must fit inside the life left on the least-fresh token the
   * cache will hand out. Sampling the cache rather than restating its arithmetic.
   */
  it('cannot let a connection outlive the token that opened it', async () => {
    const pool = createEntraPool(URL_WITHOUT_PASSWORD, sizing, 'entra');
    const configuredLifetimeS = pool.options.maxLifetimeSeconds;
    await pool.end();
    // Without this the arithmetic below goes to NaN, and `toBeGreaterThanOrEqual(NaN)` passes
    // — an unbounded pool would satisfy the invariant it is supposed to violate.
    expect(typeof configuredLifetimeS).toBe('number');
    expect(configuredLifetimeS).toBeGreaterThan(0);

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

    expect(worstRemainingMs).toBeGreaterThanOrEqual((configuredLifetimeS + MAX_CHECKOUT_S) * 1_000);
  });
});
