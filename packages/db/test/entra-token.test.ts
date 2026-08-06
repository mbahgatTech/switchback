import { describe, expect, it, vi } from 'vitest';
import {
  CLOCK_SKEW_MS,
  CONNECTION_LIFETIME_S,
  MAX_CHECKOUT_S,
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

const HOUR = 60 * 60_000;

function tokenExpiringIn(clock: { now: () => number }, ms: number, label = 'tok'): AccessToken {
  return { token: `${label}-${clock.now()}`, expiresOnTimestamp: clock.now() + ms };
}

describe('createTokenProvider', () => {
  it('acquires once and reuses while the token is fresh', async () => {
    const clock = fakeClock();
    const source = vi.fn(async () => tokenExpiringIn(clock, HOUR));
    const token = createTokenProvider(source, { now: clock.now });

    const first = await token();
    clock.advance(10 * 60_000);
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
    clock.advance(HOUR - RENEW_MARGIN_MS - 60_000);
    expect(await token()).toBe(first);
    expect(source).toHaveBeenCalledTimes(1);

    // ...and one minute inside it, a new one is fetched, while the old is still valid.
    clock.advance(2 * 60_000);
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
    clock.advance(HOUR - 60_000); // inside the margin, outside expiry

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
    clock.advance(HOUR - 60_000);
    expect(await token()).toBe(first); // the blip is absorbed
    clock.advance(RENEW_RETRY_BACKOFF_MS + 1);
    expect(await token()).not.toBe(first); // the retry succeeds
  });
});

describe('connection lifetime', () => {
  /**
   * The invariant the whole module exists for. Behavioural on purpose: it samples the life
   * left on every token actually handed out across a day of connections, rather than
   * comparing two constants — the assertion it replaced compared connection lifetime against
   * *full* token lifetime and so passed while permitting 25 minutes of use past expiry.
   */
  it('never hands out a token with less life left than a connection can consume', async () => {
    const clock = fakeClock();
    const minted = new Map<string, number>();
    let n = 0;
    const source = async () => {
      const t = { token: `tok-${++n}`, expiresOnTimestamp: clock.now() + HOUR };
      minted.set(t.token, t.expiresOnTimestamp);
      return t;
    };
    const token = createTokenProvider(source, { now: clock.now });

    let worstRemainingMs = Infinity;
    for (let minute = 0; minute < 24 * 60; minute++) {
      const handed = await token();
      worstRemainingMs = Math.min(worstRemainingMs, minted.get(handed)! - clock.now());
      clock.advance(60_000);
    }

    expect(worstRemainingMs).toBeGreaterThanOrEqual(
      (CONNECTION_LIFETIME_S + MAX_CHECKOUT_S) * 1000,
    );
  });

  it('derives the margin from the two bounds it has to cover', () => {
    expect(RENEW_MARGIN_MS).toBe((CONNECTION_LIFETIME_S + MAX_CHECKOUT_S) * 1000 + CLOCK_SKEW_MS);
  });
});

describe('degraded sources', () => {
  it('says so, and halves its margin, when a token is shorter-lived than the margin', async () => {
    const clock = fakeClock();
    const lifetimeMs = 10 * 60_000; // what an Entra token-lifetime policy can impose
    const source = vi.fn(async () => tokenExpiringIn(clock, lifetimeMs));
    const onTokenTooShort = vi.fn();
    const token = createTokenProvider(source, { now: clock.now, onTokenTooShort });

    const first = await token();
    expect(onTokenTooShort).toHaveBeenCalledWith(lifetimeMs, RENEW_MARGIN_MS);

    // Still cached for the first half of its life rather than re-acquired per connection.
    clock.advance(4 * 60_000);
    expect(await token()).toBe(first);
    expect(source).toHaveBeenCalledTimes(1);

    clock.advance(2 * 60_000);
    expect(await token()).not.toBe(first);
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
    for (let i = 0; i < 10; i++) await token();
    expect(source).toHaveBeenCalledTimes(2);

    clock.advance(RENEW_RETRY_BACKOFF_MS + 1);
    await token();
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
    clock.advance(HOUR - 60_000);
    await token();

    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
