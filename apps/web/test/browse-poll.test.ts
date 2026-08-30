import { describe, expect, it } from 'vitest';
import type { AreaSummary, TileCoverage } from '@switchback/core';
import {
  BROWSE_POLL_MS,
  browsePollInterval,
  type BrowseProgress,
} from '../src/components/map/browse-poll';

/**
 * The interval React Query is handed for `trails.browse`. A poll that stops early strands the
 * reader on whatever the first response held: nothing on the client re-asks by itself, so the
 * trails that land a second later wait for a reload.
 */

/** A settled viewport: every tile ready and fresh, nothing outstanding. */
const SETTLED: TileCoverage = {
  readyTiles: ['021231030'],
  pendingTiles: [],
  refreshingTiles: [],
  tooLarge: false,
  busy: false,
  busyReason: null,
  requiredTiles: 1,
  maxTiles: 12,
};

/** The wide-view survey `browse` returns only when the viewport is `tooLarge`. */
const SURVEY: AreaSummary = {
  tiles: 12,
  fresh: 3,
  outstanding: 9,
  working: 0,
  requiredTiles: 40,
  capped: true,
};

function progress(
  coverage: Partial<TileCoverage>,
  area: AreaSummary | null = null,
): BrowseProgress {
  return { coverage: { ...SETTLED, ...coverage }, area };
}

describe('polling while tiles are still arriving', () => {
  it('re-asks while a tile is being fetched for the first time', () => {
    expect(browsePollInterval(progress({ pendingTiles: ['021231030'] }))).toBe(BROWSE_POLL_MS);
  });

  it('stops once the viewport is covered, rather than polling an idle map forever', () => {
    expect(browsePollInterval(progress({}))).toBe(false);
  });

  it('does not poll before the first response has arrived', () => {
    expect(browsePollInterval(undefined)).toBe(false);
  });
});

describe('polling a viewport too wide to cover automatically', () => {
  /*
   * `ensureCoverage` queues nothing for a `tooLarge` box, so `pendingTiles` is empty however much
   * work the fetch-area button just started. `area.working` is the only sign it is running.
   */
  it('re-asks while a deliberate area fetch is running', () => {
    const coverage = { pendingTiles: [], refreshingTiles: [], tooLarge: true };
    const running = { ...SURVEY, working: 4 };
    expect(browsePollInterval(progress(coverage, running))).toBe(BROWSE_POLL_MS);
  });

  it('stops when the wide view has nothing running behind it', () => {
    expect(browsePollInterval(progress({ tooLarge: true }, SURVEY))).toBe(false);
  });
});
