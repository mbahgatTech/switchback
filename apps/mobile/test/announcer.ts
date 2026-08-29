import type { Listener } from '../src/auth/session';

/**
 * A stand-in for `session.ts`'s subscription, so the identity tests run with no Keychain and no
 * network. One copy, imported by `identity-cache.test.ts` and `offline-seed.test.ts` — the same
 * reason `test/sources.ts` exists, and it is only true of either file while nobody retypes it.
 */
export function announcer() {
  const listeners = new Set<Listener>();
  return {
    subscribe: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    announce: (signedIn: boolean) => {
      for (const listener of listeners) listener(signedIn);
    },
  };
}
