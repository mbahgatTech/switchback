import { cache } from 'react';
import { cookies } from 'next/headers';
import { THEME_PREFERENCES, type ThemePreference } from '@switchback/core';
import type { Mode } from '@switchback/ui';
import { caller } from '@/trpc/server';

/**
 * Which palette this reader gets, resolved on the server before the first byte.
 *
 * The whole point of doing this server-side is the flash. A theme read from `localStorage`
 * cannot be known until JavaScript runs, which is after the first paint — so every
 * client-only dark mode either shows the wrong colours for a frame or blocks rendering on
 * an inline script to avoid it. Here the answer is already in the HTML: `<html>` carries
 * `data-mode`, and the stylesheet in `packages/ui` does the rest with no script at all.
 *
 * `system` is the absence of an answer rather than a third palette, and it is deliberately
 * *not* resolved here — `theme.css` has `prefers-color-scheme` blocks that resolve it in
 * CSS. So a reader who has never chosen follows their device, including when they change it
 * at dusk with the tab still open, which a server-resolved boolean could not do.
 */

/**
 * A year, because this is the least consequential thing a person can tell us and asking
 * again in a month is worse than remembering it. Not `Secure`, so it survives local http.
 */
export const THEME_COOKIE = 'sb-theme';
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** A cookie is attacker-controlled text. Anything not in the enum is treated as unset. */
export function parseTheme(value: string | undefined): ThemePreference | null {
  return value !== undefined && (THEME_PREFERENCES as readonly string[]).includes(value)
    ? (value as ThemePreference)
    : null;
}

/**
 * Account first, then this browser.
 *
 * An explicit account choice wins because it is the one that follows you to a second
 * device, which is what "remembered by account" has to mean. It has to be *explicit*
 * though: every account starts on `system`, so treating the default as an answer would let
 * a fresh sign-in silently overrule a preference the reader had already set in this
 * browser. Falling through to the cookie in that case is why signing in does not change the
 * colours out from under somebody.
 */
export const currentTheme = cache(async (): Promise<ThemePreference> => {
  const viewer = await caller.me.get();
  if (viewer && viewer.theme !== 'system') return viewer.theme;
  const jar = await cookies();
  return parseTheme(jar.get(THEME_COOKIE)?.value) ?? 'system';
});

/**
 * The `data-mode` attribute value, or `undefined` to leave the attribute off entirely.
 *
 * Writing `data-mode="system"` would be worse than writing nothing: the stylesheet's
 * fallbacks are keyed on `html:not([data-mode])`, so an attribute that says "no preference"
 * would switch them off and strand the reader on whichever palette happened to be declared.
 */
export function modeAttribute(theme: ThemePreference): Mode | undefined {
  return theme === 'system' ? undefined : theme;
}
