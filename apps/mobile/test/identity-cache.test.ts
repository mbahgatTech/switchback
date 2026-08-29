import { describe, expect, it, vi } from 'vitest';
import { QueryCache, QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  cacheGeneration,
  forgetAnswersOnIdentityChange,
  watchGeneration,
} from '../src/api/identity';
import { announcer } from './announcer';

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

describe('a second sign-in without a sign-out in between', () => {
  /*
   * Reachable, and the reason the dedupe is one-directional. `app/signin.tsx`'s cold-start
   * effect gates `resumeSignIn` on a ref rather than on `status`, so an exchange can complete
   * while a session is already live: `adopt` installs Bob's token and announces `true` with the
   * last announcement also `true`. A dedupe on the boolean swallows it, and Bob is served
   * Alice's record — the harm this whole module exists to prevent.
   *
   * `staleTime: Infinity` so nothing here can be explained away as an ordinary mount refetch.
   */
  it('is not mistaken for a repeat, because it is a different reader', async () => {
    const client = new QueryClient({
      queryCache: new QueryCache(),
      defaultOptions: {
        queries: {
          queryFn: () => Promise.resolve('BOB-profile'),
          staleTime: Infinity,
          retry: false,
        },
      },
    });
    client.setQueryData(PROFILE, 'ALICE-profile');
    const observer = new QueryObserver(client, { queryKey: PROFILE });
    const unsubscribe = observer.subscribe(() => undefined);

    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    bus.announce(true); // Alice's session is already live
    const afterAlice = cacheGeneration();
    client.setQueryData(PROFILE, 'ALICE-profile');

    bus.announce(true); // Bob completes an exchange on the same live session

    expect(cacheGeneration(), 'a second sign-in must reset').toBeGreaterThan(afterAlice);
    await vi.waitFor(() => {
      expect(observer.getCurrentResult().data).toBe('BOB-profile');
    });

    unsubscribe();
  });
});

describe('the generation seam the re-seed hangs off', () => {
  /*
   * `useCacheGeneration` is `useSyncExternalStore(watchGeneration, ...)`, and the hook itself
   * needs a renderer this workspace does not have. Subscribing through the exported seam runs
   * the same notification path: delete the notify loop in `identity.ts` and this fails, which
   * is what a counter that can only be read could never tell us.
   */
  it('tells its watchers, and does not merely count', () => {
    const client = new QueryClient({ queryCache: new QueryCache() });
    const seen: number[] = [];
    const stopWatching = watchGeneration(() => seen.push(cacheGeneration()));

    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    bus.announce(true);

    expect(seen, 'nothing was told the cache had been emptied').not.toEqual([]);
    stopWatching();
  });

  it('stops telling a watcher that has unsubscribed', () => {
    const client = new QueryClient({ queryCache: new QueryCache() });
    let calls = 0;
    watchGeneration(() => (calls += 1))();

    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    bus.announce(true);

    expect(calls).toBe(0);
  });
});
