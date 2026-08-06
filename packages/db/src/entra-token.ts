/**
 * The password half of Entra authentication to Postgres: a cached access token, renewed on a
 * timer rather than on a failure, handed to `pg` as the per-connection password.
 */

/** What a token source returns. Matches `@azure/identity`'s `AccessToken` field-for-field. */
export interface AccessToken {
  token: string;
  /** Milliseconds since the epoch, as `@azure/identity` reports it. */
  expiresOnTimestamp: number;
}

export type TokenSource = () => Promise<AccessToken>;

/** Entra's own tolerated clock skew: a token may be judged up to this much older than it is. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Longest a single checkout may hold one connection — the Azure Functions Consumption ceiling,
 * which is the largest of the three consumers. Vercel routes cap at 60s and the trail
 * transaction at 30s (`TRAIL_TX_TIMEOUT_MS`).
 */
export const MAX_CHECKOUT_S = 10 * 60;

/** How long a pooled connection may live before `pg.Pool`'s `maxLifetimeSeconds` retires it. */
export const CONNECTION_LIFETIME_S = 20 * 60;

/**
 * Renew this far ahead of expiry — derived, not chosen.
 *
 * A connection can be opened with the least-fresh token this cache will serve, live a full
 * `CONNECTION_LIFETIME_S`, and then be held for one more checkout: `pg-pool` marks a
 * *checked-out* client expired but defers retiring it until `release()`. So the margin has to
 * cover both, plus skew. Anything smaller lets a connection outlive the token that opened it,
 * which is the single failure this module exists to prevent — and did permit, at a flat five
 * minutes against a thirty-minute connection.
 */
export const RENEW_MARGIN_MS = (CONNECTION_LIFETIME_S + MAX_CHECKOUT_S) * 1_000 + CLOCK_SKEW_MS;

/**
 * How long a failed renewal suppresses the next attempt.
 *
 * Without it a fast-failing Entra gets one request per new physical connection — the
 * per-principal throttling the in-flight collapse below was written to avoid, arriving by the
 * other door. Short enough that recovery is still prompt inside the renewal margin.
 */
export const RENEW_RETRY_BACKOFF_MS = 10_000;

export interface TokenProviderOptions {
  renewMarginMs?: number;
  /** Injected so the renewal boundary can be tested without waiting an hour for it. */
  now?: () => number;
  /** Called when a renewal fails while a usable token is still cached. */
  onRenewalFailure?: (error: unknown) => void;
  /** Called when the source issues a token too short-lived for the margin to be honoured. */
  onTokenTooShort?: (lifetimeMs: number, requiredMs: number) => void;
}

// Defaults rather than optional calls. Both conditions are silent degradation otherwise: the
// app keeps serving while an Entra outage or a token-lifetime policy quietly removes the
// guarantee, and nobody learns until it becomes an outage.
const warnRenewalFailure = (error: unknown): void =>
  console.warn('[entra-token] renewal failed; serving the cached token', error);

const warnTokenTooShort = (lifetimeMs: number, requiredMs: number): void =>
  console.warn(
    `[entra-token] token lifetime ${Math.round(lifetimeMs / 1000)}s is under the ${Math.round(
      requiredMs / 1000,
    )}s renewal margin; a connection may outlive it`,
  );

/**
 * A function returning a currently-valid access token, for use as `pg`'s `password` option.
 *
 * `pg` invokes the password callback once per *physical* connection, so this is called on
 * every new connection and never on a reused one — which makes caching here the difference
 * between one token acquisition per connection and one per query.
 */
export function createTokenProvider(
  source: TokenSource,
  options: TokenProviderOptions = {},
): () => Promise<string> {
  const renewMarginMs = options.renewMarginMs ?? RENEW_MARGIN_MS;
  const now = options.now ?? Date.now;
  const onRenewalFailure = options.onRenewalFailure ?? warnRenewalFailure;
  const onTokenTooShort = options.onTokenTooShort ?? warnTokenTooShort;

  let cached: AccessToken | undefined;
  let inFlight: Promise<AccessToken> | undefined;
  let effectiveMarginMs = renewMarginMs;
  let retryNotBefore = 0;

  // `isUsable` is a type predicate; freshness deliberately is not. A predicate's false branch
  // narrows away `AccessToken`, and "not fresh" means the token is old, not absent — modelling
  // it as a predicate makes the still-valid token unreachable in the catch below.
  const isUsable = (t: AccessToken | undefined): t is AccessToken =>
    t !== undefined && now() < t.expiresOnTimestamp;
  const isFresh = (t: AccessToken | undefined): boolean =>
    t !== undefined && now() < t.expiresOnTimestamp - effectiveMarginMs;

  // One refresh at a time. A pool opening its connections together would otherwise mint a
  // token per connection at exactly the moment the old one aged out, which is both wasteful
  // and the shape that trips Entra's per-principal request throttling.
  function refresh(): Promise<AccessToken> {
    inFlight ??= source()
      .then((token) => {
        // A token shorter-lived than the margin can never be fresh, so renewing at the margin
        // would re-acquire on every connection. Half its life keeps the cache useful and the
        // callback says the derived guarantee no longer holds.
        const lifetimeMs = token.expiresOnTimestamp - now();
        if (lifetimeMs <= renewMarginMs) {
          effectiveMarginMs = Math.max(0, Math.floor(lifetimeMs / 2));
          onTokenTooShort(lifetimeMs, renewMarginMs);
        } else {
          effectiveMarginMs = renewMarginMs;
        }
        cached = token;
        return token;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  return async function accessToken(): Promise<string> {
    const current = cached;
    if (current !== undefined && isFresh(current)) return current.token;

    // A renewal that just failed is not retried on the next connection, only after the
    // backoff — but only while the cached token is still genuinely usable.
    if (isUsable(current) && now() < retryNotBefore) return current.token;

    try {
      return (await refresh()).token;
    } catch (error) {
      // Inside the renewal margin the previous token is still accepted, so a transient
      // failure to renew must not fail the connection — it is retried by a later one. The
      // app only goes down if renewal is still failing once the old token has genuinely
      // expired, which is the point at which there is nothing honest left to return.
      if (isUsable(current)) {
        retryNotBefore = now() + RENEW_RETRY_BACKOFF_MS;
        onRenewalFailure(error);
        return current.token;
      }
      throw error;
    }
  };
}
