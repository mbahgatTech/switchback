import type { Listener } from '../src/auth/session';

/**
 * A stand-in for `session.ts`'s subscription, so the identity tests run with no Keychain and no
 * network. Shared rather than retyped in each file — the duplicate copy this replaced appeared
 * in the same change that created `test/sources.ts` to end a duplicated walker.
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
