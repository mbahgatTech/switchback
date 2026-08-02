import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The ingest queue flag is read at the point of use by `@switchback/ingest`, so what `env.ts`
 * contributes is the startup refusal: a driver set to `servicebus` with nowhere to publish.
 */

const REAL_ENV = process.env;

const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://switchback:switchback@localhost:5433/switchback?schema=public',
  AUTH_SECRET: 'a'.repeat(32),
};

const CONNECTION =
  'Endpoint=sb://sb-example.servicebus.windows.net/;SharedAccessKeyName=vercel-send;SharedAccessKey=a2V5;EntityPath=ingest-jobs';

async function load(overrides: Record<string, string>) {
  vi.resetModules();
  process.env = { ...BASE, ...overrides };
  return (await import('../src/env')) as { env: Record<string, unknown> };
}

afterEach(() => {
  process.env = REAL_ENV;
});

describe('INGEST_QUEUE_DRIVER', () => {
  it('defaults to the Postgres drain', async () => {
    const { env } = await load({});
    expect(env.INGEST_QUEUE_DRIVER).toBe('postgres');
    expect(env.SERVICE_BUS_QUEUE).toBe('ingest-jobs');
  });

  it('refuses an unrecognised driver rather than silently falling back', async () => {
    await expect(load({ INGEST_QUEUE_DRIVER: 'servicebuss' })).rejects.toThrow(
      /INGEST_QUEUE_DRIVER/u,
    );
  });

  it('refuses servicebus with no connection string, naming the variable', async () => {
    await expect(load({ INGEST_QUEUE_DRIVER: 'servicebus' })).rejects.toThrow(
      /SERVICE_BUS_SEND_CONNECTION_STRING/u,
    );
  });

  it('accepts servicebus once the send credential is present', async () => {
    const { env } = await load({
      INGEST_QUEUE_DRIVER: 'servicebus',
      SERVICE_BUS_SEND_CONNECTION_STRING: CONNECTION,
    });
    expect(env.INGEST_QUEUE_DRIVER).toBe('servicebus');
  });
});

describe('.env.example', () => {
  const EXAMPLE = readFileSync(
    fileURLToPath(new URL('../../../.env.example', import.meta.url)),
    'utf8',
  );

  // The two Open-Meteo URLs sat here for months read by nothing. Anything documented must be
  // in the allowlist, which is the only place a variable becomes real.
  it('documents every Service Bus variable the allowlist declares', () => {
    for (const key of [
      'INGEST_QUEUE_DRIVER',
      'SERVICE_BUS_SEND_CONNECTION_STRING',
      'SERVICE_BUS_QUEUE',
    ]) {
      expect(EXAMPLE).toContain(`${key}=`);
    }
  });
});
