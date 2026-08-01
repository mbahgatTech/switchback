import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { HikerProfile } from '@switchback/core';
import { BRAND } from '@switchback/core';
import { Hiker } from '@/components/profile/hiker';
import { YourPhotographs } from '@/components/profile/photographs';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { caller } from '@/trpc/server';

/**
 * Your own record.
 *
 * Mostly a redirect. Once you have a username your profile lives at `/u/<name>` and that is
 * the page you should be looking at, because the page you can send someone is the page whose
 * contents you need to know. Keeping a private mirror of it here would mean two layouts to
 * hold in step, and the failure mode is publishing something you never saw.
 *
 * What stays here is the case that URL cannot cover: an account created by clicking "Sign in
 * with Microsoft" that has never chosen a handle. It has a record and no address, so it gets
 * the same page at a fixed URL, with the one thing missing named at the top of it.
 */

export const metadata: Metadata = {
  title: 'Your record',
  description: `Everything you have hiked. ${BRAND.tagline}`,
  robots: { index: false, follow: false },
};

export default async function ProfilePage() {
  const viewer = await caller.me.get();
  if (!viewer) redirect(`/signin?callbackUrl=${encodeURIComponent('/profile')}`);
  if (viewer.username) redirect(`/u/${viewer.username}`);

  const [stats, lists, photographs] = await Promise.all([
    caller.me.stats(),
    caller.lists.mine(),
    // Including any a moderator took down — this and your own `/u/<name>` are the two places
    // the uploader is told. See `components/profile/photographs.tsx`.
    caller.photos.mine({ limit: 24 }),
  ]);
  const completed = lists.find((list) => list.kind === 'completed');

  const hiker: HikerProfile = {
    profile: {
      id: viewer.id,
      username: null,
      name: viewer.name,
      image: viewer.image,
      bio: viewer.bio,
      createdAt: viewer.createdAt,
    },
    stats,
    // Same rule the public page uses: the completed list is the headline already, so it is
    // not repeated as a card underneath itself.
    lists: lists
      .filter((list) => list.kind !== 'completed')
      .map((list) => ({
        id: list.id,
        name: list.name,
        slug: list.slug,
        kind: list.kind,
        trailCount: list.trailCount,
        totalLengthM: list.totalLengthM,
        coverPhotoUrl: list.coverPhotoUrl,
      })),
    hikesVisible: true,
    completedKey: completed?.slug ?? null,
    isMe: true,
  };

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="profile" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        {/*
         * Stated plainly and once, at the top, because it is the only thing standing between
         * this page and a real address. Not a banner and not a modal — a line of the same
         * collar text everything else on the page is labelled with.
         */}
        <p className="collar mb-lg border-b border-bezel pb-md">
          This page has no public address yet.{' '}
          <Link href="/settings" className="text-ink underline underline-offset-4">
            Choose a username
          </Link>{' '}
          and it becomes /u/yourname.
        </p>

        <Hiker hiker={hiker} units={viewer.units} now={new Date()} />

        <YourPhotographs photographs={photographs} />
      </main>
    </div>
  );
}
