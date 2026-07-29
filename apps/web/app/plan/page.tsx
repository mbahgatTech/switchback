import type { Metadata } from 'next';
import { ATTRIBUTION, BRAND, type RouteAnchor } from '@switchback/core';
import { Planner } from '@/components/plan/planner';
import { SiteNav } from '@/components/site-nav';
import { Wordmark } from '@/components/wordmark';
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
 * Where the map opens when nothing else decides it.
 *
 * Snowdon, at the zoom where a valley fits — the same view Explore opens on, because a reader
 * moving between the two screens should not have the ground move underneath them. A planner
 * that opened on a world view would ask its first question ("click to drop a point") at a
 * scale where no click means anything.
 */
const INITIAL_CENTER: readonly [number, number] = [-4.05, 53.07];
const INITIAL_ZOOM = 11;

export default async function PlanPage({
  searchParams,
}: {
  searchParams: Promise<{ route?: string }>;
}) {
  const { route: routeId } = await searchParams;

  // Neither depends on the other, and a cold route fetch should not sit behind the session.
  const [viewer, saved] = await Promise.all([
    caller.me.get(),
    routeId ? caller.routes.detail({ id: routeId }).catch(() => null) : Promise.resolve(null),
  ]);

  const units = await viewerUnits();
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
        */}
        <span className="collar flex items-center gap-md">
          <SiteNav current="plan" />
          <a href={ATTRIBUTION.osm.href} className="hidden rounded-hair hover:text-ink sm:inline">
            {ATTRIBUTION.osm.label}
          </a>
        </span>
      </header>

      <Planner
        units={units}
        defaultVisibility={viewer?.defaultActivityVisibility ?? 'private'}
        viewerId={viewer?.id ?? null}
        initialCenter={saved ? saved.centroid : INITIAL_CENTER}
        initialZoom={INITIAL_ZOOM}
        initialAnchors={anchors}
        editing={editing}
      />
    </div>
  );
}
