import { createContext, use, useEffect, useMemo, useState } from 'react';
import { UNRESOLVED_SESSION, nextSession, type Session, type Status } from './session-state';
import { hasStoredSession, signOut as signOutSession, subscribe } from './session';

/**
 * Auth state for the UI.
 *
 * A thin observer over `session.ts`, which owns the tokens. The split matters: the tRPC
 * link asks for a token from outside React entirely, and if that lived in a hook the link
 * would close over a stale value. So the module is the source of truth and this only
 * mirrors it for rendering.
 */

interface AuthValue extends Session {
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session>(UNRESOLVED_SESSION);

  useEffect(() => {
    let active = true;
    // Both sources answer the same question, so both settle the session the same way — including
    // the moment it began, which `@/record/bridge` measures a cached user id against.
    const settle = (signedIn: boolean): void => {
      if (active) setSession((current) => nextSession(current, signedIn, Date.now()));
    };

    // Reading the Keychain is async, so there is a real moment at launch where the answer
    // is unknown. Rendering "signed out" during it would flash the sign-in screen at
    // someone who is already signed in — hence a third state rather than a boolean.
    void hasStoredSession().then(settle);

    const unsubscribe = subscribe(settle);

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const value = useMemo<AuthValue>(() => ({ ...session, signOut: signOutSession }), [session]);

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const value = use(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}

export type { Status };
