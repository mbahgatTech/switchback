'use server';

import { cookies } from 'next/headers';
import type { ThemePreference } from '@switchback/core';
import { THEME_COOKIE, THEME_COOKIE_MAX_AGE, parseTheme } from './theme';

/**
 * Remember the reader's choice in this browser.
 *
 * Separate from the account write, and both happen on every change. The account is what
 * carries the choice to a second device; the cookie is what carries it through signing out,
 * and is the only record a reader who has never signed in has at all. Writing one without
 * the other is how a setting appears to forget itself at exactly the moment somebody is
 * paying attention to it.
 *
 * Every export of a `'use server'` module is a public endpoint that anyone can call with
 * anything, so the argument is re-parsed here rather than trusted from the type.
 */
export async function rememberTheme(theme: ThemePreference): Promise<void> {
  const value = parseTheme(theme);
  if (value === null) return;

  const jar = await cookies();
  jar.set(THEME_COOKIE, value, {
    maxAge: THEME_COOKIE_MAX_AGE,
    path: '/',
    sameSite: 'lax',
    // Readable by script on purpose — nothing here is a secret, and a future client-side
    // reader (the service worker's offline shell) needs the same answer the server had.
    httpOnly: false,
  });
}
