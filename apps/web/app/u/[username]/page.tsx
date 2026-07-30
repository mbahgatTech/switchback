import { cache } from 'react';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import type { HikerProfile } from '@switchback/core';
import { BRAND, formatDistance, plural } from '@switchback/core';
import { ActivityRows } from '@/components/activity/activity-rows';
import { Hiker } from '@/components/profile/hiker';
import { YourPhotographs } from '@/components/profile/photographs';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';

/**
 * One hiker's public page.
 *
 * Server-rendered and linkable without an account, because a profile that only signed-in
 * people can open is a profile nobody can send to anyone — and the reason to have a page
 * per hiker at all is so a trail report has an author you can look up.
 *
 * The reader's own units, not the hiker's. Somebody's record is a set of measurements, and
 * measurements belong in whatever the person reading them thinks in.
 */

interface PageProps {
  params: Promise<{ username: string }>;
}

/**
 * `generateMetadata` and the page body both need the same profile, and Next calls them
 * separately. `cache` collapses that into one query per request.
 */
const load = cache(async (username: string): Promise<HikerProfile | null> => {
  try {
    return await caller.users.byUsername({ username });
  } catch (error) {
    if (error instanceof TRPCError && error.code === 'NOT_FOUND') return null;
    throw error;
  }
});

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { username } = await params;
  const hiker = await load(username);
  if (!hiker) return { title: 'No such hiker' };

  const name = hiker.profile.name ?? `@${hiker.profile.username ?? username}`;
  const { hikes, lengthM } = hiker.stats;
  const units = await viewerUnits();

  return {
    title: name,
    description:
      hikes > 0
        ? `${hikes} ${plural(hikes, 'hike')} and ${formatDistance(lengthM, units)} on the record. ${BRAND.tagline}`
        : `${name} on ${BRAND.name}. ${BRAND.tagline}`,
    // A profile is a person, and a person who has published nothing should not be findable
    // by searching for their name. Indexed once there is something on the page to index.
    robots: hikes > 0 ? undefined : { index: false, follow: false },
    openGraph: { title: name, type: 'profile' },
  };
}

export default async function HikerPage({ params }: PageProps) {
  const { username } = await params;
  const [hiker, units] = await Promise.all([load(username), viewerUnits()]);
  if (!hiker) notFound();

  // Public recordings only — `activities.byUser` enforces that server-side, including when
  // the reader is the hiker, so this section shows what everyone else sees.
  const recordings = await caller.activities.byUser({ username, limit: 10 });

  /*
   * Your own frames, and only on your own page. `photos.mine` is the one query that returns
   * a photograph a moderator took down, which is how the uploader is told rather than left
   * to notice a gap — see `components/profile/photographs.tsx`. A stranger reading this page
   * gets nothing extra: the fetch does not happen at all unless the page is yours.
   */
  const photographs = hiker.isMe ? await caller.photos.mine({ limit: 24 }) : [];

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current={hiker.isMe ? 'profile' : undefined} />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <Hiker hiker={hiker} units={units} now={new Date()} />

        <YourPhotographs photographs={photographs} />

        {recordings.items.length > 0 ? (
          <section className="mt-3xl">
            <h2 className="collar">
              Recordings{recordings.total > recordings.items.length ? ' · most recent' : ''}
            </h2>
            <ActivityRows activities={recordings.items} units={units} className="mt-md" />
          </section>
        ) : null}
      </main>
    </div>
  );
}
