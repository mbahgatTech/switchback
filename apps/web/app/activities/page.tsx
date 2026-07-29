import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { BRAND, formatClock, formatDistance, formatElevation, plural } from '@switchback/core';
import { ActivityRows } from '@/components/activity/activity-rows';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { caller } from '@/trpc/server';
import { BUTTON_COLLAR, GHOST, HEIGHT, PRIMARY } from '@/components/controls';

/**
 * Everything you have recorded.
 *
 * Distinct from `/lists/completed`, which is the trails you have ticked off — a claim about
 * where you have been. This is the recordings themselves: tracks with times on them, some of
 * which match no trail we hold. A hike down a lane belongs here and nowhere else, and the
 * distinction is worth two pages because merging them would mean either dropping the hikes
 * that match nothing or listing a trail twice for two visits.
 *
 * **Paged with links, not with a button.** The cursor rides in the query string, so a hiker
 * scrolling back through two years of recordings can send a friend page four, and the whole
 * page works before any JavaScript arrives — which on this page matters, because the most
 * likely reader of it is standing outside with one bar of signal.
 */

export const metadata: Metadata = {
  title: 'Your recordings',
  description: `Every hike you have tracked. ${BRAND.tagline}`,
  robots: { index: false, follow: false },
};

export default async function ActivitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const { cursor } = await searchParams;
  const viewer = await caller.me.get();
  if (!viewer) redirect(`/signin?callbackUrl=${encodeURIComponent('/activities')}`);

  const page = await caller.activities.mine(cursor ? { cursor } : {});
  const totals = page.items.reduce(
    (acc, item) => ({
      distanceM: acc.distanceM + item.distanceM,
      gainM: acc.gainM + item.gainM,
      movingTimeS: acc.movingTimeS + item.movingTimeS,
    }),
    { distanceM: 0, gainM: 0, movingTimeS: 0 },
  );

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="profile" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <p className="collar flex flex-wrap items-center gap-x-md gap-y-xs">
          <Link href="/profile" className="rounded-hair hover:text-ink">
            ← Your record
          </Link>
          <span>
            {page.total} {plural(page.total, 'recording')}
          </span>
        </p>

        <h1 className="mt-md text-h3 font-bold">Recordings</h1>

        {page.items.length === 0 ? (
          <div className="mt-xl max-w-measure">
            <p className="font-text text-body-lg text-ink-muted">
              Nothing recorded yet. Open a trail and press record at the car park, or start one from
              wherever you are — a hike does not have to be on a trail we hold to be worth keeping.
            </p>
            <Link
              href="/record"
              className={`${BUTTON_COLLAR} ${PRIMARY} ${HEIGHT.touch} mt-lg px-lg`}
            >
              Record a hike
            </Link>
          </div>
        ) : (
          <>
            {/*
             * The figures for this page, not for the whole record — the profile carries the
             * lifetime totals and repeating them here would put two different numbers under
             * the same word on two pages of the same product. The count of rows appears only
             * once the record runs to more than one page; before that the collar above has
             * already said it, and two identical numbers a line apart read as an error.
             */}
            <dl className="mt-lg flex flex-wrap items-baseline gap-x-lg gap-y-xs font-mono text-micro text-ink-muted">
              {cursor || page.nextCursor ? (
                <Figure label="On this page" value={`${page.items.length}`} />
              ) : null}
              <Figure label="Distance" value={formatDistance(totals.distanceM, viewer.units)} />
              <Figure label="Ascent" value={`↑${formatElevation(totals.gainM, viewer.units)}`} />
              <Figure label="Moving" value={formatClock(totals.movingTimeS)} />
            </dl>

            <ActivityRows activities={page.items} units={viewer.units} className="mt-lg" />

            {/*
             * The pagers are the only two controls on this page, and the likely reader is
             * outdoors with a thumb. A bare collar link is eleven-pixel type in a fifteen-pixel
             * box, so they carry the same button collar and the same touch rung as every other
             * finger target — quiet, because a ghost has no border, but reachable.
             */}
            <div className="mt-lg flex items-center justify-between gap-md">
              {cursor ? (
                <Link
                  href="/activities"
                  className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.touch} px-sm`}
                >
                  ← Newest
                </Link>
              ) : (
                <span />
              )}
              {page.nextCursor ? (
                <Link
                  href={`/activities?cursor=${encodeURIComponent(page.nextCursor)}`}
                  className={`${BUTTON_COLLAR} ${GHOST} ${HEIGHT.touch} px-sm`}
                >
                  Older →
                </Link>
              ) : null}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

/**
 * One figure in the summary row: a term and its value.
 *
 * A `div` wrapping a `dt`/`dd` pair, which is the grouping HTML actually sanctions inside a
 * `dl` — and the reason this is not the `span` it used to be. A `dl` may contain only
 * `dt`, `dd`, `div`, and script-supporting elements; anything else and a screen reader stops
 * treating the whole thing as a description list, so one wrong wrapper here silently cost
 * all four figures their term/value pairing. The `div` is what lets a pair stay one flex
 * item while the `dl` above lays the pairs out in a row.
 *
 * Both parts stay visible, unlike the sibling on `/lists/[key]` where the term is off-screen:
 * here the labels are the only thing distinguishing four bare numbers from each other.
 */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-xs">
      <dt className="collar">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}
