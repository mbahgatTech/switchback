/**
 * Subdivision's two decisions: when a tile may split, and when a parent may be called ready.
 * Both are pure enough to pin without a database, which is the point of `rollUp` being a
 * function of four rows rather than a query.
 */

import { describe, expect, it } from 'vitest';
import { JobKind, TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { INGEST_ZOOM, MAX_INGEST_ZOOM, childQuadkeys } from '@switchback/geo';
import {
  SPLIT_PRIORITY,
  canSubdivide,
  promoteFrom,
  queueStaleChildren,
  rollUp,
  splitTile,
  subdivideMaxZoom,
} from '../src/subdivide';
import type { ChildTile } from '../src/subdivide';
import { TILE_TTL_MS } from '../src/freshness';

const PARENT = '120221203';
const NOW = new Date('2026-08-05T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function child(quadkey: string, overrides: Partial<ChildTile> = {}): ChildTile {
  return {
    quadkey,
    status: TileStatus.ready,
    fetchedAt: NOW,
    trailCount: 10,
    fetchMs: 1000,
    ...overrides,
  };
}

/** All four children of `PARENT`, each ready unless the caller says otherwise. */
function siblings(overrides: Partial<ChildTile>[] = []): ChildTile[] {
  return childQuadkeys(PARENT).map((key, index) => child(key, overrides[index] ?? {}));
}

interface Recorded {
  tileUpserts: string[];
  tileUpdates: Array<{ quadkey: string; data: Record<string, unknown> }>;
  jobUpserts: Array<{ dedupeKey: string; priority: number }>;
}

/** A Prisma stand-in covering only what this module calls. */
function fakeDb(rows: ChildTile[] = []): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { tileUpserts: [], tileUpdates: [], jobUpserts: [] };
  const db = {
    ingestTile: {
      findMany: ({ where }: { where: { quadkey: { in: string[] } } }) =>
        Promise.resolve(rows.filter((row) => where.quadkey.in.includes(row.quadkey))),
      upsert: (args: { where: { quadkey: string } }) => {
        recorded.tileUpserts.push(args.where.quadkey);
        return Promise.resolve({});
      },
      update: (args: { where: { quadkey: string }; data: Record<string, unknown> }) => {
        recorded.tileUpdates.push({ quadkey: args.where.quadkey, data: args.data });
        // Applied, not merely recorded: `promoteFrom` walks up by re-reading the row it has
        // just written, so a fake that drops the write cannot reach the grandparent.
        const row = rows.find((candidate) => candidate.quadkey === args.where.quadkey);
        if (row) Object.assign(row, args.data);
        return Promise.resolve({});
      },
    },
    ingestJob: {
      updateMany: () => Promise.resolve({ count: 0 }),
      upsert: (args: { where: { dedupeKey: string }; create: { priority: number } }) => {
        recorded.jobUpserts.push({
          dedupeKey: args.where.dedupeKey,
          priority: args.create.priority,
        });
        return Promise.resolve({});
      },
    },
  } as unknown as PrismaClient;
  return { db, recorded };
}

describe('canSubdivide', () => {
  it('splits at the ingest zoom and stops at the floor', () => {
    expect(canSubdivide(INGEST_ZOOM)).toBe(true);
    expect(canSubdivide(MAX_INGEST_ZOOM - 1)).toBe(true);
    expect(canSubdivide(MAX_INGEST_ZOOM)).toBe(false);
  });

  it('turns off entirely when the ceiling is the ingest zoom', () => {
    // The rollback: no tile splits, and a dense one fails exactly as it did before.
    expect(canSubdivide(INGEST_ZOOM, INGEST_ZOOM)).toBe(false);
  });
});

describe('subdivideMaxZoom', () => {
  it('reads the ceiling from the environment', () => {
    expect(subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: '10' })).toBe(10);
    expect(subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: String(INGEST_ZOOM) })).toBe(INGEST_ZOOM);
  });

  it('refuses a value outside the range rather than trusting it', () => {
    // Below `INGEST_ZOOM` there is no tile to split; above the floor is unbounded recursion,
    // and both are one typo away in a portal field.
    for (const value of ['8', '99', 'deep', '', '10.5']) {
      expect(subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: value })).toBe(MAX_INGEST_ZOOM);
    }
    expect(subdivideMaxZoom({})).toBe(MAX_INGEST_ZOOM);
  });
});

describe('rollUp', () => {
  it('promotes a parent whose four children are all in', () => {
    expect(rollUp(siblings())).toEqual({
      status: TileStatus.ready,
      fetchedAt: NOW,
      trailCount: 40,
      fetchMs: 4000,
    });
  });

  it('holds the parent back while any child is outstanding', () => {
    for (const status of [TileStatus.pending, TileStatus.running, TileStatus.failed]) {
      expect(rollUp(siblings([{}, {}, {}, { status }]))).toBeNull();
    }
  });

  it('holds the parent back when a child row is missing', () => {
    // Three of four is a real state — a split whose fourth enqueue lost a race. Reporting
    // ready here claims an area is complete with a quarter of it missing.
    expect(rollUp(siblings().slice(0, 3))).toBeNull();
  });

  it('holds the parent back when a settled child never recorded a fetch', () => {
    expect(rollUp(siblings([{}, {}, {}, { fetchedAt: null }]))).toBeNull();
  });

  it('takes the oldest child as the parent freshness', () => {
    const stale = ago(TILE_TTL_MS - 1000);
    const settled = rollUp(siblings([{ fetchedAt: stale }, {}, {}, {}]));
    // The freshest child would let one quarter refreshed yesterday hold three stale ones out
    // of the sweep for another month.
    expect(settled?.fetchedAt).toEqual(stale);
  });

  it('is empty only when every child is', () => {
    const allEmpty = siblings().map((row) => ({ ...row, status: TileStatus.empty, trailCount: 0 }));
    expect(rollUp(allEmpty)?.status).toBe(TileStatus.empty);
    expect(rollUp([...allEmpty.slice(0, 3), child(childQuadkeys(PARENT)[3])])?.status).toBe(
      TileStatus.ready,
    );
  });
});

describe('splitTile', () => {
  it('writes four child tiles and queues one job each', async () => {
    const { db, recorded } = fakeDb();

    const children = await splitTile(db, PARENT, { fetchMs: 543_653 });

    expect(children).toEqual(childQuadkeys(PARENT));
    expect(recorded.tileUpserts).toEqual(childQuadkeys(PARENT));
    expect(recorded.jobUpserts).toEqual(
      childQuadkeys(PARENT).map((key) => ({
        dedupeKey: `${JobKind.ingest_tile}:${key}`,
        priority: SPLIT_PRIORITY,
      })),
    );
  });

  it('leaves the parent pending rather than failed, and says what happened', async () => {
    const { db, recorded } = fakeDb();

    await splitTile(db, PARENT);

    expect(recorded.tileUpdates).toEqual([
      {
        quadkey: PARENT,
        data: { status: TileStatus.pending, lastError: 'split into 4 tiles at z10' },
      },
    ]);
  });
});

describe('queueStaleChildren', () => {
  it('queues only the children that are not serving fresh data', async () => {
    const rows = siblings([
      {},
      { status: TileStatus.failed },
      { fetchedAt: ago(TILE_TTL_MS + 1) },
      { status: TileStatus.empty },
    ]);
    const { db, recorded } = fakeDb(rows);

    const queued = await queueStaleChildren(db, rows, NOW);

    // The fresh ready child and the fresh empty one are left alone; re-queueing them would
    // re-fetch ground that is already served.
    expect(queued).toEqual([rows[1]!.quadkey, rows[2]!.quadkey]);
    expect(recorded.jobUpserts.map((job) => job.dedupeKey)).toEqual(
      queued.map((key) => `${JobKind.ingest_tile}:${key}`),
    );
  });
});

describe('promoteFrom', () => {
  it('promotes the parent and then its own parent, innermost first', async () => {
    const grandchildren = childQuadkeys(`${PARENT}0`).map((key) => child(key));
    const rest = childQuadkeys(PARENT)
      .slice(1)
      .map((key) => child(key));
    // The z10 row itself is still `pending`: its promotion is what this call is for, and the
    // z9 above it may only follow once that lands.
    const { db, recorded } = fakeDb([
      ...grandchildren,
      child(`${PARENT}0`, { status: TileStatus.pending, fetchedAt: null }),
      ...rest,
    ]);

    const promoted = await promoteFrom(db, `${PARENT}0`);

    expect(promoted).toEqual([`${PARENT}0`, PARENT]);
    expect(recorded.tileUpdates.map((update) => update.quadkey)).toEqual([`${PARENT}0`, PARENT]);
  });

  it('stops at the first ancestor that is not complete', async () => {
    const grandchildren = childQuadkeys(`${PARENT}0`).map((key) => child(key));
    const { db, recorded } = fakeDb([
      ...grandchildren,
      child(`${PARENT}0`, { status: TileStatus.pending, fetchedAt: null }),
      // Only two of the z9's four children exist, so it cannot follow.
      child(childQuadkeys(PARENT)[1]),
    ]);

    expect(await promoteFrom(db, `${PARENT}0`)).toEqual([`${PARENT}0`]);
    expect(recorded.tileUpdates).toHaveLength(1);
  });

  it('never climbs above the ingest zoom', async () => {
    // A z8 tile is not a unit of coverage and must never be written by a roll-up.
    const { db, recorded } = fakeDb(siblings());
    await promoteFrom(db, PARENT);
    expect(recorded.tileUpdates.map((update) => update.quadkey)).toEqual([PARENT]);
  });
});
