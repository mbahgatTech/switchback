import { describe, expect, it } from 'vitest';
import { UNRESOLVED_SESSION, nextSession, type Session } from '@/auth/session-state';

/**
 * The sign-in moment, which decides whether a cached `me.get` answer may be believed. It used to
 * be a ref mutated during `RecordBridge`'s render — unsupported in React, and a discarded render's
 * mutation surviving is how a stale id gets past the check that exists to refuse it.
 */

const signedIn: Session = { status: 'signedIn', signedInAt: 1_000 };

describe('becoming signed in', () => {
  it('stamps the moment', () => {
    expect(nextSession(UNRESOLVED_SESSION, true, 1_000)).toEqual(signedIn);
  });

  it('does not move the stamp when a token refresh re-announces the same session', () => {
    // The stamp is what a `me.get` answer is measured against. Moving it forward here would start
    // refusing an id fetched moments ago, for the rest of the session.
    expect(nextSession(signedIn, true, 9_999)).toEqual(signedIn);
  });

  it('stamps again for a sign-in after a sign-out, which is a different person', () => {
    const out = nextSession(signedIn, false, 2_000);
    expect(nextSession(out, true, 3_000)).toEqual({ status: 'signedIn', signedInAt: 3_000 });
  });
});

describe('signing out', () => {
  it('clears the moment, so nothing cached under the last identity can qualify', () => {
    expect(nextSession(signedIn, false, 2_000)).toEqual({
      status: 'signedOut',
      signedInAt: null,
    });
  });

  it('reports signed out from an unresolved session too', () => {
    expect(nextSession(UNRESOLVED_SESSION, false, 2_000).status).toBe('signedOut');
  });
});
