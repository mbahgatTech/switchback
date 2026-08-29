import { describe, expect, it, vi } from 'vitest';
import { QueryCache, QueryClient, QueryObserver } from '@tanstack/react-query';
import { cacheGeneration, forgetAnswersOnIdentityChange } from '../src/api/identity';

/**
 * The cache does not know who asked. React Query keys an entry by procedure and input, so an
 * answer given to one reader is handed to the next one unless something empties it — which on a
 * phone means signing in and being shown the account you just signed out of, for a full stale
 * window or until the app is restarted.
 *
 * **Emptying is not enough, and asserting on `getQueryCache().getAll()` alone would not catch
 * that.** `clear()` empties without notifying, so a mounted `useQuery` goes on serving the old
 * value off its observer and never refetches. Every case below therefore asks what a subscribed
 * observer serves, which is what a screen actually draws.
 */

/** A stand-in for `session.ts`'s subscription, so this runs with no Keychain and no network. */
function announcer() {
  const listeners = new Set<(signedIn: boolean) => void>();
  return {
    subscribe: (listener: (signedIn: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    announce: (signedIn: boolean) => {
      for (const listener of listeners) listener(signedIn);
    },
  };
}

const PROFILE = [['me', 'get'], { type: 'query' }];

/** A client holding one reader's profile, with a mounted observer serving it — as a screen has. */
function withAliceOnScreen() {
  const client = new QueryClient({
    queryCache: new QueryCache(),
    // What a screen's `useQuery` does next. The point of a reset is that this happens at all.
    defaultOptions: { queries: { queryFn: () => Promise.resolve('BOB-profile'), retry: false } },
  });
  client.setQueryData(PROFILE, 'ALICE-profile');

  const observer = new QueryObserver(client, { queryKey: PROFILE });
  const unsubscribe = observer.subscribe(() => undefined);
  return { client, observer, unsubscribe };
}

describe('a change of signed-in identity', () => {
  it('stops a mounted screen serving the reader who left', async () => {
    const { client, observer, unsubscribe } = withAliceOnScreen();
    expect(observer.getCurrentResult().data).toBe('ALICE-profile');

    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    bus.announce(true);
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe('BOB-profile');
    });

    unsubscribe();
  });

  it('does the same on the way out, which is the shared-phone case', async () => {
    const { client, observer, unsubscribe } = withAliceOnScreen();

    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    bus.announce(false);
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).not.toBe('ALICE-profile');
    });

    unsubscribe();
  });

  it('wakes whatever seeds the cache by hand, because a reset leaves it nothing to refetch', () => {
    const { client, unsubscribe } = withAliceOnScreen();
    const before = cacheGeneration();

    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    bus.announce(true);

    expect(cacheGeneration()).toBeGreaterThan(before);
    unsubscribe();
  });

  it('ignores a repeat, so a 401 and then a Sign out costs one reset and not two', () => {
    const { client, unsubscribe } = withAliceOnScreen();

    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    bus.announce(false);
    const afterFirst = cacheGeneration();
    bus.announce(false);

    expect(cacheGeneration()).toBe(afterFirst);
    unsubscribe();
  });

  it('stops mattering once the subscription is dropped', () => {
    const { client, observer, unsubscribe } = withAliceOnScreen();
    const bus = announcer();

    forgetAnswersOnIdentityChange(client, bus.subscribe)();
    bus.announce(true);

    expect(observer.getCurrentResult().data).toBe('ALICE-profile');
    unsubscribe();
  });
});
