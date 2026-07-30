import Link from 'next/link';
import { placeCamera, viewerPlace } from '@/lib/place';
import { caller } from '@/trpc/server';
import { OsmCredit, OsmCreditBeside } from '../map/osm-credit';
import { SiteNav } from '../site-nav';
import { Wordmark } from '../wordmark';
import { Explore } from './explore';

/**
 * The neatline around the map, and the chrome that surrounds it.
 *
 * A server shell holding the ruled border and title strip of a map sheet, with the whole
 * interactive sheet below it. Everything that needs a browser lives in `<Explore>`; this is
 * chrome, the session read, and the licence line.
 *
 * This file used to open "and everything that renders without JavaScript". It does not: the
 * map is `ssr: false` and the nav below `xl` is a React-state disclosure, so on this page the
 * only things that survive scripting being off are the wordmark, the heading and the credit.
 * The one of those that has to be true is the credit — see `beside`, below.
 *
 * It lives in `components/` rather than in a route file because two routes render it. The map
 * is the front page — `app/page.tsx` — and `/explore` is the alias kept alive for every link
 * already in the wild, so both are the same markup and there is exactly one copy of it.
 *
 * `atHome` is the one difference between them, and it is not a variant: it only says whether
 * the wordmark is a link to the page you are already on.
 */

export async function ExploreShell({ atHome }: { atHome: boolean }) {
  /*
   * Both read here, and neither depends on the other.
   *
   * The session, because every card wants to know whether there is anyone to save a trail
   * *for*, and asking the browser for it means thirty controls that appear a beat after the
   * list does. The place, because the server is the only side that can see the cookie and the
   * edge geo headers before the first byte — a client-side answer would arrive after the map
   * had already been built somewhere else, and moving it afterwards means an `easeTo` under a
   * reader who may already be panning.
   *
   * `viewerPlace()` is a `cache()`d cookie-and-header read with no I/O, so this costs nothing
   * and saves a round trip. Deliberately not a geolocation prompt: this screen has something
   * to show before it is told anything, so there is a "later", and `/` is the manifest's
   * `start_url` — making an installed app's cold launch wait on the geolocation radio is
   * exactly backwards. The reader's own correction path is the search box; see `onPlaceSelect`.
   */
  const [viewer, place] = await Promise.all([caller.me.get(), viewerPlace()]);

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      {/*
       * The page's name, off-screen.
       *
       * The three full-screen tools — this, `/plan`, `/record` — are the only pages in the
       * product without a visible `<h1>`, because on each of them the instrument *is* the
       * page and a heading above it would cost a line of map for nothing. That is a fine
       * visual decision and was a bad structural one: heading navigation is how a screen
       * reader user answers "where am I", and these three answered nothing. Every other page
       * here has an `<h1>`; going quiet on exactly the pages that are hardest to read by
       * shape is backwards.
       *
       * `sr-only` rather than a real heading, so the layout is unchanged and the announcement
       * is not. Named for the task rather than the tool — somebody who has just landed here
       * wants to know what they can do, not what it is called.
       */}
      <h1 className="sr-only">Explore trails</h1>

      <header className="flex h-3xl shrink-0 items-center justify-between gap-lg border-b border-bezel px-lg">
        <Wordmark home={!atHome} />

        {/*
          ODbL requires attribution wherever the data is shown, and this is the screen that
          shows it. It sits in the neatline rather than over the map: a licence line burned
          into the corner of a canvas is the first thing a basemap swap or a screenshot
          loses, and it is illegible over imagery either way.

          It goes through `beside` rather than `extra`, which is the whole of the difference
          between a credit that is displayed and one that is merely reachable. A note that
          used to sit here claimed the fold was safe because "the map here keeps MapLibre's
          own attribution control, so the credit is on the canvas as well". That was simply
          untrue — `map/trail-map.tsx` sets `attributionControl: false`, and has said so in a
          comment the whole time — and the effect of believing it was that every phone and
          tablet rendered OSM data with no attribution anywhere on screen. `beside` puts it
          back outside the fold at every width; see `map/osm-credit.tsx` for the two forms.

          "Near you" and "Sign in" ride beside the destinations rather than joining them, for
          the reason `site-nav.tsx` gives: they are not places this product goes. They are
          here at all because this is the front door now — the nearby list used to be the page
          `/` served and carried the only "Sign in" link in the product, so both would
          otherwise be reachable from nowhere.

          "Near you" being here is a real cost and worth naming rather than leaving as an
          oversight. It is one of only two links to `/nearby` in the application — the other is
          the empty state on `/downloads` — so from `/plan`, `/lists`, a trail page or anywhere
          else the list is three taps away: wordmark, Index, Near you. It used to be one,
          because it used to be `/`. The row is at the six-word ceiling `site-nav.tsx` argues
          for, so it cannot become a seventh destination without giving up the argument that
          keeps this a collar rather than a navigation bar. The trade taken is that the list is
          now an accessory of the map: the map answers the same question without being told
          where you are, and the list is the better answer only once you are already looking at
          the map and would rather read than pan. That is a defensible place for it to live;
          being hard to reach from the rest of the product is the part that had to be paid for,
          and this is the note saying so.

          Everything except the credit goes through `extra` rather than sitting in a span of
          its own. A sibling of the disclosure does not fold with it; it overflows beside a
          tidy button.
        */}
        <SiteNav
          current="explore"
          beside={<OsmCreditBeside />}
          extra={
            <>
              <Link href="/nearby" className="rounded-hair hover:text-ink">
                Near you
              </Link>
              {viewer === null ? (
                <Link href="/signin" className="rounded-hair hover:text-ink">
                  Sign in
                </Link>
              ) : null}
              <OsmCredit />
              <Link href="/attribution" className="rounded-hair hover:text-ink">
                Sources
              </Link>
            </>
          }
        />
      </header>

      {/*
       * The landmark the front page lost when it became the map.
       *
       * `app/page.tsx` used to wrap its list in `<main>`; this shell had none, so the app's
       * most important URL exposed `banner` and nothing else — the sr-only `<h1>` argued for
       * above was itself outside every landmark. `contents` restores the landmark without
       * adding a box: `<Explore>`'s own root is the flex child this column is laid out
       * around, and an extra generated box between them would have to re-declare `min-h-0
       * flex-1` to keep the sheet the height it is.
       */}
      <main className="contents">
        <Explore viewerId={viewer?.id ?? null} opening={placeCamera(place)} />
      </main>
    </div>
  );
}
