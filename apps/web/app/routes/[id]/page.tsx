import type { Metadata } from 'next';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { TRPCError } from '@trpc/server';
import type { PlannedRouteDetail } from '@switchback/core';
import {
  ACTIVITY_TYPE_LABELS,
  BRAND,
  DIFFICULTY_LABELS,
  classifyDifficulty,
  formatDistance,
  formatElevation,
  formatTimeOnFoot,
  plural,
} from '@switchback/core';
import { RouteActions } from '@/components/plan/route-actions';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';

/**
 * One route.
 *
 * The reading page for something nobody has hiked yet, which is what separates it from both
 * of its neighbours. A trail page carries reviews, conditions and photographs because people
 * have been there; a hike page carries splits and a clock because somebody did it. This page
 * has neither, and padding it out with empty sections for both would be a page pretending to
 * be a different one.
 *
 * What it has instead is the line, the section, and the three figures — which is exactly what
 * a plan is for. Everything else on the page is a way out of it: back to the list, into the
 * planner, or into a GPX file on a handheld.
 *
 * **A route that is not public never reaches an index.** The same rule as a private hike, and
 * a stronger reason: a route is where somebody intends to *be*, at a time they have not
 * decided yet.
 */

const RouteView = dynamic(() =>
  import('@/components/plan/route-view').then((mod) => mod.RouteView),
);

interface PageProps {
  params: Promise<{ id: string }>;
}

async function loadRoute(id: string): Promise<PlannedRouteDetail | null> {
  try {
    return await caller.routes.detail({ id });
  } catch (error) {
    if (
      error instanceof TRPCError &&
      (error.code === 'NOT_FOUND' || error.code === 'FORBIDDEN' || error.code === 'UNAUTHORIZED')
    ) {
      // A route somebody may not see and a route that does not exist are the same answer.
      // Anything else would let a stranger enumerate which ids are real.
      return null;
    }
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const route = await loadRoute(id);
  if (!route) return { title: 'Route not found' };

  const units = await viewerUnits();

  return {
    title: route.name,
    description: `${formatDistance(route.stats.lengthM, units)}, ${formatElevation(route.stats.gainM, units)} of ascent. ${BRAND.tagline}`,
    ...(route.visibility === 'public' ? {} : { robots: { index: false, follow: false } }),
  };
}

export default async function RoutePage({ params }: PageProps) {
  const { id } = await params;
  const [route, units] = await Promise.all([loadRoute(id), viewerUnits()]);
  if (!route) notFound();

  const band = classifyDifficulty({
    gainM: route.stats.gainM,
    lengthM: route.stats.lengthM,
    maxSustainedGrade: route.stats.maxSustainedGrade,
  });

  return (
    <div data-scheme="sheet" className="min-h-dvh bg-canvas text-ink">
      <header className="mx-auto flex max-w-rail items-center justify-between px-xl py-lg">
        <Wordmark />
        <SiteNav current="plan" />
      </header>

      <main className="mx-auto max-w-rail px-xl pb-5xl">
        <p className="collar flex flex-wrap items-center gap-x-md gap-y-xs">
          {route.editable ? (
            <Link href="/routes" className="rounded-hair hover:text-ink">
              ← Your routes
            </Link>
          ) : route.owner.name ? (
            <span>Drawn by {route.owner.name}</span>
          ) : (
            <span>A route</span>
          )}
          <span>{ACTIVITY_TYPE_LABELS[route.activityType]}</span>
          <span>
            {route.anchorCount} {plural(route.anchorCount, 'point')}
          </span>
          <span>{DIFFICULTY_LABELS[band.difficulty]}</span>
        </p>

        <h1 className="mt-md text-h3 font-bold text-balance">{route.name}</h1>

        {/*
         * Said plainly, once, near the top. A drawn line looks like a trail on a map and is
         * not one — that is the single most important fact about this page, and burying it in
         * a footer would be the planner's honesty ending at the moment the route is saved.
         */}
        <p className="mt-sm max-w-measure-wide font-text text-body-lg text-ink-muted">
          A planned route, not a trail. The line follows paths in OpenStreetMap where they exist;
          nobody has confirmed it on the ground.
        </p>

        <div className="mt-xl">
          <RouteView route={route} units={units} />
        </div>

        <dl className="mt-xl grid grid-cols-2 gap-px overflow-hidden rounded-hair border border-bezel bg-bezel sm:grid-cols-3 lg:grid-cols-6">
          <Figure label="Distance" value={formatDistance(route.stats.lengthM, units)} />
          <Figure label="Ascent" value={`↑${formatElevation(route.stats.gainM, units)}`} />
          <Figure label="Descent" value={`↓${formatElevation(route.stats.lossM, units)}`} />
          <Figure label="On foot" value={formatTimeOnFoot(route.stats.estimatedTimeS)} />
          <Figure label="High point" value={formatElevation(route.stats.maxEleM, units)} />
          <Figure label="Low point" value={formatElevation(route.stats.minEleM, units)} />
        </dl>

        {route.description ? (
          <section className="mt-2xl max-w-measure-wide">
            <h2 className="collar">Notes</h2>
            <p className="mt-sm whitespace-pre-wrap font-text text-body-lg leading-relaxed">
              {route.description}
            </p>
          </section>
        ) : null}

        <div className="mt-2xl border-t border-bezel pt-lg">
          <RouteActions route={route} />
        </div>
      </main>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface px-md py-sm">
      <dt className="collar">{label}</dt>
      <dd className="mt-hair font-mono text-title tabular-nums" style={{ lineHeight: '1.3' }}>
        {value}
      </dd>
    </div>
  );
}
