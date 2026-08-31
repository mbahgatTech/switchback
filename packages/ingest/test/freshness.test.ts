import { describe, expect, it } from 'vitest';
import { TileStatus } from '@switchback/db';
import { TILE_TTL_MS, isTileFresh } from '../src/freshness';

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

describe('isTileFresh', () => {
  it('serves cached data inside the TTL', () => {
    expect(isTileFresh({ status: TileStatus.ready, fetchedAt: ago(29 * 24 * 3600_000) }, NOW)).toBe(
      true,
    );
  });

  it('counts an empty tile as fresh, so ocean is not re-queried every request', () => {
    expect(isTileFresh({ status: TileStatus.empty, fetchedAt: ago(1000) }, NOW)).toBe(true);
  });

  it('expires past the TTL', () => {
    expect(isTileFresh({ status: TileStatus.ready, fetchedAt: ago(TILE_TTL_MS + 1) }, NOW)).toBe(
      false,
    );
  });

  it('never serves a tile that failed or is still running', () => {
    // A failed tile with a stale fetchedAt would otherwise render an empty map as though
    // the area genuinely had no trails.
    expect(isTileFresh({ status: TileStatus.failed, fetchedAt: ago(1000) }, NOW)).toBe(false);
    expect(isTileFresh({ status: TileStatus.running, fetchedAt: ago(1000) }, NOW)).toBe(false);
    expect(isTileFresh({ status: TileStatus.pending, fetchedAt: ago(1000) }, NOW)).toBe(false);
  });

  it('treats a never-fetched or absent tile as cold', () => {
    expect(isTileFresh({ status: TileStatus.ready, fetchedAt: null }, NOW)).toBe(false);
    expect(isTileFresh(null, NOW)).toBe(false);
  });
});
