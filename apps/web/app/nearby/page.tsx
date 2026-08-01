import type { Metadata } from 'next';
import Link from 'next/link';
import { ATTRIBUTION, BRAND } from '@switchback/core';
import { Locate } from '@/components/home/locate';
import { NearbyList } from '@/components/home/nearby-list';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { placeLabel, viewerPlace } from '@/lib/place';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';

/**
 * The list of hikes nearest the reader.
 *
 * This was the front page for a while, and the argument that put it there still stands: the
 * page that used to be `/` was a pitch — a headline, a sample elevation section, a legend of
 * the four plates — and every one of those was a page about the product rather than a page of
 * the product. So it showed the thing instead. Somewhere between five and twelve real trails,
 * ordered by how far away they are, each a link straight to its own page.
 *
 * The front page is now the map, which answers the same question without needing to know where
 * the reader is first. This page is what "Near you" in the neatline points at, and it is still
 * the better answer for somebody who has not decided where they are going: a list you can read
 * beats a sheet you have to pan. Nothing above the list but a line saying where "near" is
 * measured from and how we know, because that sentence is the only thing standing between an
 * honest list and a list that is quietly about a city the reader is not in.
 *
 * Three states, all of them this same page:
 *
 * - **A location and trails near it.** The list.
 * - **A location and nothing near it.** Said plainly, with the map offered — the on-demand
 *   pipeline fetches an area when somebody looks at it, so an empty list here means nobody
 *   has looked yet, not that there is nowhere to hike.
 * - **No location at all.** A question, and the browser asked on arrival rather than waited
 *   for a press. A list of trails near you has nothing to show until that is answered, so
 *   there is no later moment at which the reader would know more than they do now. See
 *   `components/home/locate.tsx` for the three guards that keep the ask from being rude.
 *
 * `data-scheme` is deliberately absent, so this page keeps the root `field` palette. It is
 * an index of places rather than something to read, and it is the page the map is one click
 * from — landing on paper and then falling into the dark instrument is a seam.
 */

export const metadata: Metadata = {
  title: 'Trails near you',
  description: `Hikes near you, with the weather at each point along the route. ${BRAND.tagline}`,
};

/**
 * 60 km. Wide enough that a reader in a city centre is offered the hills at the edge of the
 * county rather than three canal towpaths, and tight enough that "near" still means it.
 */
const RADIUS_M = 60_000;

/** Twelve rows is about a screen and a half — enough to scan, short enough to finish. */
const LIMIT = 12;

export default async function NearbyPage() {
  const [place, units, viewer] = await Promise.all([viewerPlace(), viewerUnits(), caller.me.get()]);

  const trails = place
    ? await caller.trails.nearby({ at: place.at, radiusM: RADIUS_M, limit: LIMIT })
    : [];

  return (
    <div className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-[880px] items-center justify-between gap-md px-xl py-lg">
        <Wordmark large />

        {/*
         * Signing in is one link to the one page that does it, rather than the pair of
         * provider buttons that used to sit halfway down this page. A page carrying its own
         * OAuth forms is a page that has decided signing in is the point; everything here
         * works signed out, so it is a link in the margin.
         *
         * It goes through `extra` so it folds into the nav disclosure at narrow widths rather
         * than overflowing beside it — which is also why `flex-wrap` is gone from the header
         * above. The wrap was the accidental mitigation for a nav row that did not fit: it
         * bought a second line the row then overflowed anyway. Wordmark and one button fit on
         * one line at 320px, and without the wrap a future slot cannot quietly bring it back.
         */}
        <SiteNav
          extra={
            viewer === null ? (
              <Link href="/signin" className="rounded-hair hover:text-ink">
                Sign in
              </Link>
            ) : null
          }
        />
      </header>

      <main className="mx-auto max-w-[880px] px-xl pb-5xl">
        <p className="collar">{place ? 'Near you' : 'Trails'}</p>

        <h1 className="mt-md text-h4 font-bold text-balance sm:text-h3">
          {place ? `Hikes near ${placeLabel(place)}` : 'Find a hike near you'}
        </h1>

        {/*
         * Where the numbers come from, said once and in the same breath as the heading. A
         * list headed "near you" that is measured from an IP lookup is wrong for anybody on
         * a VPN or one county over, and the reader is the only person who can tell.
         */}
        {place?.source === 'network' ? (
          <p className="mt-sm max-w-measure font-text text-caption text-ink-muted">
            Worked out from your connection, so it is a guess at the town rather than a position.
            Distances are measured from there.
          </p>
        ) : null}

        {place === null ? (
          <p className="mt-sm max-w-measure font-text text-body text-ink-muted">
            Every trail, forecast and profile here works without an account. This one needs
            somewhere to measure from.
          </p>
        ) : null}

        <div className="mt-lg">
          <Locate known={place !== null} precise={place?.source === 'browser'} />
        </div>

        {place !== null && trails.length > 0 ? (
          <NearbyList trails={trails} from={place.at} units={units} />
        ) : null}

        {place !== null && trails.length === 0 ? (
          <p className="mt-xl max-w-measure border-t border-bezel pt-lg font-text text-body text-ink-muted">
            No trails here yet. Nothing is downloaded until somebody looks at an area — open the map
            over the ground you want and it is fetched from OpenStreetMap while you watch.
          </p>
        ) : null}

        {/*
         * The map, always. It is the answer to every way this page can be wrong: the list is
         * short, the town is wrong, the hike you want is three counties away. Written as a
         * sentence rather than a second button so it does not compete with the one above it.
         */}
        <p className="mt-xl font-text text-body text-ink-muted">
          Or{' '}
          <Link
            href="/"
            className="rounded-hair font-display font-medium text-ink underline decoration-bezel underline-offset-4 hover:decoration-ink"
          >
            open the map
          </Link>{' '}
          and look anywhere.
        </p>
      </main>

      <footer className="border-t border-bezel">
        <div className="mx-auto flex max-w-[880px] flex-wrap gap-x-xl gap-y-sm px-xl py-xl">
          {[ATTRIBUTION.osm, ATTRIBUTION.openMeteo, ATTRIBUTION.terrain].map((source) => (
            <a key={source.href} href={source.href} className="collar rounded-hair hover:text-ink">
              {source.label} · {source.licence}
            </a>
          ))}
          <Link href="/attribution" className="collar rounded-hair hover:text-ink">
            All sources
          </Link>
          <Link href="/terms" className="collar rounded-hair hover:text-ink">
            Terms
          </Link>
          <Link href="/report" className="collar rounded-hair hover:text-ink">
            Report content
          </Link>
        </div>
      </footer>
    </div>
  );
}
