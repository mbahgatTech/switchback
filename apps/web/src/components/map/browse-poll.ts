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
 * Every list a tile can be outstanding in, and there are three. A tile past its TTL lands in
 * `refreshingTiles` rather than `pendingTiles`, and a `tooLarge` viewport queues nothing at all —
 * so a poll gated on `pendingTiles` alone leaves both to the next reload.
 *
 * `busy` excludes the refresh because backpressure refuses new ground without emptying
 * `refreshingTiles`: those quadkeys have no job, and polling for them would aim a request every
 * `BROWSE_POLL_MS` from every open map at a database that just said it had no room. It is the
 * reason refused tiles are kept out of `pendingTiles` upstream. The cost is that a refresh already
 * in flight when the ceiling closes is not polled for either — `ensureCoverage` narrows only
 * `pendingTiles` to what is still coming, so the client cannot tell the two apart.
 */
export function browsePollInterval(data: BrowseProgress | undefined): number | false {
  if (!data) return false;
  const { coverage } = data;
  const moving =
    coverage.pendingTiles.length > 0 ||
    (!coverage.busy && coverage.refreshingTiles.length > 0) ||
    (data.area?.working ?? 0) > 0;
  return moving ? BROWSE_POLL_MS : false;
}
