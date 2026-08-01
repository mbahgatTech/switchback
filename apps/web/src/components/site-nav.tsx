import type { ReactNode } from 'react';
import { currentTheme } from '../lib/theme';
import { caller } from '../trpc/server';
import { type SiteSection, SiteNavMenu } from './site-nav-menu';

/** Re-exported here so a caller need not know the row is two files because half needs a browser. */
export type { SiteSection };

/**
 * The index of the sheet: collar text in the margin above `xl`, a labelled disclosure below it.
 * `site-nav-menu.tsx` holds the breakpoint arithmetic. The current page is named, not linked.
 */

/**
 * The theme control and the way out ride here rather than becoming a seventh and eighth entry:
 * neither is a destination, but a preference reachable only from Settings is one a signed-out
 * reader cannot change, and a sign-out only reachable from Settings is one the next person at a
 * shared computer will not find.
 *
 * `extra` lands inside the panel, so anything that must be *displayed* rather than merely
 * reachable goes through `beside`, which renders outside the fold and hides itself at `xl` —
 * the ODbL notice, which the licence requires wherever the data is shown. Nothing else belongs
 * in it.
 *
 * A server component: it awaits the session and the theme cookie, both server-only, and asking
 * the browser for the theme would put back the flash `lib/theme.ts` exists to prevent.
 */
export async function SiteNav({
  current,
  extra,
  beside,
}: {
  current?: SiteSection;
  extra?: ReactNode;
  beside?: ReactNode;
}) {
  const [viewer, theme] = await Promise.all([caller.me.get(), currentTheme()]);

  return (
    <SiteNavMenu
      current={current}
      theme={theme}
      signedIn={viewer !== null}
      extra={extra}
      beside={beside}
    />
  );
}
