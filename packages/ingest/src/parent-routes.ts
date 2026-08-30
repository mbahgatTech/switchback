/**
 * The lookup that finds the long-distance routes a tile's trails turn out to be sections of.
 * It reads the tile query's answer, so it starts after assembly — and nothing else does.
 */

import { JobKind } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import type { AssembledTrail } from './assemble';
import { enqueue, routeIngestJobKey } from './jobs';
import { OVERPASS_SKIPPED_MARKER, buildParentRouteQuery } from './overpass';
import type { OverpassQuerier, OverpassRelation, OverpassResponse } from './overpass';

/**
 * What this lookup needs, which is much less than `PipelineDeps` — declared here rather than
 * imported so the dependency runs one way, from the pipeline to its lookups.
 */
export interface ParentRouteDeps {
  /** The shared client, or a `withDeadline` view of it — never a second client. */
  overpass: OverpassQuerier;
  /**
   * The view bounded by the handler's own deadline instead of the pre-commit reserve. This query
   * runs alongside the commit loop and may outlast it, so the reserve protects nothing here.
   * Defaults to `overpass`.
   */
  overpassToHandlerDeadline?: OverpassQuerier;
  logger?: (message: string, detail?: Record<string, unknown>) => void;
}

/** A lookup already in flight, and the enqueue that finishes it. */
export interface ParentRouteDiscovery {
  /**
   * Await the answer and queue an ingest job for each superroute it names. Swallows its own
   * failures: the result is strictly additive, and failing the tile would re-run the expensive
   * half to retry the cheap half. A caller that abandons the tile may simply never call this.
   */
  settle(): Promise<void>;
}

/**
 * Ask which routes contain the relations this tile assembled, without waiting for the answer.
 *
 * Handed to the client before the commit loop rather than after it, so the round trip — 3.0 to
 * 54.5 s per tile, measured off a workstation against the live mirrors — spends the loop's wall
 * clock instead of the tile's own. It takes
 * one of the two slots an instance allots an IP while the loop holds none, and it is the only
 * Overpass request a tile makes past its context lookups.
 *
 * **Sending it early is what costs a request.** `withDeadline` refuses synchronously at hand-over,
 * so a query handed over after the loop is never reached on a tile that abandons it — a deadline
 * split, a deadline failure at the zoom floor, a trail lost on its own account — while this one is
 * already in flight. Those three paths each send one request the serial shape sent none of, and no
 * path can send more than one.
 */
export function startParentRouteDiscovery(
  db: PrismaClient,
  assembled: readonly AssembledTrail[],
  deps: ParentRouteDeps,
): ParentRouteDiscovery {
  const relationIds = assembled.filter((t) => t.osmType === 'relation').map((t) => t.osmId);
  if (relationIds.length === 0) return { settle: () => Promise.resolve() };

  const log = deps.logger ?? (() => {});
  const overpass = deps.overpassToHandlerDeadline ?? deps.overpass;
  const answer = overpass.query(buildParentRouteQuery(relationIds));
  // A tile that splits or fails never settles this, and an abandoned rejection is an unhandled
  // one. Attached at hand-over so no early return the commit loop can take is left carrying it.
  answer.catch(() => {});

  return { settle: () => queueSuperroutes(db, answer, log) };
}

async function queueSuperroutes(
  db: PrismaClient,
  answer: Promise<OverpassResponse>,
  log: (message: string, detail?: Record<string, unknown>) => void,
): Promise<void> {
  try {
    const response = await answer;
    const parents = (response.elements ?? []).filter(
      (element): element is OverpassRelation => element.type === 'relation',
    );

    for (const parent of parents) {
      // `type=superroute` means "this relation's members are routes". A plain `type=route`
      // parent is a section container tiles already ingest by bbox.
      if (parent.tags?.type !== 'superroute') continue;
      if (!(parent.tags.name ?? parent.tags['name:en'])) continue;

      await enqueue(db, {
        kind: JobKind.ingest_route,
        dedupeKey: routeIngestJobKey(parent.id),
        payload: { osmId: parent.id },
        // Below tile work: somebody is waiting on the tile under their cursor, nobody is
        // waiting on a continental route, and it is the most expensive job we run.
        priority: -10,
      });
      log('queued route', { osmId: parent.id, name: parent.tags.name });
    }
  } catch (error) {
    log(`${OVERPASS_SKIPPED_MARKER} parent route lookup failed`, { error: String(error) });
  }
}
