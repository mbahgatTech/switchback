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

/**
 * The columns freshness reads off a tile row.
 *
 * `sourceSnapshotAt` is required rather than optional on purpose. Every caller loads its row
 * with an explicit Prisma `select`, and an optional field would let one omit the column and
 * still compile — reading `undefined`, falling back to the fetch clock, and quietly restoring
 * the very defect this type exists to prevent. Required, the compiler names each such caller.
 */
export interface TileFreshness {
  status: TileStatus;
  fetchedAt: Date | null;
  /**
   * When the source's own copy of OSM was current — `timestamp_osm_base`, not our fetch.
   * Null on rows written before the column existed and on answers that carried no stamp.
   */
  sourceSnapshotAt: Date | null;
}

/**
 * When a tile's data was actually current: the older of the source's snapshot and our fetch.
 *
 * The minimum is the whole point. `fetchedAt` records when we asked, which says nothing about
 * the age of what came back — an extract cut a year ago re-read today would reset the TTL on
 * every pass and report fresh forever. Taking the older of the two means a recent fetch cannot
 * launder old data, and a source clock running ahead of ours cannot extend the TTL either.
 *
 * A null snapshot leaves the fetch deciding, which is the pre-existing behaviour: treating it
 * as stale would expire every row written before the column existed, all at once.
 */
export function dataAsOf(fetchedAt: Date, sourceSnapshotAt: Date | null): Date {
  return sourceSnapshotAt !== null && sourceSnapshotAt < fetchedAt ? sourceSnapshotAt : fetchedAt;
}

/**
 * Whether a tile's cached data is still good enough to serve without re-fetching.
 *
 * The source stamp binds every settled status, `empty` included. A partial extract answers an
 * out-of-area query `200 OK` with zero elements, which lands as `empty` carrying that extract's
 * own date over real ground — exempting it would serve an empty map there for as long as
 * anything kept re-fetching.
 */
export function isTileFresh(tile: TileFreshness | null, now: Date, ttlMs = TILE_TTL_MS): boolean {
  if (!tile?.fetchedAt) return false;
  if (!isTileSettled(tile.status)) return false;
  return now.getTime() - dataAsOf(tile.fetchedAt, tile.sourceSnapshotAt).getTime() < ttlMs;
}
