import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SettingsForm } from '@/components/profile/settings-form';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { caller } from '@/trpc/server';

/**
 * Settings.
 *
 * Only what this product actually stores. There is no notifications section because nothing
 * sends notifications yet, and no data-export section because the export lives on each
 * activity where the thing being exported is. A settings page padded out with controls that
 * do nothing is how a product starts lying about what it is.
 *
 * Visibility of the completed list is deliberately not here. It is a per-list switch on the
 * list's own page, and duplicating it would give one fact two controls that can disagree —
 * the line below points at the real one instead.
 */

export const metadata: Metadata = {
  title: 'Settings',
  robots: { index: false, follow: false },
};

export default async function SettingsPage() {
  const me = await caller.me.get();
  if (!me) redirect(`/signin?callbackUrl=${encodeURIComponent('/settings')}`);

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="profile" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <p className="collar">
          <Link href="/profile" className="rounded-hair hover:text-ink">
            ← Your record
          </Link>
        </p>
        <h1 className="mt-md text-h3 font-bold">Settings</h1>
        <p className="mt-md max-w-measure font-text text-body-lg text-ink-muted">
          Signed in as{' '}
          <span className="font-mono text-body text-ink">{me.email ?? 'no email'}</span>
          {me.isPlus ? ' · Plus' : ''}. Sign-in is handled by your identity provider, so there is no
          password here to change.
        </p>

        <SettingsForm me={me} />

        {/*
         * Two pointers, not two controls. Both name a fact this page stores nothing about —
         * one lives on a list, the other on this device — and a copy of either here would be
         * a second switch that can disagree with the first.
         */}
        <p className="collar mt-3xl border-t border-bezel pt-lg">
          Who can see the hikes you have ticked off is set on{' '}
          <Link href="/lists/completed" className="text-ink underline underline-offset-4">
            the completed list itself
          </Link>
          .
        </p>
        <p className="collar mt-sm">
          What you have taken offline is kept on this device, not on your account, and is managed
          under{' '}
          <Link href="/downloads" className="text-ink underline underline-offset-4">
            downloads
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
