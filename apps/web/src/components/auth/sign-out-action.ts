'use server';

import { signOut } from '@/auth';

/**
 * Leaving.
 *
 * `apps/web` exported `signOut` from `auth.ts` and never called it. The settings page told
 * readers "This browser is signed out from the button in the header"; there was no button in
 * the header, and no way to end a browser session short of clearing site data. On a shared
 * computer that is the whole of the problem: the next person to open the laptop is signed in
 * as the last one, and every hike they record posts to somebody else's account.
 *
 * A server action rather than a route handler, so the nav can be a plain `<form>`: Next signs
 * the action id and checks `Origin` against `Host` on every invocation, which is the CSRF
 * protection this needs and would otherwise have to be written by hand.
 *
 * `redirectTo: '/'` because the map is the front page and works signed out — landing a reader
 * who has just left on a page that asks them to come back reads as a refusal to let them.
 * `signOut` throws a redirect, which is how Next server actions navigate; it must not be
 * caught.
 */
export async function signOutAction(): Promise<void> {
  await signOut({ redirectTo: '/' });
}
