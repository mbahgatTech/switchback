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

/**
 * Renew this long before the token actually expires.
 *
 * Five minutes because that is Entra's own tolerated clock skew: a token minted here can be
 * judged up to five minutes older by the server validating it, so treating the last five
 * minutes of a token's life as already gone removes skew from the problem entirely. It also
 * leaves room for a failed renewal to be retried on the next connection while the current
 * token is still accepted.
 */
export const RENEW_MARGIN_MS = 5 * 60_000;

/**
 * Retire a pooled connection after this long, so none outlives the token that opened it.
 *
 * A token is checked when the connection is opened. Whether Azure also terminates a session
 * whose token has since expired is not established (see docs/architecture.md), and this
 * number is what makes that question stop mattering: thirty minutes is inside the shortest
 * lifetime any of these principals is issued — one hour, for a user — so a connection is
 * replaced, with a freshly minted token, long before expiry can be reached either way.
 */
export const CONNECTION_LIFETIME_S = 30 * 60;

export interface TokenProviderOptions {
  renewMarginMs?: number;
  /** Injected so the renewal boundary can be tested without waiting an hour for it. */
  now?: () => number;
  /** Called when a renewal fails while a usable token is still cached. */
  onRenewalFailure?: (error: unknown) => void;
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

  let cached: AccessToken | undefined;
  let inFlight: Promise<AccessToken> | undefined;

  // `isUsable` is a type predicate; freshness deliberately is not. A predicate's false branch
  // narrows away `AccessToken`, and "not fresh" means the token is old, not absent — modelling
  // it as a predicate makes the still-valid token unreachable in the catch below.
  const isUsable = (t: AccessToken | undefined): t is AccessToken =>
    t !== undefined && now() < t.expiresOnTimestamp;
  const isFresh = (t: AccessToken | undefined): boolean =>
    t !== undefined && now() < t.expiresOnTimestamp - renewMarginMs;

  // One refresh at a time. A pool opening its connections together would otherwise mint a
  // token per connection at exactly the moment the old one aged out, which is both wasteful
  // and the shape that trips Entra's per-principal request throttling.
  function refresh(): Promise<AccessToken> {
    inFlight ??= source()
      .then((token) => {
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

    try {
      return (await refresh()).token;
    } catch (error) {
      // Inside the renewal margin the previous token is still accepted, so a transient
      // failure to renew must not fail the connection — it is retried by the next one. The
      // app only goes down if renewal is still failing once the old token has genuinely
      // expired, which is the point at which there is nothing honest left to return.
      if (isUsable(current)) {
        options.onRenewalFailure?.(error);
        return current.token;
      }
      throw error;
    }
  };
}
