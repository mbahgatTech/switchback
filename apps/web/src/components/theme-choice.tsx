'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { THEME_PREFERENCES, type ThemePreference } from '@switchback/core';
import { rememberTheme } from '../lib/theme-action';
import { useTRPC } from '../trpc/react';

/**
 * The theme control in the collar of every page: three cells in one strip, in the same
 * pressed/unpressed vocabulary the settings page uses for this setting. Three answers and not
 * two, because the default is "follow the device" and a toggle has nowhere to put it.
 */
const SHORT_LABEL: Record<ThemePreference, string> = {
  system: 'Auto',
  light: 'Light',
  dark: 'Dark',
};

/** Pressed and unpressed, in the vocabulary `settings-form.tsx` uses for the same choice. */
const PRESSED = 'bg-ink text-canvas';
const UNPRESSED = 'hover:text-ink';

export function ThemeChoice({ value, signedIn }: { value: ThemePreference; signedIn: boolean }) {
  const router = useRouter();
  const trpc = useTRPC();
  const update = useMutation(trpc.me.update.mutationOptions());
  const [pending, startTransition] = useTransition();

  function choose(next: ThemePreference) {
    startTransition(async () => {
      await rememberTheme(next);
      /*
       * The account write is allowed to fail and the theme still changes: its only job is
       * carrying the choice to another device, and the cookie has already made it true here.
       */
      if (signedIn) {
        try {
          await update.mutateAsync({ theme: next });
        } catch {
          /* the cookie is the local record, and it is already written */
        }
      }
      // The palette lives on `<html>`, which only the server renders. Re-ask for it.
      router.refresh();
    });
  }

  return (
    <div
      role="group"
      aria-label="Theme"
      className="flex items-center overflow-hidden rounded-hair border border-bezel"
    >
      {THEME_PREFERENCES.map((theme, index) => (
        <button
          key={theme}
          type="button"
          aria-pressed={theme === value}
          disabled={pending || theme === value}
          onClick={() => choose(theme)}
          className={[
            // `.collar` sets the face, size and muted ink; the utilities below sit in a later
            // cascade layer, so the filled cell's `text-canvas` still wins. `min-h-6` rather
            // than a rung off `HEIGHT`: this is collar text made pressable, and 24 px is the
            // floor WCAG 2.5.8 puts under a target that is not inline prose.
            'collar inline-flex min-h-6 items-center px-sm py-hair transition-colors duration-quick ease-standard disabled:cursor-default',
            // One rule between cells, none at the ends — the strip's own border draws those.
            index > 0 ? 'border-l border-bezel' : '',
            theme === value ? PRESSED : UNPRESSED,
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {SHORT_LABEL[theme]}
        </button>
      ))}
    </div>
  );
}
