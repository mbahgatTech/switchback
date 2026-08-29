import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { forgetAnswersOnIdentityChange } from '../src/api/identity';

/**
 * The cache does not know who asked. React Query keys an entry by procedure and input, so an
 * answer given to one reader is handed to the next one unless something empties it — which on a
 * phone means signing in and being shown the account you just signed out of, for a full stale
 * window or until the app is restarted.
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

function populated(): QueryClient {
  const client = new QueryClient();
  client.setQueryData([['me', 'get'], { type: 'query' }], { id: 'the-previous-reader' });
  return client;
}

describe('a change of signed-in identity', () => {
  it('leaves nothing behind when somebody signs in', () => {
    const client = populated();
    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);

    bus.announce(true);

    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  it('leaves nothing behind when somebody signs out', () => {
    const client = populated();
    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);

    bus.announce(false);

    expect(client.getQueryCache().getAll()).toEqual([]);
  });

  it('stops mattering once the subscription is dropped', () => {
    const client = populated();
    const bus = announcer();

    forgetAnswersOnIdentityChange(client, bus.subscribe)();
    bus.announce(true);

    expect(client.getQueryCache().getAll()).toHaveLength(1);
  });
});
