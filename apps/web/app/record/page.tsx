import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BRAND, trailTitle } from '@switchback/core';
import { OsmCredit, OsmCreditBeside } from '@/components/map/osm-credit';
import { Recorder, type RecorderTrail } from '@/components/record/recorder';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { caller } from '@/trpc/server';

/**
 * Record a hike.
 *
 * The `field` scheme, inherited from the root rather than declared — this is a screen used
 * outdoors, on a phone, often at dusk, and the dark plate is the one that does not blind
 * somebody checking their position at the col. `/explore` is the same for the same reason;
 * the reading pages are the exception, not this.
 *
 * The shell does three things and stops. It confirms there is a hiker, asks the server
 * whether one of their recordings is still open, and — when the page was reached from a
 * trail — loads that trail's line. Everything after that needs a browser's geolocation and
 * lives in `<Recorder>`.
 *
 * **The trail is destructured rather than passed whole.** `trails.bySlug` returns the
 * elevation profile, which is several thousand points, and none of them are wanted here: a
 * recording draws the route as a line and measures distance along it, and both come from
 * the geometry. Sending the profile too would double the page's payload to draw nothing.
 */

export const metadata: Metadata = {
  title: 'Record',
  description: `Track a hike as you do it — distance, ascent, pace, and a warning if you leave the trail. ${BRAND.tagline}`,
};

export default async function RecordPage({
  searchParams,
}: {
  searchParams: Promise<{ trail?: string }>;
}) {
  const { trail: slug } = await searchParams;
  const target = slug ? `/record${`?trail=${encodeURIComponent(slug)}`}` : '/record';

  const viewer = await caller.me.get();
  if (!viewer) redirect(`/signin?callbackUrl=${encodeURIComponent(target)}`);

  // In parallel: a recording left open is the more urgent of the two, and neither depends
  // on the other.
  const [openRecording, found] = await Promise.all([
    caller.activities.open(),
    slug ? caller.trails.bySlug({ slug }).catch(() => null) : Promise.resolve(null),
  ]);

  const trail: RecorderTrail | null =
    found && found.geometry.coordinates.length >= 2
      ? {
          id: found.id,
          name: found.name,
          displayName: found.displayName,
          slug: found.slug,
          geometry: found.geometry,
          lengthM: found.stats.lengthM,
        }
      : null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      {/*
       * Off-screen, for the same reason as the one on `/explore` — see the note there. The
       * trail is named when there is one: this page is opened from a trail as often as from
       * the nav, and "Record a hike on Vesper Peak summit trail" confirms the right one came
       * through without having to go looking for it on the map.
       */}
      <h1 className="sr-only">
        {trail ? `Record a hike on ${trailTitle(trail)}` : 'Record a hike'}
      </h1>

      <header className="flex h-3xl shrink-0 items-center justify-between gap-lg border-b border-bezel px-lg">
        <Wordmark />

        {/*
          `record-map.tsx` sets `attributionControl: false`, so this link is the whole ODbL
          credit for the screen — which is why it goes through `beside` and not `extra`.
          Folding it into the disclosure was argued as a strict improvement on the
          `hidden … sm:inline` it replaced, since that class meant no credit at all below
          640px. It was an improvement below 640 and a regression from 640 to 1279, where the
          old class rendered the credit and the disclosure does not. `beside` shows it at
          every width, long-form wherever it fits.
        */}
        <SiteNav current="record" beside={<OsmCreditBeside />} extra={<OsmCredit />} />
      </header>

      {/* The landmark, for the reason given in `components/explore/explore-shell.tsx`. */}
      <main className="contents">
        <Recorder
          units={viewer.units}
          defaultVisibility={viewer.defaultActivityVisibility}
          trail={trail}
          openRecording={openRecording}
        />
      </main>
    </div>
  );
}
