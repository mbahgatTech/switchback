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

const PUBLISHER: Record<string, string> = {
  SERVICE_BUS_NAMESPACE: 'sb-example.servicebus.windows.net',
  AZURE_TENANT_ID: 'f0f92920-ce90-42c9-b87f-3ea8644bccd8',
  AZURE_CLIENT_ID: '11111111-2222-3333-4444-555555555555',
};

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

  it('refuses servicebus with no publisher identity, naming every missing variable', async () => {
    await expect(load({ INGEST_QUEUE_DRIVER: 'servicebus' })).rejects.toThrow(
      /SERVICE_BUS_NAMESPACE[\s\S]*AZURE_TENANT_ID[\s\S]*AZURE_CLIENT_ID/u,
    );
  });

  it('accepts servicebus once the federated publisher identity is named', async () => {
    const { env } = await load({ INGEST_QUEUE_DRIVER: 'servicebus', ...PUBLISHER });
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
      'SERVICE_BUS_NAMESPACE',
      'SERVICE_BUS_QUEUE',
      'AZURE_TENANT_ID',
      'AZURE_CLIENT_ID',
    ]) {
      expect(EXAMPLE).toContain(`${key}=`);
    }
  });

  // The SAS path is gone, not merely unused: a connection string in the environment must not
  // quietly become a second way in.
  it('no longer documents a Service Bus connection string', () => {
    expect(EXAMPLE).not.toContain('SERVICE_BUS_SEND_CONNECTION_STRING');
  });
});
