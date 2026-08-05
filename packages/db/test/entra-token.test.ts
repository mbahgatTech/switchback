import { describe, expect, it, vi } from 'vitest';
import { CONNECTION_LIFETIME_S, RENEW_MARGIN_MS, createTokenProvider } from '../src/entra-token';
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

  it('recovers on the next call after a renewal failure', async () => {
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
    expect(await token()).not.toBe(first); // the retry succeeds
  });
});

describe('connection lifetime', () => {
  // The guarantee that makes "does Azure kill a session at expiry?" stop mattering: a
  // connection is retired well before the shortest token any of these principals is issued.
  it('retires a connection inside the shortest token lifetime, with the margin to spare', () => {
    const shortestTokenLifetimeMs = HOUR; // a user principal; managed identities get 24h
    expect(CONNECTION_LIFETIME_S * 1000).toBeLessThan(shortestTokenLifetimeMs - RENEW_MARGIN_MS);
  });
});
