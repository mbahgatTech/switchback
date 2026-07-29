import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { BRAND, formatDistance, formatElevation, plural } from '@switchback/core';
import { ListCard } from '@/components/lists/list-card';
import { NewList } from '@/components/lists/new-list';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { caller } from '@/trpc/server';

/**
 * Your lists.
 *
 * The three you were given, then the ones you made. Provisioning runs inside `lists.mine`,
 * so this page is never empty in the way a fresh account's page usually is — it opens on
 * three named shelves with instructions in them rather than on a "create your first list"
 * void.
 *
 * The one number at the top is total distance, not total lists. What a hiker has collected
 * here is a quantity of hiking; how many folders it is filed in is bookkeeping.
 */

export const metadata: Metadata = {
  title: 'Lists',
  description: `The trails you have kept, the ones you mean to do, and the ones you have done. ${BRAND.tagline}`,
};

export default async function ListsPage() {
  const viewer = await caller.me.get();
  if (!viewer) redirect(`/signin?callbackUrl=${encodeURIComponent('/lists')}`);

  const lists = await caller.lists.mine();
  const custom = lists.filter((list) => list.kind === 'custom');

  // Completed is counted in both of the other two whenever a favourite has been hiked, so
  // summing every list would double-count the same kilometres. The three system lists are
  // the honest denominator: what you keep, what you mean to do, what you have done.
  const hiked = lists.find((list) => list.kind === 'completed');

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="lists" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <p className="collar">
          {viewer.username ? `@${viewer.username}` : (viewer.name ?? 'Your record')}
        </p>
        <h1 className="mt-md text-h3 font-bold">Lists</h1>

        {hiked && hiked.trailCount > 0 ? (
          <p className="mt-md max-w-measure font-text text-body-lg text-ink-muted">
            <span className="font-mono text-body text-ink">{hiked.trailCount}</span>{' '}
            {plural(hiked.trailCount, 'hike')} on the record,{' '}
            <span className="font-mono text-body text-ink">
              {formatDistance(hiked.totalLengthM, viewer.units)}
            </span>{' '}
            and{' '}
            <span className="font-mono text-body text-ink">
              ↑{formatElevation(hiked.totalGainM, viewer.units)}
            </span>{' '}
            of it uphill.
          </p>
        ) : (
          <p className="mt-md max-w-measure font-text text-body-lg text-ink-muted">
            Three shelves to start with. Ring what is worth going back to, flag what is still ahead,
            and tick a trail off the day you hike it.
          </p>
        )}

        <section className="mt-2xl">
          <h2 className="collar">Kept for you</h2>
          <ul className="mt-md grid gap-md sm:grid-cols-2">
            {lists
              .filter((list) => list.kind !== 'custom')
              .map((list) => (
                <ListCard key={list.id} list={list} />
              ))}
          </ul>
        </section>

        <section className="mt-3xl">
          <div className="flex flex-wrap items-center justify-between gap-md">
            <h2 className="collar">Your own</h2>
            <NewList count={custom.length} />
          </div>

          {custom.length === 0 ? (
            <p className="mt-md max-w-measure font-text text-body text-ink-muted">
              A list is for a set with a reason behind it — winter scrambles, hikes the dog can do,
              everything within an hour of home. The three above cannot say that.
            </p>
          ) : (
            <ul className="mt-md grid gap-md sm:grid-cols-2">
              {custom.map((list) => (
                <ListCard key={list.id} list={list} />
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
