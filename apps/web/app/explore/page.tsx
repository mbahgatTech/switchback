import type { Metadata } from 'next';
import Link from 'next/link';
import { ATTRIBUTION, BRAND } from '@switchback/core';
import { Explore } from '@/components/explore/explore';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { caller } from '@/trpc/server';

/**
 * Explore.
 *
 * A server shell holding the neatline — the ruled border and title strip of a map sheet —
 * with the whole interactive sheet below it. Everything that needs a browser lives in
 * `<Explore>`; this file is metadata, chrome, and the licence line, all of which should
 * render without JavaScript.
 */

export const metadata: Metadata = {
  title: 'Explore',
  description: `Browse trails on a shaded relief sheet. ${BRAND.tagline}`,
};

export default async function ExplorePage() {
  /*
   * Read here rather than in the card. Every card wants to know whether there is anyone to
   * save a trail *for*, and asking the browser for it means thirty controls that appear a
   * beat after the list does. The session is already loaded to render this page.
   */
  const viewer = await caller.me.get();

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
        <Wordmark />

        {/*
          ODbL requires attribution wherever the data is shown, and this is the screen that
          shows it. It sits in the neatline rather than over the map: a licence line burned
          into the corner of a canvas is the first thing a basemap swap or a screenshot
          loses, and it is illegible over imagery either way.
        */}
        <span className="collar flex items-center gap-md">
          <SiteNav current="explore" />
          <a href={ATTRIBUTION.osm.href} className="rounded-hair hover:text-ink">
            {ATTRIBUTION.osm.label}
          </a>
          <Link href="/attribution" className="rounded-hair hover:text-ink">
            Sources
          </Link>
        </span>
      </header>

      <Explore viewerId={viewer?.id ?? null} />
    </div>
  );
}
