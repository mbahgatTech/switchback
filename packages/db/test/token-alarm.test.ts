import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appInsightsTarget,
  createTraceSink,
  trackUrl,
  traceEnvelope,
  type AppInsightsTarget,
} from '../src/app-insights';
import {
  ALARM_MIN_INTERVAL_MS,
  NEARLY_EXPIRED_MARKER,
  RENEWAL_FAILED_MARKER,
  alarmRole,
  alarmSink,
  createTokenAlarms,
} from '../src/token-alarm';
import type { Trace } from '../src/app-insights';

/** Shaped like the live one — `az resource show` on `appi-switchback-ingest` — with a null key. */
const CONNECTION_STRING =
  'InstrumentationKey=00000000-0000-0000-0000-000000000000;' +
  'IngestionEndpoint=https://northcentralus-0.in.applicationinsights.azure.com/;' +
  'LiveEndpoint=https://northcentralus.livediagnostics.monitor.azure.com/';

const TARGET: AppInsightsTarget = {
  instrumentationKey: '00000000-0000-0000-0000-000000000000',
  ingestionEndpoint: 'https://northcentralus-0.in.applicationinsights.azure.com/',
};

const silent = { warn: () => {}, error: () => {} };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('appInsightsTarget', () => {
  it('reads the two fields the ingestion API needs', () => {
    expect(appInsightsTarget({ APPLICATIONINSIGHTS_CONNECTION_STRING: CONNECTION_STRING })).toEqual(
      TARGET,
    );
  });

  it('is undefined when the variable is absent, which is what leaves the console as the only sink', () => {
    expect(appInsightsTarget({})).toBeUndefined();
  });

  it('is undefined rather than half-built when a field is missing', () => {
    expect(
      appInsightsTarget({ APPLICATIONINSIGHTS_CONNECTION_STRING: 'InstrumentationKey=abc' }),
    ).toBeUndefined();
  });

  it('keeps a value containing its own separator intact', () => {
    const target = appInsightsTarget({
      APPLICATIONINSIGHTS_CONNECTION_STRING:
        'InstrumentationKey=k;IngestionEndpoint=https://host/path?a=b',
    });
    expect(target?.ingestionEndpoint).toBe('https://host/path?a=b');
  });
});

describe('the envelope', () => {
  const trace: Trace = {
    message: 'a message',
    severity: 'error',
    role: 'switchback-web',
    properties: { environment: 'production' },
  };

  it('posts to the collector the connection string names', () => {
    expect(trackUrl(TARGET)).toBe(
      'https://northcentralus-0.in.applicationinsights.azure.com/v2.1/track',
    );
  });

  it('carries the role a rule filters on, and the key that authenticates it', () => {
    const envelope = traceEnvelope(TARGET, trace, new Date('2026-08-09T20:56:41.989Z'));
    expect(envelope.tags['ai.cloud.role']).toBe('switchback-web');
    expect(envelope.iKey).toBe(TARGET.instrumentationKey);
    expect(envelope.time).toBe('2026-08-09T20:56:41.989Z');
    expect(envelope.data.baseType).toBe('MessageData');
    expect(envelope.data.baseData.severityLevel).toBe(3);
    expect(envelope.data.baseData.properties).toEqual({ environment: 'production' });
  });

  it('rejects when the collector refuses, so the caller does not record a delivery', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 400 }));
    await expect(createTraceSink(TARGET, { fetch: fetchMock })(trace)).rejects.toThrow(/400/);
  });
});

describe('createTokenAlarms', () => {
  it('carries a renewal failure to Application Insights under its marker', async () => {
    const send = vi.fn<(trace: Trace) => Promise<void>>(async () => {});
    const alarms = createTokenAlarms({
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: CONNECTION_STRING, VERCEL: '1' },
      send,
      log: silent,
    });

    await alarms.onRenewalFailure(new Error('AADSTS700213: no matching federated identity record'));

    expect(send).toHaveBeenCalledOnce();
    const trace = send.mock.calls[0]![0];
    expect(trace.message).toContain(RENEWAL_FAILED_MARKER);
    expect(trace.message).toContain('AADSTS700213');
    expect(trace.role).toBe('switchback-web');
  });

  it('reports a near-expired token as an error, with the life that was left', async () => {
    const send = vi.fn<(trace: Trace) => Promise<void>>(async () => {});
    const alarms = createTokenAlarms({
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: CONNECTION_STRING },
      send,
      log: silent,
    });

    await alarms.onTokenNearlyExpired(9_000);

    const trace = send.mock.calls[0]![0];
    expect(trace.message).toContain(NEARLY_EXPIRED_MARKER);
    expect(trace.severity).toBe('error');
    expect(trace.properties?.lifetimeMs).toBe('9000');
  });

  it('still says something when no connection string is configured', async () => {
    const warn = vi.fn();
    const alarms = createTokenAlarms({ env: {}, log: { warn, error: () => {} } });

    await alarms.onRenewalFailure(new Error('Entra unreachable'));

    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).toContain(RENEWAL_FAILED_MARKER);
  });

  it('does not post one trace per connection, and says how many it held back', async () => {
    let t = 0;
    const send = vi.fn<(trace: Trace) => Promise<void>>(async () => {});
    const alarms = createTokenAlarms({
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: CONNECTION_STRING },
      send,
      log: silent,
      now: () => t,
    });

    // A saturated pool: `onTokenNearlyExpired` fires per connection, not per renewal.
    for (let i = 0; i < 20; i += 1) await alarms.onTokenNearlyExpired(9_000);
    expect(send).toHaveBeenCalledOnce();

    t += ALARM_MIN_INTERVAL_MS + 1;
    await alarms.onTokenNearlyExpired(9_000);

    expect(send).toHaveBeenCalledTimes(2);
    const second = send.mock.calls[1]![0];
    expect(second.properties?.suppressedSincePrevious).toBe('19');
  });

  it('rate-limits each marker on its own, so one does not mask the other', async () => {
    const send = vi.fn<(trace: Trace) => Promise<void>>(async () => {});
    const alarms = createTokenAlarms({
      env: { APPLICATIONINSIGHTS_CONNECTION_STRING: CONNECTION_STRING },
      send,
      log: silent,
      now: () => 0,
    });

    await alarms.onTokenNearlyExpired(9_000);
    await alarms.onRenewalFailure(new Error('Entra unreachable'));

    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('what a deployment can report about itself', () => {
  it('names the live channel without disclosing any of it', () => {
    expect(alarmSink({ APPLICATIONINSIGHTS_CONNECTION_STRING: CONNECTION_STRING })).toBe(
      'application-insights',
    );
    expect(alarmSink({})).toBe('console');
  });

  it('separates the web app from anything else holding the same package', () => {
    expect(alarmRole({ VERCEL: '1' })).toBe('switchback-web');
    expect(alarmRole({})).toBe('switchback-db-client');
  });
});
