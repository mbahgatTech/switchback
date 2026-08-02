'use client';

/**
 * What you can still open.
 *
 * The list on the offline screen, kept deliberately plain: names, sizes, and a link each.
 * Somebody reading this is holding a phone with no signal, and the only useful thing this
 * page can do is get them into a trail in one press.
 */

import Link from 'next/link';
import { formatBytes, formatDistance, formatElevation, trailTitle } from '@switchback/core';
import { useUnits } from '@/components/units';
import { useDownloads } from '@/offline/use-offline';

export function OfflineTrails() {
  const { trails, loading } = useDownloads();
  const units = useUnits();

  if (loading) return null;

  if (trails.length === 0) {
    return (
      <p className="mt-xl max-w-measure font-text text-body text-ink-muted">
        Nothing is downloaded on this device. Once there is a connection again, open a trail and
        press <span className="text-ink">Take offline</span> — it will still be here the next time
        there is no signal.
      </p>
    );
  }

  return (
    <section className="mt-2xl">
      <h2 className="collar">Downloaded, and still readable</h2>
      <ul className="mt-md divide-y divide-bezel border-y border-bezel">
        {trails.map((row) => (
          <li key={row.trailId}>
            <Link
              href={`/trails/${row.slug}`}
              className="flex flex-wrap items-baseline gap-x-lg gap-y-xs rounded-hair py-md hover:text-woodland"
            >
              <span className="font-text text-body-lg">{trailTitle(row)}</span>
              <span className="collar">
                {row.regionName ? `${row.regionName} · ` : ''}
                {formatDistance(row.lengthM, units)} · ↑{formatElevation(row.gainM, units)}
              </span>
              <span className="ml-auto font-mono text-caption text-ink-muted">
                {formatBytes(row.bytes)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
