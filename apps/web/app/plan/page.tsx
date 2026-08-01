import type { Metadata } from 'next';
import { BRAND, type RouteAnchor } from '@switchback/core';
import { OsmCredit, OsmCreditBeside } from '@/components/map/osm-credit';
import { Planner } from '@/components/plan/planner';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
import { placeCamera, viewerPlace } from '@/lib/place';
import { viewerUnits } from '@/lib/units';
import { caller } from '@/trpc/server';

/**
 * Draw a route: the shell, plus the four facts the planner cannot work out itself — units, opening
 * camera, whether there is anyone to save for, and whether this is a blank sheet or a reopen.
 *
 * Planning works signed out; only saving needs an account. `?route=<id>` reopens a saved route,
 * and ownership decides which: the owner edits in place, anyone else gets the anchors as a
 * template and saving makes a route of their own.
 */

export const metadata: Metadata = {
  title: 'Plan a route',
  description: `Draw a line and have it follow the paths that are actually there — distance, ascent, and an honest note wherever there is no path at all. ${BRAND.tagline}`,
};

/**
 * Only the saved-route branch needs a number of its own — a stored centroid is a known
 * coordinate, so it gets the zoom where a valley fits. The blank sheet takes its whole camera
 * from `lib/place.ts`, so the planner cannot open on a different continent from the map the
 * reader just came from. There is a floor at all because "click to drop a point" means nothing
 * at a world view.
 */
const ROUTE_ZOOM = 11;

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ route?: string }>;
}) {
  const { route: routeId } = await searchParams;

  // None depends on the others, and `viewerPlace()` is a cookie-and-header read with no I/O.
  const [viewer, saved, place] = await Promise.all([
    caller.me.get(),
    routeId ? caller.routes.detail({ id: routeId }).catch(() => null) : Promise.resolve(null),
    viewerPlace(),
  ]);

  const units = await viewerUnits();
  const opening = placeCamera(place);
  const anchors: readonly RouteAnchor[] = saved?.anchors ?? [];

  // Only an owned route is edited; anything else with anchors opens as an unnamed copy.
  const editing =
    saved && saved.editable
      ? {
          id: saved.id,
          name: saved.name,
          description: saved.description ?? '',
          activityType: saved.activityType,
          visibility: saved.visibility,
        }
      : null;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
      {/* Off-screen, for the same reason as the one on `/explore` — see the note there. */}
      <h1 className="sr-only">{editing ? `Edit ${editing.name}` : 'Plan a route'}</h1>

      <header className="flex h-3xl shrink-0 items-center justify-between gap-lg border-b border-bezel px-lg">
        <Wordmark />

        {/*
          The route is drawn on OSM's ways and follows OSM's network. ODbL wants the credit
          on the screen that shows the data, and this screen shows more of it than any other.

          `plan-map.tsx` sets `attributionControl: false`, so this link is the whole credit
          here — which is why it goes through `beside` and not `extra`. Routing it into the
          disclosure was argued at the time as a strict improvement on the `hidden … sm:inline`
          it replaced, on the grounds that the old class meant no credit at all below 640px.
          Half right: below 640px it was an improvement, and from 640 to 1279 — every tablet
          and most laptop windows — it took a credit that was rendered and stopped rendering
          it. `beside` shows it at every width, long-form wherever it fits.
        */}
        <SiteNav current="plan" beside={<OsmCreditBeside />} extra={<OsmCredit />} />
      </header>

      {/* The landmark, for the reason given in `components/explore/explore-shell.tsx`. */}
      <main className="contents">
        <Planner
          units={units}
          defaultVisibility={viewer?.defaultActivityVisibility ?? 'private'}
          viewerId={viewer?.id ?? null}
          initialCenter={saved ? saved.centroid : opening.center}
          initialZoom={saved ? ROUTE_ZOOM : opening.zoom}
          initialAnchors={anchors}
          editing={editing}
        />
      </main>
    </div>
  );
}
