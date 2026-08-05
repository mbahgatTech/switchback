/**
 * When a tile row's data is still worth serving. Its own module because both the coverage
 * partition and subdivision's roll-up ask the question, and neither owns it.
 */

import { TileStatus } from '@switchback/db';

/**
 * A tile is re-fetched when its data is older than this. Weekly would be mostly wasted
 * Overpass load; a season would let a rerouted path go unnoticed. See `docs/architecture.md`.
 */
export const TILE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A tile row that has contributed everything it is going to — trails, or provably none. */
export function isTileSettled(status: TileStatus): boolean {
  return status === TileStatus.ready || status === TileStatus.empty;
}

/** Whether a tile's cached data is still good enough to serve without re-fetching. */
export function isTileFresh(
  tile: { status: TileStatus; fetchedAt: Date | null } | null,
  now: Date,
  ttlMs = TILE_TTL_MS,
): boolean {
  if (!tile?.fetchedAt) return false;
  if (!isTileSettled(tile.status)) return false;
  return now.getTime() - tile.fetchedAt.getTime() < ttlMs;
}
