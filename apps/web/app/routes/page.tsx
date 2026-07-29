import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { PlannedRouteSummary, UnitSystem } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  BRAND,
  formatDistance,
  formatElevation,
  formatTimeOnFoot,
  plural,
} from '@switchback/core';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { caller } from '@/trpc/server';
import { BUTTON_COLLAR, HEIGHT, OUTLINE, PRIMARY } from '@/components/controls';

/**
 * The routes you have drawn.
 *
 * A third kind of thing, and the reason it gets its own page rather than a tab on one of the
 * other two: a trail is a line somebody else hiked, a recording is a line you hiked, and a
 * route is a line nobody has hiked yet. Only the last one is a plan, and a plan is read for
 * different reasons — usually the night before, usually while deciding.
 *
 * **The name leads, not the date.** `/activities` puts the date in the left column because a
 * recording is remembered by when it happened; a route is remembered by where it goes, and
 * "Cwm Idwal horseshoe" finds itself in a list faster than "12 Mar" ever will. The date is
 * still here, in the collar, where the question it answers ("is this the version I fixed?")
 * gets asked.
 */

export const metadata: Metadata = {
  title: 'Your routes',
  description: `Routes you have drawn, with distance, ascent, and time on foot. ${BRAND.tagline}`,
  robots: { index: false, follow: false },
};

export default async function RoutesPage() {
  const viewer = await caller.me.get();
  if (!viewer) redirect(`/signin?callbackUrl=${encodeURIComponent('/routes')}`);

  const routes = await caller.routes.mine();

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="plan" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <p className="collar flex flex-wrap items-center gap-x-md gap-y-xs">
          <Link href="/profile" className="rounded-hair hover:text-ink">
            ← Your record
          </Link>
          {routes.length > 0 ? (
            <span>
              {routes.length} {plural(routes.length, 'route')}
            </span>
          ) : null}
        </p>

        <div className="mt-md flex flex-wrap items-baseline justify-between gap-md">
          <h1 className="text-h3 font-bold">Routes</h1>
          {routes.length > 0 ? (
            <Link href="/plan" className={`${BUTTON_COLLAR} ${OUTLINE} ${HEIGHT.touch} px-lg`}>
              Plan a route
            </Link>
          ) : null}
        </div>

        {routes.length === 0 ? (
          <div className="mt-xl max-w-measure">
            <p className="font-text text-body-lg text-ink-muted">
              Nothing drawn yet. Click your way along a ridge and the line will follow whatever
              paths are actually there — and say so plainly wherever there are none.
            </p>
            <Link
              href="/plan"
              className={`${BUTTON_COLLAR} ${PRIMARY} ${HEIGHT.touch} mt-lg px-lg`}
            >
              Plan a route
            </Link>
          </div>
        ) : (
          <ul className="mt-lg flex flex-col">
            {routes.map((route) => (
              <li key={route.id}>
                <RouteRow route={route} units={viewer.units} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function RouteRow({ route, units }: { route: PlannedRouteSummary; units: UnitSystem }) {
  return (
    <Link
      href={`/routes/${route.id}`}
      className="grid grid-cols-1 items-baseline gap-x-md gap-y-hair border-b border-bezel py-sm transition-colors duration-quick ease-standard hover:border-ink-muted sm:grid-cols-[1fr_auto]"
    >
      <span className="min-w-0">
        <span className="block truncate text-body text-ink">{route.name}</span>
        <span className="collar mt-hair block">
          {ACTIVITY_TYPE_LABELS[route.activityType]}
          {' · '}
          {route.anchorCount} {plural(route.anchorCount, 'point')}
          {route.visibility === 'private' ? ' · only you' : ''}
          {' · '}
          {shortDate(route.updatedAt)}
        </span>
      </span>

      {/* Distance, ascent, time — the same three figures in the same order as everywhere else. */}
      <span className="flex shrink-0 items-baseline gap-md font-mono text-micro tabular-nums text-ink-muted">
        <span>{formatDistance(route.stats.lengthM, units)}</span>
        <span>↑{formatElevation(route.stats.gainM, units)}</span>
        <span>{formatTimeOnFoot(route.stats.estimatedTimeS)}</span>
      </span>
    </Link>
  );
}

/** `12 Mar` or `12 Mar 25` — the year appears only once the route is not from this one. */
function shortDate(iso: string): string {
  const at = new Date(iso);
  const thisYear = at.getFullYear() === new Date().getFullYear();
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(thisYear ? {} : { year: '2-digit' }),
  });
}
