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
 * Draw a route.
 *
 * The shell, and nothing else — chrome, licence line, and the four facts the planner cannot
 * work out for itself: which units to speak, where the camera opens, whether there is anyone
 * to save for, and whether this is a blank sheet or a route being reopened.
 *
 * **Signing in is not required to plan.** Everything except saving works signed out, which is
 * the difference between a tool and a funnel: somebody working out whether a col is walkable
 * on a borrowed laptop should get the answer, not a wall. The one action that needs an
 * account offers a link to sign in rather than a button that fails.
 *
 * `?route=<id>` reopens a saved route. Two cases, and they are not the same one:
 *
 * - **The viewer owns it** — the anchors come back with the route's name and audience, and
 *   saving updates the route in place.
 * - **Somebody else's, visible to them** — the anchors come back on their own. The line is a
 *   starting point they can move, and saving makes a route of their own rather than editing
 *   a stranger's. A shared route being a template is the useful behaviour; a shared route
 *   being editable is a bug with a lawsuit attached.
 */

export const metadata: Metadata = {
  title: 'Plan a route',
  description: `Draw a line and have it follow the paths that are actually there — distance, ascent, and an honest note wherever there is no path at all. ${BRAND.tagline}`,
};

/**
 * How close a reopened route sits.
 *
 * Only the saved-route branch below still needs a number of its own: a stored centroid is a
 * known coordinate, as good as a fix, so it gets the zoom where a valley fits. The blank-sheet
 * branch takes its whole camera from `lib/place.ts` instead — the reader's own place, or
 * Seattle — because the alternative is a planner that opens on a different continent from the
 * map the reader just came from. That invariant is the one this page has always claimed, and
 * it used to be spelled as a copy of Explore's Snowdon constant; now it is spelled by both
 * screens asking the same function. A planner that opened on a world view would ask its first
 * question ("click to drop a point") at a scale where no click means anything, which is why
 * there is a floor here at all.
 */
const ROUTE_ZOOM = 11;

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ route?: string }>;
}) {
  const { route: routeId } = await searchParams;

  // None depends on the others, and a cold route fetch should not sit behind the session.
  // `viewerPlace()` is a cookie-and-header read with no I/O, so it joins them for free.
  const [viewer, saved, place] = await Promise.all([
    caller.me.get(),
    routeId ? caller.routes.detail({ id: routeId }).catch(() => null) : Promise.resolve(null),
    viewerPlace(),
  ]);

  const units = await viewerUnits();
  const opening = placeCamera(place);
  const anchors: readonly RouteAnchor[] = saved?.anchors ?? [];

  /*
   * Only an owned route is edited. Everything else that arrives with anchors is a copy in
   * progress, so it opens as an unnamed plan sitting on somebody else's line.
   */
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
