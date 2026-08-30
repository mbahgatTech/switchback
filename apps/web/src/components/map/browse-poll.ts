/**
 * How often an in-progress `trails.browse` is re-asked. Shared by the explore sheet and the
 * embedded map, which otherwise disagree about what "still moving" means.
 */

import type { AreaSummary, TileCoverage } from '@switchback/core';

/**
 * A poll, not the SSE stream the plan sketches: with a cap of twelve tiles per viewport, a stream
 * would cost a long-lived connection and a held-open serverless function per open map to carry a
 * handful of messages.
 */
export const BROWSE_POLL_MS = 2_500;

/** The part of a `trails.browse` response the poll decision reads. */
export interface BrowseProgress {
  coverage: TileCoverage;
  area?: AreaSummary | null;
}

/**
 * `area.working` is read separately from `pendingTiles` because a wide viewport is `tooLarge` —
 * `ensureCoverage` queues nothing and `pendingTiles` is empty by construction, however much work
 * the button just started.
 */
export function browsePollInterval(data: BrowseProgress | undefined): number | false {
  if (!data) return false;
  const moving = data.coverage.pendingTiles.length > 0 || (data.area?.working ?? 0) > 0;
  return moving ? BROWSE_POLL_MS : false;
}
