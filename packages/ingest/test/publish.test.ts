import { afterEach, describe, expect, it, vi } from 'vitest';
import { ingestQueueDriver, publishIngestSignals } from '../src/publish';

const CONNECTION =
  'Endpoint=sb://sb-switchback-prod-abc.servicebus.windows.net/;SharedAccessKeyName=vercel-send;SharedAccessKey=c2VjcmV0LWtleS12YWx1ZQ==;EntityPath=ingest-jobs';

function envWith(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    INGEST_QUEUE_DRIVER: 'servicebus',
    SERVICE_BUS_SEND_CONNECTION_STRING: CONNECTION,
    ...overrides,
  };
}

/** The one call `publishIngestSignals` makes, captured. */
function captureFetch(response: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn((url: string | URL, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

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
  it('sends one batch POST naming each dedupeKey as the MessageId', async () => {
    const { calls } = captureFetch(new Response(null, { status: 201 }));

    const result = await publishIngestSignals(
      ['ingest_tile:021231321', 'ingest_tile:021231323'],
      envWith(),
    );

    expect(result).toEqual({ published: 2, failed: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://sb-switchback-prod-abc.servicebus.windows.net/ingest-jobs/messages',
    );

    const headers = calls[0]!.init.headers as Record<string, string>;
    // The batch content type, not application/json — the latter posts one message whose body
    // happens to be an array.
    expect(headers['Content-Type']).toBe('application/vnd.microsoft.servicebus.json');
    expect(headers.Authorization).toMatch(
      /^SharedAccessSignature sr=.+&sig=.+&se=\d+&skn=vercel-send$/u,
    );

    const body = JSON.parse(calls[0]!.init.body as string) as Array<{
      Body: string;
      BrokerProperties: { MessageId: string };
      UserProperties: { kind: string };
    }>;
    expect(body).toHaveLength(2);
    expect(body[0]!.BrokerProperties.MessageId).toBe('ingest_tile:021231321');
    expect(body[0]!.UserProperties.kind).toBe('ingest_tile');
    expect(JSON.parse(body[0]!.Body)).toEqual({ dedupeKey: 'ingest_tile:021231321' });
  });

  it('signs the queue URI, so a queue-scoped rule authorises the send', async () => {
    const { calls } = captureFetch(new Response(null, { status: 201 }));
    await publishIngestSignals(['ingest_tile:0'], envWith());

    const authorization = (calls[0]!.init.headers as Record<string, string>).Authorization!;
    const sr = decodeURIComponent(/sr=([^&]+)/u.exec(authorization)![1]!);
    expect(sr).toBe('https://sb-switchback-prod-abc.servicebus.windows.net/ingest-jobs');
  });

  it('prefers SERVICE_BUS_QUEUE over the connection string EntityPath', async () => {
    const { calls } = captureFetch(new Response(null, { status: 201 }));
    await publishIngestSignals(
      ['ingest_tile:0'],
      envWith({ SERVICE_BUS_QUEUE: 'ingest-jobs-canary' }),
    );
    expect(calls[0]!.url).toContain('/ingest-jobs-canary/messages');
  });

  it('reports failure instead of throwing when the broker is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    captureFetch(new Error('ECONNREFUSED'));

    await expect(publishIngestSignals(['ingest_tile:0'], envWith())).resolves.toEqual({
      published: 0,
      failed: 1,
    });
  });

  it('reports failure instead of throwing when the broker refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    captureFetch(new Response('unauthorized', { status: 401 }));

    await expect(publishIngestSignals(['ingest_tile:0'], envWith())).resolves.toEqual({
      published: 0,
      failed: 1,
    });
  });

  it('reports failure instead of throwing when the connection string is missing or unusable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { fetchMock } = captureFetch(new Response(null, { status: 201 }));

    await expect(
      publishIngestSignals(['ingest_tile:0'], { INGEST_QUEUE_DRIVER: 'servicebus' }),
    ).resolves.toEqual({ published: 0, failed: 1 });

    await expect(
      publishIngestSignals(
        ['ingest_tile:0'],
        envWith({ SERVICE_BUS_SEND_CONNECTION_STRING: 'nonsense' }),
      ),
    ).resolves.toEqual({ published: 0, failed: 1 });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing at all for an empty key list', async () => {
    const { fetchMock } = captureFetch(new Response(null, { status: 201 }));
    await expect(publishIngestSignals([], envWith())).resolves.toEqual({ published: 0, failed: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits past the batch ceiling rather than posting one oversized body', async () => {
    const { calls } = captureFetch(new Response(null, { status: 201 }));
    const keys = Array.from({ length: 250 }, (_, i) => `ingest_tile:${String(i)}`);

    await expect(publishIngestSignals(keys, envWith())).resolves.toEqual({
      published: 250,
      failed: 0,
    });
    expect(calls.map((call) => (JSON.parse(call.init.body as string) as unknown[]).length)).toEqual(
      [100, 100, 50],
    );
  });
});
