import { describe, expect, it, vi } from 'vitest';
import {
  CONNECT_BUDGET_MS,
  RENEW_MARGIN_MS,
  RENEW_RETRY_BACKOFF_MS,
  createTokenProvider,
} from '../src/entra-token';
import type { AccessToken } from '../src/entra-token';

/** A clock the test moves by hand, so the renewal boundary is crossed without waiting for it. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function tokenExpiringIn(clock: { now: () => number }, ms: number, label = 'tok'): AccessToken {
  return { token: `${label}-${clock.now()}`, expiresOnTimestamp: clock.now() + ms };
}

/**
 * MSAL's five-minute renewal offset, `DEFAULT_TOKEN_RENEWAL_OFFSET_SEC` in
 * `@azure/msal-common`. Inside it a cached token counts as expired and a real mint happens;
 * outside it, no request this module makes can produce a fresher token than the one held.
 */
const MSAL_EXPIRY_OFFSET_MS = 5 * MINUTE;

/**
 * A source with the real credential's cache semantics — the one shape a per-call minting fake
 * cannot have. Past `refreshOn` it starts a network refresh and *returns the token it already
 * holds*, so a provider that treats every answer as fresh sees its renewal do nothing.
 */
function msalShapedSource(
  clock: { now: () => number },
  options: { lifetimeMs: number; refreshInMs?: number },
) {
  let held: AccessToken | undefined;
  let refreshPending = false;
  let mints = 0;

  const mint = (): AccessToken => {
    mints += 1;
    return {
      token: `tok-${mints}`,
      expiresOnTimestamp: clock.now() + options.lifetimeMs,
      ...(options.refreshInMs === undefined
        ? {}
        : { refreshAfterTimestamp: clock.now() + options.refreshInMs }),
    };
  };

  const source = async (): Promise<AccessToken> => {
    if (held === undefined || clock.now() >= held.expiresOnTimestamp - MSAL_EXPIRY_OFFSET_MS) {
      refreshPending = false;
      held = mint();
    } else if (refreshPending) {
      refreshPending = false;
      held = mint();
    } else if (
      held.refreshAfterTimestamp !== undefined &&
      clock.now() >= held.refreshAfterTimestamp
    ) {
      refreshPending = true;
    }
    return held;
  };

  return { source, mints: () => mints };
}

/**
 * Runs a provider once a minute and reports the least life left on any token it served.
 *
 * The quantity that matters is what the *connection* gets, so it is sampled from what the
 * provider hands back rather than computed from the constants it hands it back by.
 */
async function driveMinutely(
  clock: { now: () => number; advance: (ms: number) => number },
  provider: () => Promise<string>,
  expiryOf: Map<string, number>,
  minutes: number,
): Promise<number> {
  let worstRemainingMs = Infinity;
  for (let minute = 0; minute < minutes; minute += 1) {
    const served = await provider();
    const expiry = expiryOf.get(served);
    if (expiry === undefined) throw new Error(`served an unrecorded token: ${served}`);
    worstRemainingMs = Math.min(worstRemainingMs, expiry - clock.now());
    clock.advance(MINUTE);
  }
  return worstRemainingMs;
}

/** Wraps a source so every token it issues is recorded, and hands back the ledger. */
function recording(source: () => Promise<AccessToken>) {
  const expiryOf = new Map<string, number>();
  return {
    expiryOf,
    source: async (): Promise<AccessToken> => {
      const token = await source();
      expiryOf.set(token.token, token.expiresOnTimestamp);
      return token;
    },
  };
}

describe('createTokenProvider', () => {
  it('acquires once and reuses while the token is fresh', async () => {
    const clock = fakeClock();
    const source = vi.fn(async () => tokenExpiringIn(clock, HOUR));
    const token = createTokenProvider(source, { now: clock.now });

    const first = await token();
    clock.advance(10 * MINUTE);
    const second = await token();

    expect(second).toBe(first);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('renews before expiry, not after it', async () => {
    const clock = fakeClock();
    const source = vi.fn(async () => tokenExpiringIn(clock, HOUR));
    const token = createTokenProvider(source, { now: clock.now });

    const first = await token();

    // One minute short of the margin the token is still served from cache...
    clock.advance(HOUR - RENEW_MARGIN_MS - MINUTE);
    expect(await token()).toBe(first);
    expect(source).toHaveBeenCalledTimes(1);

    // ...and one minute inside it, a new one is fetched, while the old is still valid.
    clock.advance(2 * MINUTE);
    const renewed = await token();
    expect(renewed).not.toBe(first);
    expect(source).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent acquisitions into one request', async () => {
    const clock = fakeClock();
    let resolve!: (t: AccessToken) => void;
    const source = vi.fn(() => new Promise<AccessToken>((r) => (resolve = r)));
    const token = createTokenProvider(source, { now: clock.now });

    const waiting = [token(), token(), token(), token()];
    resolve(tokenExpiringIn(clock, HOUR));

    expect(new Set(await Promise.all(waiting)).size).toBe(1);
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('serves the old token when renewal fails but it has not expired yet', async () => {
    const clock = fakeClock();
    const source = vi
      .fn<() => Promise<AccessToken>>()
      .mockResolvedValueOnce(tokenExpiringIn(clock, HOUR))
      .mockRejectedValue(new Error('Entra unreachable'));
    const onRenewalFailure = vi.fn();
    const token = createTokenProvider(source, { now: clock.now, onRenewalFailure });

    const first = await token();
    clock.advance(HOUR - MINUTE); // inside the margin, outside expiry

    await expect(token()).resolves.toBe(first);
    expect(onRenewalFailure).toHaveBeenCalledTimes(1);
  });

  it('fails once the cached token has actually expired', async () => {
    const clock = fakeClock();
    const source = vi
      .fn<() => Promise<AccessToken>>()
      .mockResolvedValueOnce(tokenExpiringIn(clock, HOUR))
      .mockRejectedValue(new Error('Entra unreachable'));
    const token = createTokenProvider(source, { now: clock.now });

    await token();
    clock.advance(HOUR + 1_000);

    await expect(token()).rejects.toThrow('Entra unreachable');
  });

  it('recovers once the backoff has elapsed after a renewal failure', async () => {
    const clock = fakeClock();
    const source = vi
      .fn<() => Promise<AccessToken>>()
      .mockResolvedValueOnce(tokenExpiringIn(clock, HOUR, 'first'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockImplementation(async () => tokenExpiringIn(clock, HOUR, 'third'));
    const token = createTokenProvider(source, { now: clock.now, onRenewalFailure: () => {} });

    const first = await token();
    clock.advance(HOUR - MINUTE);
    expect(await token()).toBe(first); // the blip is absorbed
    clock.advance(RENEW_RETRY_BACKOFF_MS + 1);
    expect(await token()).not.toBe(first); // the retry succeeds
  });
});

/**
 * The behaviour a per-call minting fake cannot exercise, and the reason the margin is what it
 * is. Every case here drives the provider against a source that answers from a cache.
 */
describe('against a source that answers from MSAL’s cache', () => {
  it('never serves a token too short-lived to survive a connection attempt', async () => {
    const clock = fakeClock();
    const msal = msalShapedSource(clock, { lifetimeMs: HOUR, refreshInMs: 30 * MINUTE });
    const ledger = recording(msal.source);
    const onTokenNearlyExpired = vi.fn();
    const token = createTokenProvider(ledger.source, { now: clock.now, onTokenNearlyExpired });

    const worst = await driveMinutely(clock, token, ledger.expiryOf, 6 * 60);

    expect(onTokenNearlyExpired).not.toHaveBeenCalled();
    expect(worst).toBeGreaterThanOrEqual(CONNECT_BUDGET_MS);
  });

  it('holds when the issuer sends no refresh hint and the margin is all there is', async () => {
    const clock = fakeClock();
    const msal = msalShapedSource(clock, { lifetimeMs: HOUR });
    const ledger = recording(msal.source);
    const onTokenNearlyExpired = vi.fn();
    const token = createTokenProvider(ledger.source, { now: clock.now, onTokenNearlyExpired });

    const worst = await driveMinutely(clock, token, ledger.expiryOf, 6 * 60);

    expect(onTokenNearlyExpired).not.toHaveBeenCalled();
    expect(worst).toBeGreaterThanOrEqual(CONNECT_BUDGET_MS);
  });

  it('renews on the refresh hint rather than waiting for the margin', async () => {
    const clock = fakeClock();
    const msal = msalShapedSource(clock, { lifetimeMs: HOUR, refreshInMs: 30 * MINUTE });
    const token = createTokenProvider(msal.source, { now: clock.now });

    const first = await token();
    clock.advance(29 * MINUTE);
    expect(await token()).toBe(first);
    expect(msal.mints()).toBe(1);

    // Past the hint: one ask returns the held token while the refresh runs, the next gets the
    // new one — 25 minutes before the margin would have asked for anything.
    clock.advance(2 * MINUTE);
    expect(await token()).toBe(first);
    clock.advance(RENEW_RETRY_BACKOFF_MS + 1);
    expect(await token()).not.toBe(first);
    expect(msal.mints()).toBe(2);
  });

  it('does not re-ask on every connection while an upstream refresh is pending', async () => {
    const clock = fakeClock();
    const held: AccessToken = {
      token: 'held',
      expiresOnTimestamp: 1_700_000_000_000 + HOUR,
      refreshAfterTimestamp: 1_700_000_000_000 + 30 * MINUTE,
    };
    const source = vi.fn(async () => held);
    const onTokenNearlyExpired = vi.fn();
    const token = createTokenProvider(source, { now: clock.now, onTokenNearlyExpired });

    await token();
    clock.advance(31 * MINUTE);
    expect(await token()).toBe('held');
    expect(source).toHaveBeenCalledTimes(2);

    // Fifty connections inside the backoff must not become fifty token requests, and a token
    // the issuer simply has not replaced yet is not an alarm.
    for (let i = 0; i < 50; i += 1) await token();
    expect(source).toHaveBeenCalledTimes(2);
    expect(onTokenNearlyExpired).not.toHaveBeenCalled();

    clock.advance(RENEW_RETRY_BACKOFF_MS + 1);
    await token();
    expect(source).toHaveBeenCalledTimes(3);
  });

  it('renews a 24-hour managed-identity token at its hint, not minutes before expiry', async () => {
    const clock = fakeClock();
    const msal = msalShapedSource(clock, { lifetimeMs: 24 * HOUR, refreshInMs: 12 * HOUR });
    const ledger = recording(msal.source);
    const onTokenNearlyExpired = vi.fn();
    const token = createTokenProvider(ledger.source, { now: clock.now, onTokenNearlyExpired });

    const worst = await driveMinutely(clock, token, ledger.expiryOf, 20 * 60);

    expect(onTokenNearlyExpired).not.toHaveBeenCalled();
    // Two mints in twenty hours: the first, and the one the twelve-hour hint asked for. A
    // margin measured against expiry would not have asked for anything until hour 23.9, so it
    // would still be holding the first token here.
    expect(msal.mints()).toBe(2);
    expect(worst).toBeGreaterThan(11 * HOUR);
  });
});

describe('degraded sources', () => {
  it('says so when a token is served with less life than a connection attempt takes', async () => {
    const clock = fakeClock();
    const source = vi
      .fn<() => Promise<AccessToken>>()
      .mockResolvedValueOnce(tokenExpiringIn(clock, HOUR))
      .mockRejectedValue(new Error('Entra unreachable'));
    const onTokenNearlyExpired = vi.fn();
    const token = createTokenProvider(source, {
      now: clock.now,
      onRenewalFailure: () => {},
      onTokenNearlyExpired,
    });

    await token();
    clock.advance(HOUR - 45_000); // 45s of life left: more than a connect attempt needs
    await token();
    expect(onTokenNearlyExpired).not.toHaveBeenCalled();

    clock.advance(RENEW_RETRY_BACKOFF_MS + 25_000); // 10s of life left
    await token();
    expect(onTokenNearlyExpired).toHaveBeenCalledTimes(1);
    expect(onTokenNearlyExpired.mock.calls[0]![0]).toBeLessThan(CONNECT_BUDGET_MS);
  });

  it('does not re-ask a failing source on every connection', async () => {
    const clock = fakeClock();
    const source = vi
      .fn<() => Promise<AccessToken>>()
      .mockResolvedValueOnce(tokenExpiringIn(clock, HOUR))
      .mockRejectedValue(new Error('Entra unreachable'));
    const token = createTokenProvider(source, { now: clock.now, onRenewalFailure: () => {} });

    await token();
    clock.advance(HOUR - RENEW_MARGIN_MS + 1_000); // inside the margin, far from expiry
    await token();
    expect(source).toHaveBeenCalledTimes(2);

    // Ten more connections inside the backoff must not become ten more token requests.
    for (let i = 0; i < 10; i += 1) await token();
    expect(source).toHaveBeenCalledTimes(2);

    clock.advance(RENEW_RETRY_BACKOFF_MS + 1);
    await token();
    expect(source).toHaveBeenCalledTimes(3);
  });

  it('stops asking Entra once the cached token is dead and Entra is still failing', async () => {
    const clock = fakeClock();
    const source = vi
      .fn<() => Promise<AccessToken>>()
      .mockResolvedValueOnce(tokenExpiringIn(clock, HOUR))
      .mockRejectedValue(new Error('Entra unreachable'));
    const token = createTokenProvider(source, { now: clock.now, onRenewalFailure: () => {} });

    await token();
    clock.advance(HOUR + 1_000); // the cached token is now genuinely expired
    await expect(token()).rejects.toThrow('Entra unreachable');
    expect(source).toHaveBeenCalledTimes(2);

    // The outage the backoff exists for. Ten more connections must not be ten more requests.
    for (let i = 0; i < 10; i += 1) await expect(token()).rejects.toThrow('Entra unreachable');
    expect(source).toHaveBeenCalledTimes(2);

    clock.advance(RENEW_RETRY_BACKOFF_MS + 1);
    await expect(token()).rejects.toThrow('Entra unreachable');
    expect(source).toHaveBeenCalledTimes(3);
  });

  it('warns by default rather than degrading silently', async () => {
    const clock = fakeClock();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const source = vi
      .fn<() => Promise<AccessToken>>()
      .mockResolvedValueOnce(tokenExpiringIn(clock, HOUR))
      .mockRejectedValue(new Error('Entra unreachable'));
    const token = createTokenProvider(source, { now: clock.now });

    await token();
    clock.advance(HOUR - MINUTE);
    await token();

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
