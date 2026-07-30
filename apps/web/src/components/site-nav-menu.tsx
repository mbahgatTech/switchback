'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ThemePreference } from '@switchback/core';
import { BUTTON_COLLAR, HEIGHT, SECONDARY } from './controls';
import { ThemeChoice } from './theme-choice';

/**
 * The six places this product goes, and the disclosure that holds them when they do not fit.
 *
 * The list and the section names live here rather than in `site-nav.tsx` because this file is
 * a client component and that one is not: `site-nav.tsx` imports `caller` from `../trpc/server`,
 * whose first line is `import 'server-only'`. A client module importing anything at all from
 * that file drags the server graph across the boundary, and the build fails somewhere far from
 * the import that did it.
 *
 * **Below `xl` this row needs JavaScript, and that is a real cost.** Open/closed is React
 * state, so with scripting off — and in the window before hydration on a cold phone — the
 * header is a wordmark, whatever rides `beside`, and an inert button. It was considered and
 * not taken: the CSS-first shapes both cost more than they buy here. `<details>` cannot be
 * forced open again above the breakpoint (a closed `<details>` hides its content through the
 * UA's own slot, and `::details-content` is too new to be the only thing standing between a
 * reader and the navigation), and the checkbox-and-sibling-selector trick has no
 * `aria-expanded`, no keyboard activation without script, and no role a screen reader reads
 * as a disclosure. Both trade a correct ARIA disclosure — labelled trigger, expanded state,
 * `aria-controls`, Escape, focus returned to the trigger — for pointer-only operation in a
 * case where four of the six destinations (`/`, `/plan`, `/record`, and `/explore`) are
 * `ssr: false` MapLibre instruments that render nothing without JavaScript anyway.
 *
 * What that buys has to be said where the claim used to be made rather than left implied, so
 * `explore-shell.tsx` no longer says the neatline renders without a browser.
 */

export type SiteSection = 'explore' | 'plan' | 'record' | 'lists' | 'profile' | 'downloads';

const DESTINATIONS: ReadonlyArray<{ key: SiteSection; href: string; label: string }> = [
  // The map is the front page, so this points at `/`. `/explore` is still a live route — the
  // alias kept for links already in the wild — but the nav names the canonical address.
  { key: 'explore', href: '/', label: 'Explore' },
  // In the order the product is used: find a hike, draw one of your own, do it, keep it.
  // Plan sits next to Explore because the two answer the same question — the first when
  // somebody has already hiked the line you want, the second when nobody has.
  { key: 'plan', href: '/plan', label: 'Plan' },
  // Record sits third because it is the only entry that is ever urgent — somebody standing
  // at a trailhead with a rucksack on should not have to read past three other words to
  // find it, and three is where that stops being true.
  { key: 'record', href: '/record', label: 'Record' },
  { key: 'lists', href: '/lists', label: 'Lists' },
  // `/profile` rather than `/u/<name>`, because it has to work before a username exists —
  // an account created by clicking "Sign in with Microsoft" has no handle until somebody
  // chooses one, and a nav entry that 404s for new accounts is worse than none.
  { key: 'profile', href: '/profile', label: 'Profile' },
  // Last, and last on purpose. The ordering above is the order the product is used — find a
  // hike, draw one of your own, do it, keep it — and keeping a device tidy is not a step in
  // that sequence. It goes after the four things the product is for, and after the account,
  // rather than interrupting them.
  { key: 'downloads', href: '/downloads', label: 'Downloads' },
];

/**
 * Where the row folds.
 *
 * `xl` — 1280px — and it is one number for the whole product rather than one per page. A
 * breakpoint tuned per header is how a menu ends up working on the sparse pages and
 * overflowing on the dense one, which is the failure this exists to make impossible.
 *
 * The number is measured, not guessed, off the densest header in the app: the neatline on the
 * map sheet, which carries the wordmark (103px), six collar words with five gaps (370px), four
 * more marginal links — Near you, Sign in, "© OpenStreetMap contributors", Sources (368px plus
 * gaps) — and the three-cell theme strip (148px). With `px-lg` gutters that is 1,117px of
 * content, which clears 1280 with room and does not clear 1024. `lg` would have folded the
 * sparse pages correctly and left the sheet overflowing.
 *
 * Everything below is written as: the closed/dropdown skin at every width, and an `xl:` reset
 * for each of those declarations. Every class in the open branch needs a counterpart, or a
 * menu left open while the window is dragged wider than 1280 renders as a bordered box
 * floating in the header — a state only reachable by resizing, so loading each width fresh
 * will not find it.
 *
 * **`max-h-dvh` rather than `max-h-none`.** `packages/ui/theme.css` defines `--spacing-none:
 * 0rem`, and Tailwind v4 resolves `max-h-none` against the spacing scale rather than as the
 * `max-height: none` keyword — so the reset that reads like "no cap" compiles to a cap of
 * zero. The panel keeps painting, because `overflow` is visible by then, and only its *box*
 * collapses: the row stops being vertically centred in the 48px neatline and nothing else
 * looks wrong. `dvh` is a cap that cannot bind here and cannot be misread.
 */
const PANEL_AT_WIDE =
  'xl:static xl:flex xl:w-auto xl:max-h-dvh xl:flex-row xl:items-center xl:gap-lg xl:overflow-visible xl:rounded-none xl:border-0 xl:bg-transparent xl:p-0';

/**
 * The dropdown, skinned like the one dropdown this repo already has.
 *
 * Copied from the place typeahead in `explore/search-box.tsx` — same offset below its trigger,
 * same hairline border, same `bg-surface`. Opaque and unshadowed because it opens over the map:
 * there is no z-axis on this sheet, and translucent chrome over imagery is chrome you cannot
 * read on top of a map you cannot read either. `z-30` is what clears the MapLibre canvas.
 *
 * `max-h` with a scroll rather than `overflow-hidden`: the three instrument pages wrap their
 * header in `h-dvh overflow-hidden`, so a panel taller than the viewport would be clipped
 * silently, with no scrollbar and no symptom. Six entries, four marginal links and the theme
 * strip come to roughly 330px against the 520px a 320×568 phone leaves below the neatline, so
 * this does not bite today; it is here so that a seventh entry cannot make it bite quietly.
 *
 * **`top-[calc(100%+…)]` measures from the neatline, not from the button.** That is what
 * `self-stretch` on the landmark below buys: the wrapper fills the 48px header rather than
 * hugging the 34px trigger, so `100%` is the header's own bottom edge and the `xs` gap lands
 * *below* the hairline instead of above it. Anchored to the trigger the panel's top edge sat
 * at y=44.6 against a rule at y=48 — and since the panel is opaque by design rule, it painted
 * out 243 of the header's 320 pixels of bottom rule whenever it was open. There is no z-axis
 * here; the hairline is the depth, so it is the one thing that must not be covered.
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

  // A soft navigation leaves the panel sitting over the page it just left. Nothing else in
  // React tells this component that the reader went somewhere; the path changing does.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Escape closes it and hands focus back to the button that opened it. A disclosure that
  // closes and drops focus on `<body>` leaves a keyboard reader at the top of the document
  // with no idea where they are.
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
     * The landmark wraps the trigger as well as the destinations, which is the W3C APG's
     * Disclosure Navigation Menu shape and here it is load-bearing rather than stylistic.
     * With the `<nav>` inside the panel, every width below `xl` put the only navigation
     * landmark in the product inside a `display:none` subtree — so a screen reader on a phone
     * found `banner` and `main` in the rotor and no `navigation` at all, on the exact widths
     * this disclosure exists to serve. Around the trigger there is still exactly one landmark
     * and it is in the tree at every width.
     *
     * The cost is that `extra` and the theme strip are inside it now; `site-nav.tsx` used to
     * argue they should sit outside because neither is a destination. That argument loses to
     * this one — a navigation landmark carrying a licence link is a smaller wrong than no
     * navigation landmark — and it cannot be had both ways while the panel holds all three.
     *
     * `self-stretch` fills the neatline rather than the trigger, which is what makes
     * `PANEL_OPEN`'s `top-[calc(100%+…)]` measure from the header's bottom rule. See there.
     */
    <nav ref={box} className="collar relative flex items-center gap-lg self-stretch">
      {/*
       * Whatever must not fold. The ODbL credit on the map screens goes here rather than
       * through `extra`: `extra` lands inside the panel, and a licence notice reachable only
       * by opening a control is not displayed. Everything else rides `extra`.
       */}
      {beside ? <span className="xl:hidden">{beside}</span> : null}

      {/*
       * "Index", not "Menu", and no glyph.
       *
       * Every other string in this row names a place or a thing — Explore, Plan, Record,
       * Near you, Sources. "Menu" named the widget instead, and mislabelled it: on the map
       * sheet this panel holds the OSM credit and the theme strip as well as the six
       * destinations. "Index" is the word `site-nav.tsx` already uses for this row, and on a
       * sheet with a collar it is the marginal list of what is on the sheet — which is what
       * this is. The label stays the same in both states; the state is on `aria-expanded`,
       * which is where a screen reader looks for it, and a word that changes under the
       * pointer is a word somebody has to re-read.
       *
       * The three-bar glyph that used to sit here was the one mark in the product with no
       * cartographic referent — `blaze.tsx` and `lists/marks.tsx` both write that policy
       * down — and it was carrying nothing: the word is 4px to its right and the state is on
       * the attribute. `BUTTON_COLLAR` plus `SECONDARY` is a hairline outline on the 34px
       * rung, so a word on its own is still a legible target.
       *
       * `HEIGHT.panel` rather than `HEIGHT.touch`: 34px is the rung the rest of this
       * product's instrument chrome sits on, it clears the 24px floor WCAG 2.5.8 puts under
       * a target, and a 48px control inside a 48px neatline would press its focus ring
       * against the edge of the header.
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

        <ThemeChoice value={theme} signedIn={signedIn} />
      </div>
    </nav>
  );
}
