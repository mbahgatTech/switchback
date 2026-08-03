import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ingestQueueDriver, publishIngestSignals, resetPublisherToken } from '../src/publish';

const TOKEN_URL = 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token';
const SEND_URL = 'https://sb-switchback-prod-abc.servicebus.windows.net/ingest-jobs/messages';

function envWith(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    INGEST_QUEUE_DRIVER: 'servicebus',
    SERVICE_BUS_NAMESPACE: 'sb-switchback-prod-abc.servicebus.windows.net',
    AZURE_TENANT_ID: 'tenant-id',
    AZURE_CLIENT_ID: 'client-id',
    ...overrides,
  };
}

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * Both calls the publisher can make, captured and answered separately: the exchange at Entra
 * and the send at the broker fail for different reasons and the tests need to tell them apart.
 */
function captureFetch(options: { token?: Response | Error; send?: Response | Error } = {}) {
  const calls: Call[] = [];
  const token =
    options.token ??
    new Response(JSON.stringify({ access_token: 'entra-access-token', expires_in: 3600 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  const send = options.send ?? new Response(null, { status: 201 });

  const fetchMock = vi.fn((url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    const answer = String(url).includes('login.microsoftonline.com') ? token : send;
    // Cloned so a body can be read once per call rather than once per test.
    if (answer instanceof Error) return Promise.reject(answer);
    return Promise.resolve(answer.clone());
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock, sends: () => calls.filter((call) => call.url === SEND_URL) };
}

beforeEach(() => {
  resetPublisherToken();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ingestQueueDriver', () => {
  it('defaults to postgres and treats anything unrecognised as postgres', () => {
    expect(ingestQueueDriver({})).toBe('postgres');
    expect(ingestQueueDriver({ INGEST_QUEUE_DRIVER: '' })).toBe('postgres');
    expect(ingestQueueDriver({ INGEST_QUEUE_DRIVER: 'servicebuss' })).toBe('postgres');
    expect(ingestQueueDriver({ INGEST_QUEUE_DRIVER: ' servicebus ' })).toBe('servicebus');
  });
});

describe('publishIngestSignals', () => {
  const options = (overrides: Record<string, string> = {}) => ({
    oidcToken: 'vercel-oidc-token',
    env: envWith(overrides),
  });

  it('exchanges the OIDC token for an Entra token, then sends one batch POST', async () => {
    const { calls } = captureFetch();

    const result = await publishIngestSignals(
      ['ingest_tile:021231321', 'ingest_tile:021231323'],
      options(),
    );

    expect(result).toEqual({ published: 2, failed: 0 });
    expect(calls.map((call) => call.url)).toEqual([TOKEN_URL, SEND_URL]);

    const form = new URLSearchParams(calls[0]!.init.body as string);
    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('client-id');
    expect(form.get('scope')).toBe('https://servicebus.azure.net/.default');
    expect(form.get('client_assertion_type')).toBe(
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    );
    // The Vercel token is the assertion. Nothing else in this path is a credential.
    expect(form.get('client_assertion')).toBe('vercel-oidc-token');

    const headers = calls[1]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer entra-access-token');
    // The batch content type, not application/json — the latter posts one message whose body
    // happens to be an array.
    expect(headers['Content-Type']).toBe('application/vnd.microsoft.servicebus.json');

    const body = JSON.parse(calls[1]!.init.body as string) as Array<{
      Body: string;
      BrokerProperties: { MessageId: string };
      UserProperties: { kind: string };
    }>;
    expect(body).toHaveLength(2);
    expect(body[0]!.BrokerProperties.MessageId).toBe('ingest_tile:021231321');
    expect(body[0]!.UserProperties.kind).toBe('ingest_tile');
    expect(JSON.parse(body[0]!.Body)).toEqual({ dedupeKey: 'ingest_tile:021231321' });
  });

  it('exchanges once and reuses the access token — a warm lambda pays for one', async () => {
    const { calls } = captureFetch();

    await publishIngestSignals(['ingest_tile:0'], options());
    await publishIngestSignals(['ingest_tile:1'], options());

    expect(calls.filter((call) => call.url === TOKEN_URL)).toHaveLength(1);
    expect(calls.filter((call) => call.url === SEND_URL)).toHaveLength(2);
  });

  it('honours SERVICE_BUS_QUEUE', async () => {
    const { calls } = captureFetch();
    await publishIngestSignals(['ingest_tile:0'], options({ SERVICE_BUS_QUEUE: 'ingest-canary' }));
    expect(calls[1]!.url).toContain('/ingest-canary/messages');
  });

  it('reports failure instead of throwing when the broker is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    captureFetch({ send: new Error('ECONNREFUSED') });

    await expect(publishIngestSignals(['ingest_tile:0'], options())).resolves.toEqual({
      published: 0,
      failed: 1,
    });
  });

  it('reports failure instead of throwing when the broker refuses the token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    captureFetch({ send: new Response('unauthorized', { status: 401 }) });

    await expect(publishIngestSignals(['ingest_tile:0'], options())).resolves.toEqual({
      published: 0,
      failed: 1,
    });
  });

  it('sends nothing when Entra refuses the assertion — a broker outage is not a map outage', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { sends } = captureFetch({ token: new Response('{}', { status: 400 }) });

    await expect(publishIngestSignals(['ingest_tile:0'], options())).resolves.toEqual({
      published: 0,
      failed: 1,
    });
    expect(sends()).toHaveLength(0);
  });

  it('does not attempt an exchange with no OIDC token on the request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fetchMock } = captureFetch();

    await expect(
      publishIngestSignals(['ingest_tile:0'], { oidcToken: '  ', env: envWith() }),
    ).resolves.toEqual({ published: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when the publisher identity is not configured', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fetchMock } = captureFetch();

    await expect(
      publishIngestSignals(['ingest_tile:0'], {
        oidcToken: 'vercel-oidc-token',
        env: { INGEST_QUEUE_DRIVER: 'servicebus' },
      }),
    ).resolves.toEqual({ published: 0, failed: 1 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing at all for an empty key list', async () => {
    const { fetchMock } = captureFetch();
    await expect(publishIngestSignals([], options())).resolves.toEqual({
      published: 0,
      failed: 0,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits past the batch ceiling rather than posting one oversized body', async () => {
    const { sends } = captureFetch();
    const keys = Array.from({ length: 250 }, (_, i) => `ingest_tile:${String(i)}`);

    await expect(publishIngestSignals(keys, options())).resolves.toEqual({
      published: 250,
      failed: 0,
    });
    expect(
      sends().map((call) => (JSON.parse(call.init.body as string) as unknown[]).length),
    ).toEqual([100, 100, 50]);
  });
});
