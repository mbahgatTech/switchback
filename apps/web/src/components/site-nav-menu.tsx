'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ThemePreference } from '@switchback/core';
import { signOutAction } from './auth/sign-out-action';
import { BUTTON_COLLAR, HEIGHT, SECONDARY } from './controls';
import { ThemeChoice } from './theme-choice';

/**
 * The six places this product goes, the controls beside them, and the disclosure that holds
 * them below `xl`. The list lives here rather than in `site-nav.tsx`, which reaches
 * `server-only` through `../trpc/server` and cannot be imported from a client module.
 */

export type SiteSection = 'explore' | 'plan' | 'record' | 'lists' | 'profile' | 'downloads';

const DESTINATIONS: ReadonlyArray<{ key: SiteSection; href: string; label: string }> = [
  // The map is the front page. `/explore` stays a live alias for links in the wild, but the
  // nav names the canonical address.
  { key: 'explore', href: '/', label: 'Explore' },
  // In the order the product is used: find a hike, draw one of your own, do it, keep it.
  { key: 'plan', href: '/plan', label: 'Plan' },
  { key: 'record', href: '/record', label: 'Record' },
  { key: 'lists', href: '/lists', label: 'Lists' },
  // `/profile` rather than `/u/<name>`: an account created through a provider has no handle
  // until somebody chooses one, and a nav entry that 404s for new accounts is worse than none.
  { key: 'profile', href: '/profile', label: 'Profile' },
  { key: 'downloads', href: '/downloads', label: 'Downloads' },
];

/**
 * Where the row folds — `xl`, one number for the whole product, measured off the densest
 * header (the map neatline, 1,117px of content, which clears 1280 and not 1024).
 *
 * Every class in the open branch needs an `xl:` counterpart here, or a menu left open while
 * the window is dragged past 1280 renders as a bordered box floating in the header.
 * `max-h-dvh` rather than `max-h-none`: `--spacing-none: 0rem`, and Tailwind v4 resolves
 * `max-h-none` against the spacing scale, so the reset that reads as "no cap" compiles to zero.
 */
const PANEL_AT_WIDE =
  'xl:static xl:flex xl:w-auto xl:max-h-dvh xl:flex-row xl:items-center xl:gap-lg xl:overflow-visible xl:rounded-none xl:border-0 xl:bg-transparent xl:p-0';

/**
 * The dropdown, skinned like the place typeahead in `explore/search-box.tsx`. Opaque and
 * unshadowed because it opens over the map, and `z-30` clears the MapLibre canvas.
 *
 * `max-h` with a scroll rather than `overflow-hidden`, because the three instrument pages wrap
 * their header in `h-dvh overflow-hidden` and would clip a taller panel with no scrollbar and
 * no symptom. `top-[calc(100%+…)]` measures from the neatline rather than the trigger — that
 * is what `self-stretch` on the landmark below buys — so the panel does not paint out the
 * header's bottom hairline, which on a sheet with no z-axis is the only depth there is.
 */
const PANEL_OPEN =
  'absolute right-0 top-[calc(100%+var(--spacing-xs))] z-30 flex max-h-[70dvh] w-max flex-col items-start gap-md overflow-y-auto rounded-hair border border-bezel bg-surface p-lg';

export function SiteNavMenu({
  current,
  theme,
  signedIn,
  extra,
  beside,
}: {
  current?: SiteSection;
  theme: ThemePreference;
  signedIn: boolean;
  extra?: ReactNode;
  beside?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const box = useRef<HTMLElement | null>(null);
  const pathname = usePathname();

  // A soft navigation leaves the panel sitting over the page it just left; the path changing
  // is the only thing that tells this component the reader went somewhere.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes it and hands focus back to the trigger, so a keyboard reader is not dropped
  // on `<body>` at the top of the document.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Clicking anywhere else puts it away. Pointerdown rather than click, for the reason
  // `search-box.tsx` gives: the panel is gone by the time a click on the map below it lands.
  useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  return (
    /*
     * The landmark wraps the trigger as well as the destinations — the W3C APG's Disclosure
     * Navigation Menu shape, and load-bearing: with the `<nav>` inside the panel, every width
     * below `xl` put the product's only navigation landmark in a `display:none` subtree.
     * `self-stretch` fills the neatline rather than the trigger, which is what makes
     * `PANEL_OPEN`'s `top-[calc(100%+…)]` measure from the header's bottom rule.
     */
    <nav ref={box} className="collar relative flex items-center gap-lg self-stretch">
      {/*
       * Whatever must not fold. The ODbL credit on the map screens goes here rather than
       * through `extra`, which lands inside the panel — a licence notice reachable only by
       * opening a control is not displayed.
       */}
      {beside ? <span className="xl:hidden">{beside}</span> : null}

      {/*
       * "Index", not "Menu": every other string in this row names a place or a thing, and this
       * panel holds the OSM credit and the theme strip as well as the six destinations. The
       * label does not change with the state — `aria-expanded` carries that. `HEIGHT.panel`
       * rather than `HEIGHT.touch`, so a 48px control does not press its focus ring against
       * the edge of a 48px neatline; 34px still clears the WCAG 2.5.8 floor of 24px.
       */}
      <button
        ref={trigger}
        type="button"
        onClick={() => setOpen((was) => !was)}
        aria-expanded={open}
        aria-controls="site-nav-menu"
        className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.panel} px-md xl:hidden`}
      >
        Index
      </button>

      {/*
       * One subtree, always in the DOM. Rendering it only while open would leave
       * `aria-controls` pointing at nothing on every page load, which axe reports as an
       * `aria-valid-attr-value` failure on every route at once.
       */}
      <div id="site-nav-menu" className={[PANEL_AT_WIDE, open ? PANEL_OPEN : 'hidden'].join(' ')}>
        {/* A plain `<div>`: the landmark is the element above, for the reason given there. */}
        <div className="flex flex-col items-start gap-md xl:flex-row xl:items-center xl:gap-lg">
          {DESTINATIONS.map((destination) =>
            destination.key === current ? (
              <span key={destination.key} className="text-ink">
                {destination.label}
              </span>
            ) : (
              <Link
                key={destination.key}
                href={destination.href}
                className="rounded-hair hover:text-ink"
              >
                {destination.label}
              </Link>
            ),
          )}
        </div>

        {extra}

        {/*
         * Leaving is a control rather than a destination, so it sits beside the theme strip
         * and not among the six words. A `<form>` around a server action, not an `onClick`:
         * it works before hydration and with scripting off, which the disclosure around it
         * does not — and this is the case that matters most on a shared computer.
         */}
        {signedIn ? (
          <form action={signOutAction}>
            {/*
             * `min-h-6` and `inline-flex` for the reason `theme-choice.tsx` gives: the six
             * words are inline prose and exempt from WCAG 2.5.8, a `<button>` is not, and
             * eleven-pixel caps on their own land just under the 24px floor.
             */}
            <button
              type="submit"
              className="collar inline-flex min-h-6 items-center rounded-hair hover:text-ink"
            >
              Sign out
            </button>
          </form>
        ) : null}

        <ThemeChoice value={theme} signedIn={signedIn} />
      </div>
    </nav>
  );
}
