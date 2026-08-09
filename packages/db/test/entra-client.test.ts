import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as entraSource from '../src/entra-source';
import * as entraToken from '../src/entra-token';
import type { AccessToken, TokenProviderOptions } from '../src/entra-token';
import {
  NEARLY_EXPIRED_MARKER,
  RENEWAL_FAILED_MARKER,
  createTokenAlarms,
} from '../src/token-alarm';

/**
 * What `createEntraPool` hands the token provider.
 *
 * The alarms are the only thing that turns a refresh fault on Vercel into something an operator
 * sees, and they are passed at one call site — so every case here fails if that argument goes.
 */

const URL_WITHOUT_PASSWORD =
  'postgresql://sbapp_vercel@psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com:5432/switchback?sslmode=verify-full';

const SIZING = { max: 7, connectionTimeoutMillis: 30_000 };

const CONNECTION_STRING =
  'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
  'IngestionEndpoint=https://northcentralus-0.in.applicationinsights.azure.com/';

/**
 * Rebuilt per case: `entra-client` caches one provider per process, so a second pool in the same
 * module instance would reuse the first one's options and prove nothing about this call.
 */
async function buildPool(mode: 'entra' | 'entra-vercel' = 'entra-vercel') {
  vi.resetModules();

  const providerFactory = vi.fn(
    (_source: unknown, _options?: TokenProviderOptions) => async () => 'a-token',
  );

  vi.doMock('../src/entra-token', async (importOriginal) => ({
    ...(await importOriginal<typeof entraToken>()),
    createTokenProvider: providerFactory,
  }));
  // Kept off the network: a real credential would be constructed against an absent environment.
  vi.doMock('../src/entra-source', async (importOriginal) => ({
    ...(await importOriginal<typeof entraSource>()),
    createEntraTokenSource: () => async () => ({ token: 't', expiresOnTimestamp: 0 }),
  }));

  const { createEntraPool } = await import('../src/entra-client');
  createEntraPool(URL_WITHOUT_PASSWORD, SIZING, mode);

  return providerFactory.mock.calls[0]?.[1];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the alarms createEntraPool wires', () => {
  it('passes both of them, so neither condition is left to a console nobody keeps', async () => {
    vi.stubEnv('APPLICATIONINSIGHTS_CONNECTION_STRING', CONNECTION_STRING);

    const options = await buildPool();

    expect(options?.onRenewalFailure).toBeTypeOf('function');
    expect(options?.onTokenNearlyExpired).toBeTypeOf('function');
  });

  it('carries a renewal failure off the instance, to a collector a rule can query', async () => {
    vi.stubEnv('APPLICATIONINSIGHTS_CONNECTION_STRING', CONNECTION_STRING);
    vi.stubEnv('VERCEL', '1');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ itemsReceived: 1, itemsAccepted: 1, errors: [] })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const options = await buildPool();
    await options?.onRenewalFailure?.(new Error('AADSTS700213'));

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toContain('/v2.1/track');
    const envelope = JSON.parse(init.body) as {
      tags: Record<string, string>;
      data: { baseData: { message: string } };
    };
    expect(envelope.data.baseData.message).toContain(RENEWAL_FAILED_MARKER);
    expect(envelope.tags['ai.cloud.role']).toBe('switchback-web');
  });

  it('carries a near-expired token the same way', async () => {
    vi.stubEnv('APPLICATIONINSIGHTS_CONNECTION_STRING', CONNECTION_STRING);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ itemsReceived: 1, itemsAccepted: 1, errors: [] })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const options = await buildPool();
    await options?.onTokenNearlyExpired?.(9_000);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(init.body).toContain(NEARLY_EXPIRED_MARKER);
  });

  it('does not fail the connection when the collector is unreachable', async () => {
    vi.stubEnv('APPLICATIONINSIGHTS_CONNECTION_STRING', CONNECTION_STRING);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }),
    );

    const base = 1_700_000_000_000;
    let clock = base;
    const source = vi
      .fn<() => Promise<AccessToken>>()
      .mockResolvedValueOnce({ token: 'first', expiresOnTimestamp: base + 3_600_000 })
      .mockRejectedValue(new Error('Entra unreachable'));

    const token = entraToken.createTokenProvider(source, {
      ...createTokenAlarms(),
      now: () => clock,
    });

    await token();
    clock = base + 3_540_000; // inside the renewal margin, a minute short of expiry

    // The alarm cannot be delivered and the cached token is still good. Serving it is the whole
    // point of the failure path, and a dead collector must not be what takes the site down.
    await expect(token()).resolves.toBe('first');
  });
});
