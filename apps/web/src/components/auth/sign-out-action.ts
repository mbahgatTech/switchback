'use server';

import { signOut } from '@/auth';

/**
 * Leaving. A server action rather than a route handler, so the nav can be a plain `<form>`:
 * Next signs the action id and checks `Origin` against `Host`, which is the CSRF protection
 * this needs. `signOut` throws a redirect — that is how server actions navigate, so it must
 * not be caught.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/' });
}
