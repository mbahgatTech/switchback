import { cache } from 'react';
import { cookies } from 'next/headers';
import { THEME_PREFERENCES, type ThemePreference } from '@switchback/core';
import type { Mode } from '@switchback/ui';
import { caller } from '@/trpc/server';

/**
 * Which palette this reader gets, resolved on the server so there is no flash: `<html>` carries
 * `data-mode` in the first byte and `packages/ui`'s stylesheet does the rest with no script.
 * `system` is deliberately *not* resolved here — `theme.css` handles it with
 * `prefers-color-scheme`, so a reader who never chose follows their device as it changes.
 */

/** A year: this is the least consequential thing a reader tells us. Not `Secure`, so local http works. */
export const THEME_COOKIE = 'sb-theme';
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** A cookie is attacker-controlled text. Anything not in the enum is treated as unset. */
export function parseTheme(value: string | undefined): ThemePreference | null {
  return value !== undefined && (THEME_PREFERENCES as readonly string[]).includes(value)
    ? (value as ThemePreference)
    : null;
}

/**
 * An explicit account choice first — it is the one that follows you to a second device — then
 * this browser's cookie. Explicit matters: every account starts on `system`, so treating the
 * default as an answer would let a fresh sign-in overrule a preference set in this browser.
 */
export const currentTheme = cache(async (): Promise<ThemePreference> => {
  const viewer = await caller.me.get();
  if (viewer && viewer.theme !== 'system') return viewer.theme;
  const jar = await cookies();
  return parseTheme(jar.get(THEME_COOKIE)?.value) ?? 'system';
});

/**
 * The `data-mode` value, or `undefined` to leave the attribute off. Writing `data-mode="system"`
 * is worse than nothing: the stylesheet's fallbacks are keyed on `html:not([data-mode])`.
 */
export function modeAttribute(theme: ThemePreference): Mode | undefined {
  return theme === 'system' ? undefined : theme;
}
