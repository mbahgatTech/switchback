import Link from 'next/link';
import type { ActivitySummary, UnitSystem } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  defaultActivityName,
  formatClock,
  formatDistance,
  formatElevation,
  trailTitle,
} from '@switchback/core';

/**
 * A run of recordings, as rows.
 *
 * Rows rather than cards. A recording has no photograph of its own to lead with — the map
 * thumbnail every other product uses here is a grey rectangle with a squiggle on it, at a
 * size where the squiggle says nothing — and what a reader is actually scanning for is a
 * date and a distance. Both of those are text, and text in rows is faster to scan than text
 * in a grid.
 *
 * The date column is the anchor. Recordings are remembered by *when*, not by what they were
 * called: "the wet one in March" is how the list gets searched, so the date is set in the
 * mono face at the left where a reader's eye can run down it, and the name follows.
 */

export interface ActivityRowsProps {
  activities: readonly ActivitySummary[];
  units: UnitSystem;
  /**
   * Off when the rows are already under the trail's own heading. Repeating the trail name
   * on every row of a trail page says nothing and pushes the activity type out of view.
   */
  showTrail?: boolean;
  className?: string;
}

export function ActivityRows({
  activities,
  units,
  showTrail = true,
  className,
}: ActivityRowsProps) {
  return (
    <ul className={`flex flex-col ${className ?? ''}`}>
      {activities.map((activity) => {
        // The trail as every other screen names it, and as the server named the row when it
        // was stored — see `defaultActivityName` in `routers/activities.ts`.
        const trailName = activity.trail ? trailTitle(activity.trail) : null;
        const title =
          activity.name ??
          defaultActivityName(activity.activityType, activity.startedAt, trailName);
        // A hike named after the trail it is on — which is what the recorder proposes by
        // default — would otherwise print that name twice, once large and once in caps
        // directly beneath it.
        const beneath = showTrail && trailName !== null && trailName !== title ? trailName : null;
        return (
          <li key={activity.id}>
            <Link
              href={`/activities/${activity.id}`}
              className="grid grid-cols-[auto_1fr] items-baseline gap-x-md gap-y-hair border-b border-bezel py-sm transition-colors duration-quick ease-standard hover:border-ink-muted sm:grid-cols-[7ch_1fr_auto]"
            >
              <span className="font-mono text-micro tabular-nums text-ink-muted">
                {shortDate(activity.startedAt)}
              </span>

              <span className="min-w-0">
                <span className="block truncate text-body text-ink">{title}</span>
                <span className="collar mt-hair block">
                  {ACTIVITY_TYPE_LABELS[activity.activityType]}
                  {beneath ? ` · ${beneath}` : ''}
                  {activity.visibility === 'private' ? ' · only you' : ''}
                </span>
              </span>

              {/*
               * Distance, ascent, moving time — in that order everywhere in the product.
               * Wraps under the name on a phone rather than shrinking, because these three
               * are the reason the row is being read.
               */}
              <span className="col-span-2 flex shrink-0 items-baseline gap-md font-mono text-micro tabular-nums text-ink-muted sm:col-span-1">
                <span>{formatDistance(activity.distanceM, units)}</span>
                <span>↑{formatElevation(activity.gainM, units)}</span>
                <span>{formatClock(activity.movingTimeS)}</span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** `27 Jul` or `27 Jul 25` — the year appears only once the hike is not from this one. */
function shortDate(at: Date): string {
  const thisYear = at.getFullYear() === new Date().getFullYear();
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(thisYear ? {} : { year: '2-digit' }),
  });
}
