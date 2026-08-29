/**
 * When this device became signed in, tracked alongside the status it belongs to.
 *
 * Pure and separate from the provider because it is a rule, not rendering: anything keyed to the
 * person at the phone has to be able to refuse an answer fetched under the previous one, and a
 * rule that only exists inside a component is a rule nothing can test.
 */

export type Status = 'loading' | 'signedIn' | 'signedOut';

export interface Session {
  status: Status;
  /** Epoch milliseconds of the sign-in in force, or `null` while nobody is signed in. */
  signedInAt: number | null;
}

export const UNRESOLVED_SESSION: Session = { status: 'loading', signedInAt: null };

/**
 * The session after `session.ts` reports a sign-in state. The moment is stamped once per sign-in:
 * a token refresh re-announces the same session, and moving the stamp forward for it would start
 * refusing a `me.get` answer that is genuinely current.
 */
export function nextSession(current: Session, signedIn: boolean, now: number): Session {
  if (!signedIn) return { status: 'signedOut', signedInAt: null };
  if (current.status === 'signedIn') return current;
  return { status: 'signedIn', signedInAt: now };
}
