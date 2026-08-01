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
 * Every hike you have recorded — distinct from `/lists/completed`, which is trails you have ticked
 * off. These are the tracks themselves, some of which match no trail we hold.
 *
 * Paged with links rather than a button: the cursor rides in the query string, so page four can be
 * shared and the whole page works before any JavaScript arrives.
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
            {/* This page's figures, not the lifetime totals the profile carries. The row count
             * appears only past page one, where the collar above has not already said it. */}
            <dl className="mt-lg flex flex-wrap items-baseline gap-x-lg gap-y-xs font-mono text-micro text-ink-muted">
              {cursor || page.nextCursor ? (
                <Figure label="On this page" value={`${page.items.length}`} />
              ) : null}
              <Figure label="Distance" value={formatDistance(totals.distanceM, viewer.units)} />
              <Figure label="Ascent" value={`↑${formatElevation(totals.gainM, viewer.units)}`} />
              <Figure label="Moving" value={formatClock(totals.movingTimeS)} />
            </dl>

            <ActivityRows activities={page.items} units={viewer.units} className="mt-lg" />

            {/* The pagers carry the button collar and the touch rung: a bare collar link is
             * eleven-pixel type in a fifteen-pixel box, and the reader is outdoors with a thumb. */}
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
 * One figure in the summary row. A `div` around the `dt`/`dd` pair, not a `span`: a `dl` may
 * contain only `dt`, `dd` and `div`, and one wrong wrapper silently costs every figure its
 * term/value pairing in a screen reader.
 */
function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-xs">
      <dt className="collar">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}
