import type { Metadata } from 'next';
import { BRAND } from '@switchback/core';
import { DownloadsManager } from '@/components/offline/downloads-manager';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';

/**
 * Downloads.
 *
 * In the nav, sixth and last — after the four things the product is for, and after the account.
 * The note that used to sit here argued the other way: that a maintenance screen has no place
 * beside them, and that a profile, the offline screen and the home-screen shortcut are where
 * somebody looks for it. It was right about the ordering and wrong about the conclusion. This
 * is the page a hiker opens at a trailhead with no signal to check what came down with them,
 * and it cannot be three taps behind `/settings`. Last in the row is where a maintenance screen
 * belongs; absent from the row is not.
 *
 * No `caller`, no session check, nothing awaited: what is downloaded lives on the device, in
 * IndexedDB, and is nobody's business but this browser's. The page is a server shell around
 * a client component for exactly that reason.
 */

export const metadata: Metadata = {
  title: 'Downloads',
  description: `Trails kept on this device, and what they cost. ${BRAND.tagline}`,
};

export default function DownloadsPage() {
  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="downloads" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <p className="collar">On this device</p>
        <h1 className="mt-md text-h3 font-bold">Downloads</h1>
        <p className="mt-md max-w-measure font-text text-body-lg text-ink-muted">
          A downloaded trail keeps its page, its route, its waypoints and the map along the line —
          enough to hike it with the phone in flight mode.
        </p>

        <DownloadsManager />
      </main>
    </div>
  );
}
