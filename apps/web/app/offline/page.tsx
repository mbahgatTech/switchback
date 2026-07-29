import type { Metadata } from 'next';
import Link from 'next/link';
import { OfflineTrails } from '@/components/offline/offline-trails';
import { Wordmark } from '@/components/wordmark';
import { BUTTON_COLLAR, HEIGHT, SECONDARY } from '@/components/controls';

/**
 * Where a navigation goes when there is no network and no cached copy of the page asked for.
 *
 * Written for the moment it appears in: a phone held at arm's length on a hillside, out of
 * signal, having tapped something that cannot load. So it says what happened in one line, and
 * then does the only useful thing left — lists what *is* readable, in one press each.
 *
 * The heading and the message are server-rendered and the list is an enhancement, because
 * this page is precached as HTML at install time and its JavaScript may not be. A blank
 * screen here would be the worst possible failure: the offline fallback failing offline.
 */

export const metadata: Metadata = {
  title: 'Offline',
  description: 'No connection. Downloaded trails are still readable.',
};

export default function OfflinePage() {
  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-[720px] items-center px-xl py-lg">
        <Wordmark />
      </header>

      <main className="mx-auto max-w-[720px] px-xl pb-5xl">
        {/* Water is the conditions plate, and no signal is a condition. */}
        <p className="collar text-water">No connection</p>
        <h1 className="mt-md text-h3 font-bold">This page was not downloaded</h1>
        <p className="mt-md max-w-measure font-text text-body-lg text-ink-muted">
          Everything you took offline is still here and still works. Anything else has to wait for a
          signal.
        </p>

        <OfflineTrails />

        <Link
          href="/downloads"
          className={`${BUTTON_COLLAR} ${SECONDARY} ${HEIGHT.touch} mt-2xl px-md`}
        >
          Manage downloads
        </Link>
      </main>
    </div>
  );
}
