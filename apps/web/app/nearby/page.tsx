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
 * The list of hikes nearest the reader — what "Near you" in the neatline points at. Three states,
 * all this same page: a location with trails, a location with none (nobody has looked at that
 * ground yet, so the map is offered), and no location, which the browser is asked for on arrival
 * because there is no later moment at which the reader would know more.
 *
 * `data-scheme` is deliberately absent so this keeps the root `field` palette: it is an index of
 * places one click from the map, and landing on paper then falling into the dark instrument is a
 * seam.
 */

export const metadata: Metadata = {
  title: 'Trails near you',
  description: `Hikes near you, with the weather at each point along the route. ${BRAND.tagline}`,
};

/** 60 km: wide enough to offer the hills at the county edge, tight enough that "near" means it. */
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
         * Through `extra` so it folds into the nav disclosure at narrow widths rather than
         * overflowing beside it — which is why `flex-wrap` is gone from the header above.
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

        {/* A list headed "near you" measured from an IP lookup is wrong for anybody on a VPN,
         * and the reader is the only person who can tell. */}
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

        {/* The answer to every way this page can be wrong. A sentence, not a second button, so
         * it does not compete with the one above it. */}
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
