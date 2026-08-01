import type { ReactNode } from 'react';
import { currentTheme } from '../lib/theme';
import { caller } from '../trpc/server';
import { type SiteSection, SiteNavMenu } from './site-nav-menu';

/**
 * The public surface stays this module, even though the declaration moved next door. Nothing
 * imports the type today; a caller that wants one should not have to know that the row is two
 * files because half of it needs a browser.
 */
export type { SiteSection };

/**
 * The index of the sheet.
 *
 * Collar text in the margin, not a navigation bar — the same eleven-pixel condensed caps every
 * other marginal label uses, because that is what these are. Above 1280px it is still exactly
 * that: six words and a theme control, no box, no button, nothing that reads as chrome.
 *
 * Below 1280px it is a menu behind a labelled disclosure, and that is a real concession. The
 * note that used to sit here said five was the ceiling — that at six the row stops reading as a
 * margin note and starts reading as a menu, which is the point at which it would need chrome
 * after all. That was right, and Downloads is the sixth. What follows is what it cost and why
 * it was paid.
 *
 * **The arithmetic, and where the fold is.** One breakpoint for the whole product, sized off the
 * densest header rather than tuned per page, because a fold that is right on the sparse screens
 * and wrong on the dense one is the exact bug a breakpoint is supposed to prevent. The binding
 * case is the map sheet's neatline: 48px tall, carrying the wordmark, the six words, the ODbL
 * credit and the two other marginal links beside it, and the theme strip. Measured, that is
 * about 1,117px of content — it clears 1280 and does not clear 1024. So `xl`, and see
 * `site-nav-menu.tsx` for the measurement.
 *
 * **The cost.** Below 1280px this is chrome. A row of words became a button, and on a
 * tablet-width window the six words would have fitted. The old note was right about what
 * happens at six. It also became a control that needs JavaScript: open/closed is React state,
 * so with scripting off, or in the window before hydration, the row below `xl` is an inert
 * button. `site-nav-menu.tsx` gives the two CSS-first shapes that were weighed against it and
 * why neither was taken. The one thing that must not ride behind it is the ODbL credit, which
 * goes through `beside` instead.
 *
 * **Why it is worth it.** `/downloads` was already in the product — precached in the service
 * worker's `SHELL_PAGES`, listed as a shortcut in the PWA manifest — and reachable only from
 * `/settings`, `/offline` and a profile. A screen a hiker opens at a trailhead with no signal
 * should not be three taps behind a settings page. One button on a phone buys that, and the
 * phone is where the argument is won: the row it replaces did not fit on a phone either. It
 * overflowed, silently, and had done since there were five words in it.
 *
 * The current page is named and not linked. A link to where you already are is a control that
 * does nothing, and removing it is also the clearest possible "you are here".
 */

/**
 * The theme control and the way out ride here rather than becoming a seventh and eighth entry.
 *
 * Neither is a destination and neither must read as one — but both have to be on every page.
 * A preference you can only change in Settings is one a signed-out reader cannot change at
 * all, and a sign-out you can only reach from Settings is one the next person to sit at a
 * shared computer will not find. This row is already on every page, so it is where both go:
 * inside the same collar, so they read as marginal notes rather than as chrome, and at the end
 * of it, after the places.
 *
 * Sign out is the newer of the two and the more overdue. `auth.ts` has exported `signOut`
 * since the beginning and nothing called it; the settings page told readers to press a button
 * in the header that did not exist. `site-nav-menu.tsx` has the arithmetic showing it does not
 * widen the fold — it replaces "Sign in", which is only there when it is not.
 *
 * It used to sit outside the `<nav>` as well, so the landmark held exactly the six places, and
 * `extra` sat outside for the same reason — a licence credit is not a destination, and neither
 * is "Sign in". Neither is true now, and the trade is written up in `site-nav-menu.tsx`: the
 * landmark had to move out to wrap the trigger, because inside the panel it was inside a
 * `display:none` subtree at every width below `xl`, and no page in the product exposed a
 * navigation landmark on a phone at all.
 *
 * **What `extra` is for.** Four headers used to hand-roll their own collar span around this
 * one — `<span className="collar flex items-center gap-md">` holding `<SiteNav>` and then an
 * attribution link or a sign-in link of their own. That worked while the row was only ever a
 * row: their links sat beside it and everything stayed on one line. It stops working the moment
 * the row can fold, because a sibling of the disclosure does not fold with it — it overflows
 * beside a tidy button. So anything riding next to the nav comes through this slot and lands
 * inside the same panel.
 *
 * **What `beside` is for.** The exception, and there is exactly one class of it: something that
 * has to be *displayed* rather than merely reachable. `extra` lands inside the panel, which is
 * `display:none` below `xl` — fine for "Sign in", not fine for the ODbL notice, which the
 * licence requires wherever the data is shown and which a control labelled "Index" does not
 * show. So `beside` renders outside the fold and hides itself at `xl`, where the panel becomes
 * the row again and carries the long-form credit. Nothing else belongs in it: a second thing
 * here is the overflow this breakpoint exists to prevent.
 *
 * Still `async`, and still a server component. It awaits the session and the theme cookie, both
 * of which are server-only — `trpc/server.ts` is `import 'server-only'` and `lib/theme.ts` reads
 * `cookies()` — and asking the browser for the theme instead would put back the flash that file
 * exists to prevent.
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
