/**
 * Pushing a trace to Application Insights over its ingestion API, from a process Azure does not
 * host. Vercel's own logs reach no Azure rule, so a push is the only channel that outlives them.
 */

/** The two fields of an Application Insights connection string a trace needs. */
export interface AppInsightsTarget {
  instrumentationKey: string;
  /** Regional collector, trailing slash included, exactly as the connection string spells it. */
  ingestionEndpoint: string;
}

/**
 * Longest a trace may hold a connection open.
 *
 * Small on purpose: this is awaited on the path that opens a database connection, and
 * `CONNECT_BUDGET_MS` is the whole budget that path has.
 */
export const TRACE_TIMEOUT_MS = 2_000;

/** As the ingestion API numbers severity, which is what `AppTraces.SeverityLevel` then reports. */
export const SEVERITY = { warning: 2, error: 3 } as const;

export type Severity = keyof typeof SEVERITY;

export interface Trace {
  message: string;
  severity: Severity;
  /** Lands in `AppTraces.AppRoleName` — how a rule tells this process from the worker. */
  role: string;
  properties?: Record<string, string>;
}

/** Case-insensitive because the portal, the CLI and the SDKs disagree on how they spell the keys. */
function fields(raw: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const part of raw.split(';')) {
    const split = part.indexOf('=');
    // A value may itself contain '=', so split once at the first rather than on every one.
    if (split > 0)
      parsed.set(part.slice(0, split).trim().toLowerCase(), part.slice(split + 1).trim());
  }
  return parsed;
}

/** Undefined when the variable is absent or unusable, which the caller reports as no sink at all. */
export function appInsightsTarget(
  env: NodeJS.ProcessEnv = process.env,
): AppInsightsTarget | undefined {
  const raw = env.APPLICATIONINSIGHTS_CONNECTION_STRING;
  if (!raw) return undefined;

  const parsed = fields(raw);
  const instrumentationKey = parsed.get('instrumentationkey');
  const ingestionEndpoint = parsed.get('ingestionendpoint');
  if (!instrumentationKey || !ingestionEndpoint) return undefined;

  return { instrumentationKey, ingestionEndpoint };
}

export function trackUrl(target: AppInsightsTarget): string {
  return new URL('v2.1/track', target.ingestionEndpoint).toString();
}

export interface TraceEnvelope {
  name: 'Microsoft.ApplicationInsights.Message';
  time: string;
  iKey: string;
  tags: Record<string, string>;
  data: {
    baseType: 'MessageData';
    baseData: {
      ver: number;
      message: string;
      severityLevel: number;
      properties: Record<string, string>;
    };
  };
}

/** The classic `MessageData` envelope, which a workspace-based component stores as `AppTraces`. */
export function traceEnvelope(target: AppInsightsTarget, trace: Trace, at: Date): TraceEnvelope {
  return {
    name: 'Microsoft.ApplicationInsights.Message',
    time: at.toISOString(),
    iKey: target.instrumentationKey,
    tags: { 'ai.cloud.role': trace.role },
    data: {
      baseType: 'MessageData',
      baseData: {
        ver: 2,
        message: trace.message,
        severityLevel: SEVERITY[trace.severity],
        properties: trace.properties ?? {},
      },
    },
  };
}

export interface TraceSinkDeps {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/** What the collector answers a `v2.1/track` POST with. */
interface TrackResult {
  itemsReceived?: number;
  itemsAccepted?: number;
  errors?: { message?: string }[];
}

/**
 * A 200 is not acceptance: the collector answers `itemsAccepted: 0` with a per-item error for a
 * rejected envelope, and treating that as delivered is how a channel comes to watch nothing.
 */
async function rejection(response: Response): Promise<string | undefined> {
  if (!response.ok) return `status ${response.status}`;

  let result: TrackResult;
  try {
    result = (await response.json()) as TrackResult;
  } catch {
    // A 200 whose body is unreadable is taken at its word rather than failed on a guess.
    return undefined;
  }
  if (result.itemsAccepted === undefined || result.itemsAccepted > 0) return undefined;
  return result.errors?.[0]?.message ?? `accepted 0 of ${result.itemsReceived ?? 1}`;
}

/**
 * Posts one trace and rejects unless the collector took it.
 *
 * Authenticates with the instrumentation key in the envelope and nothing else, which is what makes
 * this reportable during an Entra outage — the failure it exists to report.
 */
export function createTraceSink(
  target: AppInsightsTarget,
  deps: TraceSinkDeps = {},
): (trace: Trace) => Promise<void> {
  const now = deps.now ?? (() => new Date());

  return async (trace) => {
    // Resolved per call rather than captured, so a test may replace the global.
    const send = deps.fetch ?? globalThis.fetch;
    const response = await send(trackUrl(target), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(traceEnvelope(target, trace, now())),
      signal: AbortSignal.timeout(TRACE_TIMEOUT_MS),
    });

    const refused = await rejection(response);
    if (refused) throw new Error(`Application Insights refused the trace: ${refused}.`);
  };
}
