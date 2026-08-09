/**
 * The password half of Entra authentication to Postgres: a cached access token, checked on use
 * and renewed when the issuer says to, handed to `pg` as a connection's password.
 */

/** What a token source returns. The fields of `@azure/identity`'s `AccessToken` this reads. */
export interface AccessToken {
  token: string;
  /** Milliseconds since the epoch, as `@azure/identity` reports it. */
  expiresOnTimestamp: number;
  /**
   * Entra's `refresh_in`, in the same units. Populated by `@azure/identity` on both the
   * client-assertion and managed-identity paths, and roughly half-life — renewing on it is what
   * the issuer is asking for, and it is the only signal that scales to a 24-hour token.
   */
  refreshAfterTimestamp?: number;
}

export type TokenSource = () => Promise<AccessToken>;

/** Entra's own tolerated clock skew: a token may be judged up to this much older than it is. */
export const CLOCK_SKEW_MS = 5 * 60_000;

/** Longest a connection attempt may take — the larger of the two pools' `connectionTimeoutMillis`. */
export const CONNECT_BUDGET_MS = 30_000;

/**
 * How long a pooled connection may live before `pg.Pool`'s `maxLifetimeSeconds` retires it.
 *
 * A revocation bound, not a token-lifetime one. Nothing here derives from it.
 */
export const CONNECTION_LIFETIME_S = 20 * 60;

/**
 * Renew this far ahead of expiry: enough for the handshake plus skew, and no more.
 *
 * The token is checked at connect and never again, and MSAL will not mint one earlier than its own
 * five-minute floor — both measured, both in docs/architecture.md under the token lifecycle.
 */
export const RENEW_MARGIN_MS = CLOCK_SKEW_MS + CONNECT_BUDGET_MS;

/**
 * How long a fruitless acquisition suppresses the next attempt, so a fast-failing Entra or a
 * background MSAL refresh gets one retry rather than one per new physical connection.
 */
export const RENEW_RETRY_BACKOFF_MS = 10_000;

export interface TokenProviderOptions {
  renewMarginMs?: number;
  /** Injected so the renewal boundary can be tested without waiting an hour for it. */
  now?: () => number;
  /** Called when an acquisition fails while a usable token is still cached. */
  onRenewalFailure?: (error: unknown) => void | Promise<void>;
  /** Called when a token is served with too little life left to be sure a connect completes. */
  onTokenNearlyExpired?: (lifetimeMs: number) => void | Promise<void>;
}

// Defaults rather than optional calls. Both conditions are silent degradation otherwise: the
// app keeps serving while an Entra outage or a token-lifetime policy quietly removes the
// guarantee, and nobody learns until it becomes an outage. A console line is the floor, not the
// plan — `token-alarm.ts` is what carries these somewhere a rule can read, and `entra-client.ts`
// is what passes it.
const warnRenewalFailure = (error: unknown): void =>
  console.warn('[entra-token] renewal failed; serving the cached token', error);

// `error`, not `warn`: a token with less life left than the handshake it is authenticating may
// die mid-connect, which is the one condition here that refuses a connection rather than
// degrading. The margin already carries clock skew, so this measures the handshake alone.
// Unreachable on either healthy path — `refresh_in` renews at half-life, and the margin
// fallback renews five minutes out — which is what makes it a signal rather than noise.
const warnTokenNearlyExpired = (lifetimeMs: number): void =>
  console.error(
    `[entra-token] serving a token with ${Math.round(lifetimeMs / 1000)}s left, under the ` +
      `${Math.round(CONNECT_BUDGET_MS / 1000)}s a connection attempt may take. Connections may ` +
      `be refused. Entra is unreachable, or is issuing tokens shorter than the renewal margin.`,
  );

/**
 * Runs an alarm to completion without letting it fail the connection that raised it.
 *
 * Awaited rather than dropped because the caller may be on Vercel, where an invocation that has
 * answered its request is frozen — an unawaited report is one the platform is free to discard.
 */
async function raise(alarm: () => void | Promise<void>): Promise<void> {
  try {
    await alarm();
  } catch {
    // A report that cannot be delivered leaves nothing further to report it to.
  }
}

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
  const onTokenNearlyExpired = options.onTokenNearlyExpired ?? warnTokenNearlyExpired;

  let cached: AccessToken | undefined;
  let inFlight: Promise<AccessToken> | undefined;
  let retryNotBefore = 0;
  // Normalised on capture so every caller gets a stack, whatever the credential rejected with.
  let lastFailure: Error | undefined;

  // `isUsable` is a type predicate; freshness deliberately is not. A predicate's false branch
  // narrows away `AccessToken`, and "not fresh" means the token is old, not absent — modelling
  // it as a predicate makes the still-valid token unreachable in the catch below.
  const isUsable = (t: AccessToken | undefined): t is AccessToken =>
    t !== undefined && now() < t.expiresOnTimestamp;

  // The issuer's own hint where it gave one, and never later than the margin regardless. A
  // `refresh_in` far out on a 24-hour managed-identity token must not defer past the point
  // where a connect would be at risk.
  const renewAt = (t: AccessToken): number =>
    Math.min(t.refreshAfterTimestamp ?? Infinity, t.expiresOnTimestamp - renewMarginMs);

  // One acquisition at a time. A pool opening its connections together would otherwise ask for
  // a token per connection at exactly the moment the old one aged out, which is both wasteful
  // and the shape that trips Entra's per-principal request throttling.
  function acquire(previous: AccessToken | undefined): Promise<AccessToken> {
    inFlight ??= source()
      .then((token) => {
        // The same token back. MSAL refreshes proactively past `refreshOn` and returns what it
        // already holds until the new one lands, so this is the normal path, not a fault: the
        // renewal is pending upstream. Backing off is what stops every connection re-asking.
        if (previous && token.expiresOnTimestamp === previous.expiresOnTimestamp) {
          retryNotBefore = now() + RENEW_RETRY_BACKOFF_MS;
        }
        // Cleared here, not merely overwritten on the next failure. A recorded error outlives
        // the condition that produced it otherwise, and the backoff below rethrows it — so a
        // long-resolved outage becomes the error reported during the next, unrelated one.
        lastFailure = undefined;
        cached = token;
        return token;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  }

  async function serve(token: AccessToken): Promise<string> {
    const lifetimeMs = token.expiresOnTimestamp - now();
    if (lifetimeMs < CONNECT_BUDGET_MS) await raise(() => onTokenNearlyExpired(lifetimeMs));
    return token.token;
  }

  return async function accessToken(): Promise<string> {
    const current = cached;
    if (current !== undefined && now() < renewAt(current)) return current.token;

    // The source was asked recently and gave nothing better. While the cached token is still
    // usable that means serving it; once it is not, it means failing on the recorded error
    // rather than adding a request to an Entra already refusing them. A backoff armed by a
    // repeat token has no error to report, so it falls through and asks again.
    if (now() < retryNotBefore) {
      if (isUsable(current)) return serve(current);
      if (lastFailure !== undefined) throw lastFailure;
    }

    try {
      return await serve(await acquire(current));
    } catch (error) {
      retryNotBefore = now() + RENEW_RETRY_BACKOFF_MS;
      lastFailure = error instanceof Error ? error : new Error(String(error));
      // Before expiry the previous token is still accepted, so a transient failure to renew
      // must not fail the connection — it is retried by a later one. The app only goes down if
      // acquisition is still failing once the old token has genuinely expired, which is the
      // point at which there is nothing honest left to return.
      if (isUsable(current)) {
        await raise(() => onRenewalFailure(error));
        return serve(current);
      }
      throw lastFailure;
    }
  };
}
