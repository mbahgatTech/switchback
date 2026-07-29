import Link from 'next/link';
import { currentTheme } from '../lib/theme';
import { caller } from '../trpc/server';
import { ThemeChoice } from './theme-choice';

/**
 * The five places this product goes.
 *
 * Collar text in the margin of the sheet, not a navigation bar — the same eleven-pixel
 * condensed caps every other marginal label uses, because that is what these are. A product
 * with five destinations does not need chrome to hold them; it needs them written where a
 * sheet writes its index.
 *
 * Five is the ceiling. At six the row stops reading as a margin note and starts reading as a
 * menu, which is the point at which it would need chrome after all.
 *
 * The current page is named and not linked. A link to where you already are is a control
 * that does nothing, and removing it is also the clearest possible "you are here".
 */

export type SiteSection = 'explore' | 'plan' | 'record' | 'lists' | 'profile';

const DESTINATIONS: ReadonlyArray<{ key: SiteSection; href: string; label: string }> = [
  { key: 'explore', href: '/explore', label: 'Explore' },
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
];

/**
 * The theme control rides here rather than becoming a sixth entry.
 *
 * It is not a destination and must not read as one — but it does have to be on every page,
 * because a preference you can only change in Settings is one a signed-out reader cannot
 * change at all. This row is already on every page, so it is where the control goes: outside
 * the `<nav>`, so the landmark still contains exactly the five places, and inside the same
 * collar so it reads as one more marginal note rather than as chrome.
 *
 * `<span>` rather than `<div>` because two callers nest this inside a `<span>` of their own
 * alongside the licence line, and a block element inside phrasing content is a parse error
 * the browser fixes by moving the element somewhere you did not put it.
 */
export async function SiteNav({ current }: { current?: SiteSection }) {
  const [viewer, theme] = await Promise.all([caller.me.get(), currentTheme()]);

  return (
    <span className="collar flex items-center gap-lg">
      <nav className="flex items-center gap-lg">
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
      </nav>

      <ThemeChoice value={theme} signedIn={viewer !== null} />
    </span>
  );
}
