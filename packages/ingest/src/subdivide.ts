/**
 * Subdivision: what a tile does when it will not fit in one invocation. The parent is replaced
 * by its four z+1 children, which ingest independently and roll their result back up.
 */

import { JobKind, TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  INGEST_ZOOM,
  MAX_INGEST_ZOOM,
  childQuadkeys,
  parentQuadkey,
  quadkeyToBBox,
  quadkeyToTile,
} from '@switchback/geo';
import { isTileFresh, isTileSettled } from './freshness';
import { enqueue, tileJobKey } from './jobs';

/** How many children a quadkey has. Four, always — that is what "quad" means. */
export const CHILDREN_PER_TILE = 4;

/**
 * Priority a child inherits. Above the 0 a background refresh uses and level with a live
 * viewport, because a split tile is one somebody has already waited a whole invocation for —
 * and the parent cannot complete until the last child does, so demoting one demotes all four.
 */
export const SPLIT_PRIORITY = 5;

/** The zoom past which a tile is failed rather than split. Set to `INGEST_ZOOM` to disable. */
export function subdivideMaxZoom(source: NodeJS.ProcessEnv = process.env): number {
  const value = Number(source.INGEST_SUBDIVIDE_MAX_ZOOM);
  if (!Number.isInteger(value) || value < INGEST_ZOOM || value > MAX_INGEST_ZOOM) {
    return MAX_INGEST_ZOOM;
  }
  return value;
}

/** Whether a tile at this zoom has anywhere left to go. */
export function canSubdivide(z: number, maxZoom = subdivideMaxZoom()): boolean {
  return z < maxZoom;
}

/** The columns a roll-up reads off each child. */
export interface ChildTile {
  quadkey: string;
  status: TileStatus;
  fetchedAt: Date | null;
  trailCount: number;
  fetchMs: number | null;
}

/** What a parent row becomes once every child is in. */
export interface Rollup {
  status: TileStatus;
  fetchedAt: Date;
  trailCount: number;
  fetchMs: number;
}

/**
 * The parent's row from its children's, or null while any child is outstanding.
 *
 * Two rules carry the whole thing. **All four or nothing**: reporting ready with three children
 * in tells a reader an area is complete while a quarter of it is missing, and nothing later
 * corrects that until the TTL. And **the oldest child sets `fetchedAt`**, so the parent leaves
 * the TTL when its stalest quarter does — taking the freshest would let one child refreshed
 * yesterday hold three stale ones out of the refresh sweep indefinitely.
 */
export function rollUp(children: readonly ChildTile[]): Rollup | null {
  if (children.length !== CHILDREN_PER_TILE) return null;
  if (!children.every((child) => isTileSettled(child.status) && child.fetchedAt !== null)) {
    return null;
  }

  const oldest = children.reduce((a, b) => (a.fetchedAt! < b.fetchedAt! ? a : b));
  const trailCount = children.reduce((sum, child) => sum + child.trailCount, 0);

  return {
    // `empty` only when every child was: it is what lets the refresh sweep skip ocean, and one
    // child with trails in it makes the parent a place worth re-querying.
    status: children.every((child) => child.status === TileStatus.empty)
      ? TileStatus.empty
      : TileStatus.ready,
    fetchedAt: oldest.fetchedAt!,
    trailCount,
    fetchMs: children.reduce((sum, child) => sum + (child.fetchMs ?? 0), 0),
  };
}

const childSelect = {
  quadkey: true,
  status: true,
  fetchedAt: true,
  trailCount: true,
  fetchMs: true,
} as const;

/**
 * The child rows of a tile, if it has any. Four means split; zero means never split. A quadkey
 * is a prefix code, so this is a range scan on the primary key rather than a second column.
 */
export async function childTiles(db: PrismaClient, quadkey: string): Promise<ChildTile[]> {
  return db.ingestTile.findMany({
    where: { quadkey: { in: childQuadkeys(quadkey) } },
    select: childSelect,
    orderBy: { quadkey: 'asc' },
  });
}

/**
 * Replace a tile with its four children and queue them.
 *
 * Admission control is deliberately not consulted. `queueTiles` asks it because a viewport is
 * requesting *new ground*; this is ground already admitted, already attempted, and already paid
 * for with a ten-minute invocation — a refusal here would strand the parent with no children and
 * no route to ready. The parent row is left `pending` rather than `failed`: it is not a failure
 * any more, and `pending` is what keeps it out of `readyTiles` while the children run.
 */
export async function splitTile(
  db: PrismaClient,
  quadkey: string,
  options: { fetchMs?: number; priority?: number } = {},
): Promise<string[]> {
  const children = childQuadkeys(quadkey);
  const priority = options.priority ?? SPLIT_PRIORITY;

  for (const child of children) {
    const { x, y, z } = quadkeyToTile(child);
    const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(child);
    await db.ingestTile.upsert({
      where: { quadkey: child },
      create: { quadkey: child, x, y, z, status: TileStatus.pending, bboxW, bboxS, bboxE, bboxN },
      update: {},
    });
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey(child),
      payload: { quadkey: child },
      priority,
    });
  }

  await db.ingestTile.update({
    where: { quadkey },
    data: {
      status: TileStatus.pending,
      lastError: `split into ${children.length} tiles at z${quadkey.length + 1}`,
      ...(options.fetchMs === undefined ? {} : { fetchMs: options.fetchMs }),
    },
  });

  return children;
}

/** Queue every child that is not currently serving fresh data. Returns what it queued. */
export async function queueStaleChildren(
  db: PrismaClient,
  children: readonly ChildTile[],
  now: Date,
  priority = SPLIT_PRIORITY,
): Promise<string[]> {
  const stale = children.filter((child) => !isTileFresh(child, now));
  for (const child of stale) {
    await enqueue(db, {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey(child.quadkey),
      payload: { quadkey: child.quadkey },
      priority,
    });
  }
  return stale.map((child) => child.quadkey);
}

/**
 * Promote `quadkey` from its children, then its own parent, and so on — innermost first,
 * stopping at the first tile that is not complete. A z11 finishing can make its z10 parent
 * ready, which can in turn make the z9 ready, and the z9 is the one a reader is polling.
 */
export async function promoteFrom(db: PrismaClient, quadkey: string): Promise<string[]> {
  const promoted: string[] = [];
  let key: string | null = quadkey;

  while (key !== null && key.length >= INGEST_ZOOM) {
    const settled = rollUp(await childTiles(db, key));
    if (!settled) break;

    await db.ingestTile.update({
      where: { quadkey: key },
      data: { ...settled, lastError: null },
    });
    promoted.push(key);
    key = parentQuadkey(key);
  }

  return promoted;
}

/** Promote every ancestor of a tile that has just finished. A no-op at `INGEST_ZOOM`. */
export async function rollUpAncestors(db: PrismaClient, quadkey: string): Promise<string[]> {
  const parent = parentQuadkey(quadkey);
  if (parent === null || parent.length < INGEST_ZOOM) return [];
  return promoteFrom(db, parent);
}
