import { createContext, use, useEffect, useState } from 'react';
import { hasStoredSession, signOut as signOutSession, subscribe } from './session';

/**
 * Auth state for the UI.
 *
 * A thin observer over `session.ts`, which owns the tokens. The split matters: the tRPC
 * link asks for a token from outside React entirely, and if that lived in a hook the link
 * would close over a stale value. So the module is the source of truth and this only
 * mirrors it for rendering.
 */
type Status = 'loading' | 'signedIn' | 'signedOut';

interface AuthValue {
  status: Status;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');

  useEffect(() => {
    let active = true;

    // Reading the Keychain is async, so there is a real moment at launch where the answer
    // is unknown. Rendering "signed out" during it would flash the sign-in screen at
    // someone who is already signed in — hence a third state rather than a boolean.
    void hasStoredSession().then((present) => {
      if (active) setStatus(present ? 'signedIn' : 'signedOut');
    });

    const unsubscribe = subscribe((signedIn) => {
      if (active) setStatus(signedIn ? 'signedIn' : 'signedOut');
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return <AuthContext value={{ status, signOut: signOutSession }}>{children}</AuthContext>;
}

export function useAuth(): AuthValue {
  const value = use(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>');
  return value;
}
