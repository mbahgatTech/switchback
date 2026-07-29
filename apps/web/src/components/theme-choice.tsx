'use client';

import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { THEME_PREFERENCES, type ThemePreference } from '@switchback/core';
import { rememberTheme } from '../lib/theme-action';
import { useTRPC } from '../trpc/react';

/**
 * The theme control that sits in the collar of every page.
 *
 * Three cells in one strip, one of them filled — the same pressed/unpressed vocabulary the
 * settings page already uses for this exact setting, at the collar's size. It replaces a
 * `<select>`, and the select was wrong for two reasons that come down to the same thing: it
 * hid the answer set behind a click, and it was the only control in the product that
 * expressed "choose one of three" that way. Settings said it with buttons; the collar said
 * it with a dropdown; one setting, two grammars.
 *
 * A strip rather than three separate buttons. Shared borders are what make three controls
 * read as one question — spaced apart, at eleven pixels, beside five navigation words, they
 * would read as three more destinations.
 *
 * Still three answers and not two, for the reason a toggle never solved: the default is
 * "follow the device", and a two-state switch has nowhere to put it. Once a reader has
 * tapped a sun/moon toggle there is no way back to letting their phone decide at dusk.
 *
 * The current cell is disabled, which is honest — pressing it does nothing — and it is also
 * the one carrying the fill, so the disabled state is never the muted grey that would read
 * as "unavailable".
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
       * The account write is allowed to fail and the theme still changes. Its only job is
       * carrying the choice to another device; the cookie above has already made it true
       * here, and an expired session is not a reason to leave somebody staring at a control
       * that visibly did nothing.
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
            // cascade layer, so the filled cell's `text-canvas` still wins.
            //
            // `min-h-6` rather than a rung off `HEIGHT`: this is collar text made pressable,
            // like the five navigation words beside it, and a full touch rung here would make
            // the theme control the tallest thing in a row that is meant to read as a margin
            // note. 24 px is the floor WCAG 2.5.8 puts under a target that is not inline prose,
            // and eleven-pixel caps with `py-hair` land just under it on their own.
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
