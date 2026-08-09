/**
 * What a token-refresh fault does so that somebody finds out. On Vercel that means pushing to
 * Application Insights: its logs reach no Azure rule and its instances do not outlive the request.
 */
import { appInsightsTarget, createTraceSink, type Trace } from './app-insights';
import { CONNECT_BUDGET_MS, type TokenProviderOptions } from './entra-token';

/** Renewal is failing while the cached token still works — the window before an outage. */
export const RENEWAL_FAILED_MARKER = 'switchback-db-token-renewal-failed';

/** A token is being served with less life left than a connection attempt may take. */
export const NEARLY_EXPIRED_MARKER = 'switchback-db-token-nearly-expired';

/**
 * Least time between two alarms carrying the same marker.
 *
 * `onTokenNearlyExpired` fires per connection, not per renewal, so without a floor a saturated
 * pool would post once per connection on a path that is awaited. Well under the five minutes an
 * alert rule evaluates over, so nothing a rule needs is lost.
 */
export const ALARM_MIN_INTERVAL_MS = 30_000;

/** Enough to carry an `AADSTS` code and its sentence; the stack would carry no more signal. */
const MAX_ERROR_CHARS = 500;

/** Which of the two channels is live, for a deployment to report without disclosing anything. */
export type AlarmSink = 'application-insights' | 'console';

export function alarmSink(env: NodeJS.ProcessEnv = process.env): AlarmSink {
  return appInsightsTarget(env) ? 'application-insights' : 'console';
}

/** `AppTraces.AppRoleName`, which is how a rule separates these from the worker's own traces. */
export function alarmRole(env: NodeJS.ProcessEnv = process.env): string {
  return env.VERCEL === '1' ? 'switchback-web' : 'switchback-db-client';
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error).slice(0, MAX_ERROR_CHARS);
  return `${error.name}: ${error.message}`.slice(0, MAX_ERROR_CHARS);
}

/**
 * Lets one marker through per window and counts what it turned away.
 *
 * The count rides on the next alarm that does go out, so suppression stays visible rather than
 * making a storm look like a single event.
 */
function rateLimit(minIntervalMs: number, now: () => number) {
  const lastAt = new Map<string, number>();
  const heldBack = new Map<string, number>();

  return (marker: string): number | undefined => {
    const previous = lastAt.get(marker);
    if (previous !== undefined && now() - previous < minIntervalMs) {
      heldBack.set(marker, (heldBack.get(marker) ?? 0) + 1);
      return undefined;
    }
    lastAt.set(marker, now());
    const suppressed = heldBack.get(marker) ?? 0;
    heldBack.set(marker, 0);
    return suppressed;
  };
}

export interface TokenAlarmDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Replaces the Application Insights transport; absent means build one from the environment. */
  send?: (trace: Trace) => Promise<void>;
  log?: Pick<Console, 'warn' | 'error'>;
}

type TokenAlarms = Required<
  Pick<TokenProviderOptions, 'onRenewalFailure' | 'onTokenNearlyExpired'>
>;

/**
 * The two callbacks `createTokenProvider` takes, wired to a channel that outlives the invocation.
 *
 * Both always log as well as push. The console line is what a live `vercel logs --follow` shows
 * during an incident, and it is the whole signal when no connection string is configured.
 */
export function createTokenAlarms(deps: TokenAlarmDeps = {}): TokenAlarms {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const role = alarmRole(env);
  const target = appInsightsTarget(env);
  const send = deps.send ?? (target ? createTraceSink(target) : undefined);
  const allow = rateLimit(ALARM_MIN_INTERVAL_MS, now);

  const context: Record<string, string> = {
    environment: env.VERCEL_ENV ?? 'unknown',
    commit: (env.VERCEL_GIT_COMMIT_SHA ?? '').slice(0, 7),
  };

  const push = async (
    marker: string,
    message: string,
    severity: Trace['severity'],
    properties: Record<string, string>,
  ): Promise<void> => {
    if (!send) return;
    const suppressed = allow(marker);
    if (suppressed === undefined) return;
    await send({
      message: `${marker} ${message}`,
      severity,
      role,
      properties: {
        ...context,
        ...properties,
        marker,
        suppressedSincePrevious: String(suppressed),
      },
    });
  };

  return {
    onRenewalFailure: async (error) => {
      const detail = describe(error);
      log.warn(`${RENEWAL_FAILED_MARKER} serving the cached token; renewal failed: ${detail}`);
      await push(RENEWAL_FAILED_MARKER, `renewal failed: ${detail}`, 'warning', { error: detail });
    },

    onTokenNearlyExpired: async (lifetimeMs) => {
      const seconds = Math.round(lifetimeMs / 1000);
      const budget = Math.round(CONNECT_BUDGET_MS / 1000);
      const message = `serving a token with ${seconds}s left, under the ${budget}s a connect may take`;
      log.error(`${NEARLY_EXPIRED_MARKER} ${message}`);
      await push(NEARLY_EXPIRED_MARKER, message, 'error', { lifetimeMs: String(lifetimeMs) });
    },
  };
}
