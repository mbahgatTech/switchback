import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Only Vercel Production may hold the production database string. Preview runs unreviewed branch
 * code against whatever `DATABASE_URL` it is given, and the Postgres firewall spans the whole
 * IPv4 range, so the credential is the only boundary there is.
 */

const REAL_ENV = process.env;

const PRODUCTION_HOST = 'psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com';
const PRODUCTION_URL = `postgresql://sbapp:pw@${PRODUCTION_HOST}:5432/switchback?sslmode=verify-full`;
const SCRATCH_URL = 'postgresql://switchback:switchback@localhost:5433/switchback?schema=public';

const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: SCRATCH_URL,
  AUTH_SECRET: 'a'.repeat(32),
};

async function load(overrides: Record<string, string>) {
  vi.resetModules();
  process.env = { ...BASE, ...overrides };
  return (await import('../src/env')) as { env: Record<string, unknown> };
}

afterEach(() => {
  process.env = REAL_ENV;
});

describe('production database access by Vercel environment', () => {
  it('lets Production hold it', async () => {
    const { env } = await load({ VERCEL_ENV: 'production', DATABASE_URL: PRODUCTION_URL });
    expect(env.VERCEL_ENV).toBe('production');
  });

  it('lets Preview hold a database of its own', async () => {
    const { env } = await load({ VERCEL_ENV: 'preview', DATABASE_URL: SCRATCH_URL });
    expect(env.VERCEL_ENV).toBe('preview');
  });

  it('refuses Preview holding the production database', async () => {
    await expect(load({ VERCEL_ENV: 'preview', DATABASE_URL: PRODUCTION_URL })).rejects.toThrow(
      /DATABASE_URL: DATABASE_URL names the production database/u,
    );
  });

  it('refuses it through DIRECT_DATABASE_URL as well', async () => {
    await expect(
      load({
        VERCEL_ENV: 'preview',
        DATABASE_URL: SCRATCH_URL,
        DIRECT_DATABASE_URL: PRODUCTION_URL,
      }),
    ).rejects.toThrow(/DIRECT_DATABASE_URL names the production database/u);
  });

  // Off Vercel there is no VERCEL_ENV, and CI's migrate job legitimately holds this string.
  it('is inert where VERCEL_ENV is absent', async () => {
    const { env } = await load({ DATABASE_URL: PRODUCTION_URL });
    expect(env.VERCEL_ENV).toBeUndefined();
  });
});
