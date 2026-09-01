/**
 * Subdivision's two decisions: when a tile may split, and when a parent may be called ready.
 * Both are pure enough to pin without a database, which is the point of `rollUp` being a
 * function of four rows rather than a query.
 */

import { describe, expect, it } from 'vitest';
import { JobKind, JobStatus, TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { INGEST_ZOOM, MAX_INGEST_ZOOM, childQuadkeys } from '@switchback/geo';
import {
  SPLIT_CHILD_ATTEMPT_CAP,
  SPLIT_MARKER_PREFIX,
  SPLIT_PRIORITY,
  canSubdivide,
  promoteFrom,
  queueStaleChildren,
  rollUp,
  splitTile,
  subdivideMaxZoom,
  unsplitTile,
} from '../src/subdivide';
import type { ChildTile } from '../src/subdivide';
import { REFETCH_INTERVAL_MS, TILE_TTL_MS, isTileSettled } from '../src/freshness';

/**
 * Every status `queueStaleChildren` treats as settled data, from the helper rather than named
 * here. One predicate judges all of them, so the stamp has to be asked of each: a split parent
 * whose stale `empty` child is exempt re-promotes from ground nothing ever re-fetches.
 */
const SETTLED = Object.values(TileStatus).filter(isTileSettled);

const PARENT = '120221203';
const NOW = new Date('2026-08-05T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

function child(quadkey: string, overrides: Partial<ChildTile> = {}): ChildTile {
  return {
    quadkey,
    status: TileStatus.ready,
    fetchedAt: NOW,
    sourceSnapshotAt: null,
    trailCount: 10,
    fetchMs: 1000,
    attempts: 0,
    ...overrides,
  };
}

/** All four children of `PARENT`, each ready unless the caller says otherwise. */
function siblings(overrides: Partial<ChildTile>[] = []): ChildTile[] {
  return childQuadkeys(PARENT).map((key, index) => child(key, overrides[index] ?? {}));
}

/**
 * A child of `status` carrying what the writer would have left on it. `trailCount` follows the
 * status rather than being a knob — `processTile` writes `empty` exactly when it assembled no
 * trails — so a roll-up discounting a quarter by its trail count is caught by the same fixture as
 * one discounting it by its status word.
 */
function settled(status: TileStatus, overrides: Partial<ChildTile> = {}): Partial<ChildTile> {
  return { status, trailCount: status === TileStatus.empty ? 0 : 10, ...overrides };
}

interface Recorded {
  tileUpserts: string[];
  tileUpdates: Array<{ quadkey: string; data: Record<string, unknown> }>;
  jobUpserts: Array<{ dedupeKey: string; priority: number }>;
}

/** A Prisma stand-in covering only what this module calls. */
function fakeDb(
  rows: ChildTile[] = [],
  jobs: Record<string, JobStatus> = {},
): { db: PrismaClient; recorded: Recorded } {
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
      findMany: ({ where }: { where: { dedupeKey: { in: string[] } } }) =>
        Promise.resolve(
          where.dedupeKey.in
            .filter((key) => jobs[key] !== undefined)
            .map((key) => ({ dedupeKey: key, status: jobs[key]! })),
        ),
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
    // The ceiling is passed rather than read from the environment: what is under test is the
    // comparison, and the environment's own default is the subject of `subdivideMaxZoom`.
    expect(canSubdivide(INGEST_ZOOM, MAX_INGEST_ZOOM)).toBe(true);
    expect(canSubdivide(MAX_INGEST_ZOOM - 1, MAX_INGEST_ZOOM)).toBe(true);
    expect(canSubdivide(MAX_INGEST_ZOOM, MAX_INGEST_ZOOM)).toBe(false);
  });

  it('turns off entirely when the ceiling is the ingest zoom', () => {
    // The rollback: no tile splits, and a dense one fails exactly as it did before.
    expect(canSubdivide(INGEST_ZOOM, INGEST_ZOOM)).toBe(false);
  });
});

describe('subdivideMaxZoom', () => {
  const CLAIM = { INGEST_TRAIL_IDENTITY: 'claim' };

  it('reads the ceiling from the environment', () => {
    expect(subdivideMaxZoom({ ...CLAIM, INGEST_SUBDIVIDE_MAX_ZOOM: '10' })).toBe(10);
    expect(subdivideMaxZoom({ ...CLAIM, INGEST_SUBDIVIDE_MAX_ZOOM: String(INGEST_ZOOM) })).toBe(
      INGEST_ZOOM,
    );
  });

  it('refuses a value outside the range rather than trusting it', () => {
    // Below `INGEST_ZOOM` there is no tile to split; above the floor is unbounded recursion,
    // and both are one typo away in a portal field.
    for (const value of ['8', '99', 'deep', '', '10.5']) {
      expect(subdivideMaxZoom({ ...CLAIM, INGEST_SUBDIVIDE_MAX_ZOOM: value })).toBe(INGEST_ZOOM);
    }
  });

  it('is off when nothing declares it, so it has to be switched on deliberately', () => {
    // An application-settings write replaces the Function App's collection whole, so a deploy that
    // drops the entry leaves the drainer reading an empty environment. A default of
    // `MAX_INGEST_ZOOM` would turn subdivision on there without anyone choosing it.
    expect(subdivideMaxZoom({})).toBe(INGEST_ZOOM);
    expect(canSubdivide(INGEST_ZOOM, subdivideMaxZoom({}))).toBe(false);
  });

  it('holds the ceiling down until trail identity resolves through claims', () => {
    // Subdividing cuts fresh interior seam. Without `TrailWay` deciding identity, a trail
    // crossing that seam is assembled twice under two different `min(wayId)` keys, and
    // `commitTrail` only ever upserts — so lowering the ceiling again does not undo it.
    for (const zoom of ['10', '11']) {
      expect(subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: zoom })).toBe(INGEST_ZOOM);
      expect(
        subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: zoom, INGEST_TRAIL_IDENTITY: 'osm-id' }),
      ).toBe(INGEST_ZOOM);
      expect(
        subdivideMaxZoom({ INGEST_SUBDIVIDE_MAX_ZOOM: zoom, INGEST_TRAIL_IDENTITY: 'claim' }),
      ).toBe(Number(zoom));
    }
  });
});

describe('rollUp', () => {
  it('promotes a parent whose four children are all in', () => {
    expect(rollUp(siblings())).toEqual({
      status: TileStatus.ready,
      fetchedAt: NOW,
      sourceSnapshotAt: null,
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

  it('takes the oldest child as the parent freshness, wherever it sits in the set', () => {
    const stale = ago(TILE_TTL_MS - 1000);
    // The freshest child would let one quarter refreshed yesterday hold three stale ones out
    // of the sweep for another month. The oldest is placed third rather than first, so an
    // implementation that reaches for `children[0]` is caught as well as one that inverts the
    // comparison.
    for (const at of [0, 2, 3]) {
      const rows = [{}, {}, {}, {}].map((row, index) =>
        index === at ? { fetchedAt: stale } : row,
      );
      expect(rollUp(siblings(rows))?.fetchedAt).toEqual(stale);
    }
  });

  it('is empty only when every child is', () => {
    const allEmpty = siblings().map((row) => ({ ...row, status: TileStatus.empty, trailCount: 0 }));
    expect(rollUp(allEmpty)?.status).toBe(TileStatus.empty);
    expect(rollUp([...allEmpty.slice(0, 3), child(childQuadkeys(PARENT)[3])])?.status).toBe(
      TileStatus.ready,
    );
  });

  it.each(SETTLED)('takes the oldest source stamp off a %s child like any other', (status) => {
    /*
     * Source age and fetch age need not sit on the same child, and neither does status. Here the
     * child with the most recent fetch is the one holding the oldest data, so a parent that
     * carried up only the fetch clock would report a month-old quarter as current — the same
     * laundering the column exists to stop, one level up the tree. Asked of every settled status
     * because an `empty` quarter reads as having answered about nothing, while a partial extract
     * answering out-of-area ground `200 OK` with zero elements is an old answer about real ground.
     */
    const oldSource = ago(TILE_TTL_MS + 1000);
    const rows = [
      { fetchedAt: ago(5000), sourceSnapshotAt: NOW },
      settled(status, { fetchedAt: NOW, sourceSnapshotAt: oldSource }),
      { fetchedAt: ago(3000), sourceSnapshotAt: NOW },
      { fetchedAt: ago(2000), sourceSnapshotAt: NOW },
    ];

    expect(rollUp(siblings(rows))?.sourceSnapshotAt).toEqual(oldSource);
  });

  it('carries the source stamp up from a parent whose every child is empty', () => {
    /*
     * What a partial extract produces first: four out-of-area answers of `200 OK` with zero
     * elements, each stamped with the extract's own date. An `empty` parent left unstamped is
     * judged on its fetch clock alone, which the next pass over the same extract resets, and it
     * has no other route back — `queueStaleChildren` runs only inside a drain the two z9 readers
     * enqueue, and both of them would be calling this parent fresh.
     */
    const oldSource = ago(TILE_TTL_MS + 1000);
    const rows = [0, 1, 2, 3].map(() => settled(TileStatus.empty, { sourceSnapshotAt: oldSource }));

    const parent = rollUp(siblings(rows));

    expect(parent?.status).toBe(TileStatus.empty);
    expect(parent?.sourceSnapshotAt).toEqual(oldSource);
  });

  it('leaves the parent unstamped only when no child carried a stamp', () => {
    // A child predating the column must not drag its siblings' real stamps out of the answer,
    // and four such children leave nothing to inherit.
    const none = [0, 1, 2, 3].map(() => ({ sourceSnapshotAt: null }));
    expect(rollUp(siblings(none))?.sourceSnapshotAt).toBeNull();

    const stamped = [{ sourceSnapshotAt: NOW }, ...none.slice(1)];
    expect(rollUp(siblings(stamped))?.sourceSnapshotAt).toEqual(NOW);
  });
});

describe('splitTile', () => {
  it('writes four child tiles and queues one job each', async () => {
    const { db, recorded } = fakeDb();

    const children = await splitTile(db, PARENT, { previous: null, fetchMs: 543_653 });

    expect(children).toEqual(childQuadkeys(PARENT));
    expect(recorded.tileUpserts).toEqual(childQuadkeys(PARENT));
    expect(recorded.jobUpserts).toEqual(
      childQuadkeys(PARENT).map((key) => ({
        dedupeKey: `${JobKind.ingest_tile}:${key}`,
        priority: SPLIT_PRIORITY,
      })),
    );
  });

  it('leaves a parent that has never served data pending, and says what happened', async () => {
    const { db, recorded } = fakeDb();

    await splitTile(db, PARENT, { previous: null });

    expect(recorded.tileUpdates).toEqual([
      {
        quadkey: PARENT,
        data: { status: TileStatus.pending, lastError: 'split into 4 tiles at z10' },
      },
    ]);
  });

  it('keeps a parent that was already serving trails in readyTiles while children run', async () => {
    // `ensureCoverage` calls a settled-but-stale tile ready — refreshing too, once a re-fetch is
    // due — and anything else pending, so demoting this one would flip a reader from "here are
    // your trails" back to "still loading" for as long as four children take.
    const fetchedAt = ago(TILE_TTL_MS + 1);
    const { db, recorded } = fakeDb();

    await splitTile(db, PARENT, { previous: { status: TileStatus.ready, fetchedAt } });

    expect(recorded.tileUpdates[0]!.data.status).toBe(TileStatus.ready);
  });

  it('will not call a parent ready on the strength of a status it never earned', async () => {
    // `ready` with no `fetchedAt` is a row that has been claimed but never wrote trails.
    const { db, recorded } = fakeDb();

    await splitTile(db, PARENT, { previous: { status: TileStatus.ready, fetchedAt: null } });

    expect(recorded.tileUpdates[0]!.data.status).toBe(TileStatus.pending);
  });

  it('carries a lost-trail note behind the marker, never in front of it', async () => {
    // `reconcileOrphanedSplits` and `countOrphanedSplits` both match the marker as a prefix, so a
    // note prepended here would hide the parent from its own repair sweep.
    const { db, recorded } = fakeDb();

    await splitTile(db, PARENT, { previous: null, lostNote: ' — way/100 did not commit' });

    const lastError = String(recorded.tileUpdates[0]!.data.lastError);
    expect(lastError.startsWith(SPLIT_MARKER_PREFIX)).toBe(true);
    expect(lastError).toContain('way/100 did not commit');
  });

  it('records the trails the splitting run did commit', async () => {
    // A split parent with `trailCount` 0 reads as holding nothing, which puts it in
    // `ensureCoverage`'s pending set and makes the client poll it every 2.5 s.
    const { db, recorded } = fakeDb();

    await splitTile(db, PARENT, { previous: null, trailCount: 812 });

    expect(recorded.tileUpdates[0]!.data.trailCount).toBe(812);
  });

  it('leaves trailCount alone when the caller does not know it', async () => {
    // The Overpass-deadline split never reaches the commit loop, so it has no count to offer and
    // must not overwrite one the row already holds with a zero.
    const { db, recorded } = fakeDb();

    await splitTile(db, PARENT, { previous: null });

    expect(recorded.tileUpdates[0]!.data).not.toHaveProperty('trailCount');
  });
});

describe('queueStaleChildren', () => {
  const keys = childQuadkeys(PARENT);
  const jobKey = (quadkey: string): string => `${JobKind.ingest_tile}:${quadkey}`;

  it('queues only the children that are not serving fresh data', async () => {
    const rows = siblings([
      {},
      { status: TileStatus.pending },
      { fetchedAt: ago(TILE_TTL_MS + 1) },
      { status: TileStatus.empty },
    ]);
    const { db, recorded } = fakeDb(rows);

    const { queued } = await queueStaleChildren(db, rows, NOW);

    // The fresh ready child and the fresh empty one are left alone; re-queueing them would
    // re-fetch ground that is already served.
    expect(queued).toEqual([rows[1]!.quadkey, rows[2]!.quadkey]);
    expect(recorded.jobUpserts.map((job) => job.dedupeKey)).toEqual(queued.map(jobKey));
  });

  it('leaves a child alone while its own retry ladder still owns it', async () => {
    /*
     * The distinction the tile row cannot make. `failJob` writes the *job* `queued` with a future
     * `runAfter` while attempts remain, and the *tile* `failed` either way — so re-queueing on
     * tile status would clear `attempts` on a child that was already coming back, on every
     * viewport poll, and a rate-limited tile becomes one we hammer once per render.
     */
    const rows = siblings([{}, {}, {}, { status: TileStatus.failed, fetchedAt: null }]);
    const { db, recorded } = fakeDb(rows, { [jobKey(keys[3])]: JobStatus.queued });

    const outcome = await queueStaleChildren(db, rows, NOW);

    expect(outcome).toEqual({
      queued: [],
      waiting: [keys[3]],
      exhausted: [],
      abandoned: [],
    });
    expect(recorded.jobUpserts).toEqual([]);
  });

  it('revives a child whose ladder ran out, and says that it did', async () => {
    /*
     * The only path back. `splitTile` enqueues each child once, `ensureCoverage` covers z9 alone,
     * and `reclaimExpiredJobs` does not touch a dead row — so without this a single exhausted
     * leaf holds its z9 ancestor `pending` forever and no code anywhere can restart it.
     */
    const rows = siblings([{}, {}, {}, { status: TileStatus.failed, fetchedAt: null }]);
    const { db, recorded } = fakeDb(rows, { [jobKey(keys[3])]: JobStatus.dead });

    const outcome = await queueStaleChildren(db, rows, NOW);

    expect(outcome).toEqual({
      queued: [keys[3]],
      waiting: [],
      exhausted: [keys[3]],
      abandoned: [],
    });
    expect(recorded.jobUpserts.map((job) => job.dedupeKey)).toEqual([jobKey(keys[3])]);
  });

  it('stops reviving a child that has used up its run cap', async () => {
    /*
     * The bound on the revival above. `enqueue` resets the *job*'s `attempts` on every revival, so
     * a dead child restarts a fresh five-attempt ladder each time a viewport poll drains the
     * parent — for as long as anyone leaves that map open. The tile's own `attempts` is the only
     * counter that survives, and this is where it stops the loop.
     */
    const rows = siblings([
      {},
      {},
      {},
      { status: TileStatus.failed, fetchedAt: null, attempts: SPLIT_CHILD_ATTEMPT_CAP },
    ]);
    const { db, recorded } = fakeDb(rows, { [jobKey(keys[3])]: JobStatus.dead });

    const outcome = await queueStaleChildren(db, rows, NOW);

    expect(outcome).toEqual({
      queued: [],
      waiting: [],
      exhausted: [],
      abandoned: [keys[3]],
    });
    // Nothing queued is the whole point: an abandoned child is off the ladder for good.
    expect(recorded.jobUpserts).toEqual([]);
  });

  it('revives a child one run short of the cap', async () => {
    // The boundary from the other side, so the comparison cannot be `>` or the cap a constant off.
    const rows = siblings([
      {},
      {},
      {},
      { status: TileStatus.failed, fetchedAt: null, attempts: SPLIT_CHILD_ATTEMPT_CAP - 1 },
    ]);
    const { db, recorded } = fakeDb(rows, { [jobKey(keys[3])]: JobStatus.dead });

    const outcome = await queueStaleChildren(db, rows, NOW);

    expect(outcome.abandoned).toEqual([]);
    expect(outcome.exhausted).toEqual([keys[3]]);
    expect(recorded.jobUpserts.map((job) => job.dedupeKey)).toEqual([jobKey(keys[3])]);
  });

  it('leaves the cap to dead children, not to one still working through its ladder', async () => {
    // `attempts` past the cap is not by itself a reason to stop: a child whose job is `queued` is
    // coming back on its own schedule, and the cap governs revival, not the queue.
    const rows = siblings([
      {},
      {},
      {},
      { status: TileStatus.failed, fetchedAt: null, attempts: SPLIT_CHILD_ATTEMPT_CAP + 5 },
    ]);
    const { db, recorded } = fakeDb(rows, { [jobKey(keys[3])]: JobStatus.queued });

    const outcome = await queueStaleChildren(db, rows, NOW);

    expect(outcome.waiting).toEqual([keys[3]]);
    expect(outcome.abandoned).toEqual([]);
    expect(recorded.jobUpserts).toEqual([]);
  });

  /*
   * The split tier's own reading of the source stamp.
   *
   * `ensureCoverage` covers `INGEST_ZOOM` alone, so once a parent has split this filter is the
   * only thing that turns "this ground is stale" into a re-fetch of it. Every other test in this
   * describe leaves `sourceSnapshotAt` null, which is the one state where reading the stamp and
   * ignoring it give the same answer — so the three below are what hold this reader to the source
   * clock rather than to the fetch clock.
   */
  it.each(SETTLED)(
    'queues a %s child whose fetch is recent but whose source data is past the TTL',
    async (status) => {
      /*
       * The fetch is recent enough that the TTL alone would still call this child fresh, so the
       * stamp is the only column left that can queue it — and old enough to clear the interval
       * that keeps a stamp which cannot advance off the queue on every drain.
       */
      const rows = siblings([
        {},
        {},
        { status, sourceSnapshotAt: ago(TILE_TTL_MS + 1), fetchedAt: ago(REFETCH_INTERVAL_MS * 2) },
        {},
      ]);
      const { db, recorded } = fakeDb(rows);

      const outcome = await queueStaleChildren(db, rows, NOW);

      expect(outcome.queued).toEqual([keys[2]]);
      expect(recorded.jobUpserts.map((job) => job.dedupeKey)).toEqual([jobKey(keys[2])]);
    },
  );

  it.each(SETTLED)(
    'leaves a %s child alone whose stale source was asked only moments ago',
    async (status) => {
      /*
       * `SPLIT_CHILD_ATTEMPT_CAP` cannot bound this one: it counts a child whose job reaches
       * `dead`, and a child whose fetch succeeds every time with data past the TTL settles
       * `done`. `enqueue` then revives it, and the parent is drained on every viewport poll for
       * as long as it is unpromoted — a query per poll that cannot move the stamp.
       */
      const rows = siblings([{}, {}, { status, sourceSnapshotAt: ago(TILE_TTL_MS + 1) }, {}]);
      const { db, recorded } = fakeDb(rows);

      const outcome = await queueStaleChildren(db, rows, NOW);

      expect(outcome.queued).toEqual([]);
      expect(recorded.jobUpserts).toEqual([]);
    },
  );

  it.each(SETTLED)(
    'leaves a %s child alone whose source data is still inside the TTL',
    async (status) => {
      // The boundary from the other side, so the reading cannot become "any stamp is stale".
      const rows = siblings([{}, {}, { status, sourceSnapshotAt: ago(TILE_TTL_MS - 1) }, {}]);
      const { db, recorded } = fakeDb(rows);

      const outcome = await queueStaleChildren(db, rows, NOW);

      expect(outcome.queued).toEqual([]);
      expect(recorded.jobUpserts).toEqual([]);
    },
  );

  it('leaves a child that predates the column on its fetch time alone', async () => {
    // The fallback, named rather than left to the default in `child()`: adding the column must
    // not re-queue every child written before it existed.
    const rows = siblings([{}, {}, { sourceSnapshotAt: null }, {}]);
    const { db, recorded } = fakeDb(rows);

    const outcome = await queueStaleChildren(db, rows, NOW);

    expect(outcome.queued).toEqual([]);
    expect(recorded.jobUpserts).toEqual([]);
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

/**
 * The rollback for `INGEST_SUBDIVIDE_MAX_ZOOM`, which the flag itself does not provide: lowering
 * the ceiling stops new splits, and `processTile` still routes any tile with four children to the
 * roll-up with no flag to read. Undoing one by hand is what wedged six parents for 39 hours, so
 * both halves have to happen together or not at all.
 */
describe('unsplitTile', () => {
  const CHILDREN = childQuadkeys(PARENT);
  const GRANDCHILDREN = childQuadkeys(CHILDREN[0]);

  interface UnsplitRecorded {
    transactions: number;
    /** Every operation the transaction body performed, in order, for the fence assertions. */
    steps: string[];
    deletedJobKeys: string[];
    deletedTiles: string[];
    parentUpdate: Record<string, unknown> | null;
    enqueued: string[];
  }

  function unsplitDb(
    tiles: string[],
    parentStatus: TileStatus | null = TileStatus.pending,
    runningJobs = 0,
  ): { db: PrismaClient; recorded: UnsplitRecorded } {
    const recorded: UnsplitRecorded = {
      transactions: 0,
      steps: [],
      deletedJobKeys: [],
      deletedTiles: [],
      parentUpdate: null,
      enqueued: [],
    };
    const db = {
      $transaction: (body: (tx: PrismaClient) => Promise<unknown>) => {
        recorded.transactions += 1;
        return body(db);
      },
      $executeRaw: (strings: TemplateStringsArray) => {
        recorded.steps.push(strings.join('?').includes('pg_advisory_xact_lock') ? 'lock' : 'raw');
        return Promise.resolve(1);
      },
      ingestTile: {
        findUnique: () => {
          recorded.steps.push('readParent');
          return Promise.resolve(parentStatus === null ? null : { status: parentStatus });
        },
        findMany: ({ where }: { where: { quadkey: { startsWith: string } } }) =>
          Promise.resolve(
            tiles
              .filter((key) => key.startsWith(where.quadkey.startsWith) && key !== PARENT)
              .map((quadkey) => ({ quadkey })),
          ),
        deleteMany: ({ where }: { where: { quadkey: { in: string[] } } }) => {
          recorded.steps.push('deleteTiles');
          recorded.deletedTiles.push(...where.quadkey.in);
          return Promise.resolve({ count: where.quadkey.in.length });
        },
        update: (args: { data: Record<string, unknown> }) => {
          recorded.steps.push('updateParent');
          recorded.parentUpdate = args.data;
          return Promise.resolve({});
        },
      },
      ingestJob: {
        count: () => {
          recorded.steps.push('countRunning');
          return Promise.resolve(runningJobs);
        },
        updateMany: () => Promise.resolve({ count: 0 }),
        deleteMany: ({ where }: { where: { dedupeKey: { in: string[] } } }) => {
          recorded.steps.push('deleteJobs');
          recorded.deletedJobKeys.push(...where.dedupeKey.in);
          return Promise.resolve({ count: where.dedupeKey.in.length });
        },
        upsert: (args: { where: { dedupeKey: string } }) => {
          recorded.enqueued.push(args.where.dedupeKey);
          return Promise.resolve({});
        },
      },
    } as unknown as PrismaClient;
    return { db, recorded };
  }

  it('removes the whole subtree, not only the four children', async () => {
    const { db, recorded } = unsplitDb([PARENT, ...CHILDREN, ...GRANDCHILDREN]);

    const result = await unsplitTile(db, PARENT);

    expect(result.descendantsRemoved).toBe(CHILDREN.length + GRANDCHILDREN.length);
    expect(recorded.deletedTiles).toEqual(expect.arrayContaining([...CHILDREN, ...GRANDCHILDREN]));
    expect(recorded.deletedTiles).not.toContain(PARENT);
  });

  /*
   * The wedge this exists to prevent: children gone, marker left behind. A parent claiming a
   * subdivision with nothing under it never fetches again until `reconcileOrphanedSplits`
   * happens to run.
   */
  it('clears the parent marker in the same transaction that deletes the children', async () => {
    const { db, recorded } = unsplitDb([PARENT, ...CHILDREN]);

    await unsplitTile(db, PARENT);

    expect(recorded.transactions).toBe(1);
    expect(recorded.parentUpdate).toMatchObject({ lastError: null });
  });

  it('re-queues the parent so the box is fetched whole again', async () => {
    const { db, recorded } = unsplitDb([PARENT, ...CHILDREN]);

    await unsplitTile(db, PARENT);

    expect(recorded.enqueued).toEqual([`ingest_tile:${PARENT}`]);
    expect(recorded.deletedJobKeys).toEqual(CHILDREN.map((key) => `ingest_tile:${key}`));
  });

  it('keeps a parent that is already serving data on the status it has', async () => {
    const { db, recorded } = unsplitDb([PARENT, ...CHILDREN], TileStatus.ready);

    const result = await unsplitTile(db, PARENT);

    expect(result.status).toBe(TileStatus.ready);
    expect(recorded.parentUpdate).toMatchObject({ status: TileStatus.ready });
  });

  it('refuses while a descendant is mid-drain, rather than racing its upsert', async () => {
    const { db, recorded } = unsplitDb([PARENT, ...CHILDREN], TileStatus.pending, 1);

    await expect(unsplitTile(db, PARENT)).rejects.toThrow(/still running/);
    expect(recorded.deletedTiles).toEqual([]);
    expect(recorded.deletedJobKeys).toEqual([]);
  });

  /*
   * The refusal is only worth anything if nothing can start between reading it and acting on it.
   * Every claim of a tile job is made under `DRAIN_ADMISSION_KEY`, so the count has to be taken
   * after this transaction holds that lock — a count outside it describes the moment before the
   * cron fired, and the operator does not control the cron's schedule.
   *
   * The parent's status is under the same rule and for the same reason: it is read here and
   * written back at the end, so a drain that changed it in between would have that change
   * silently overwritten with the value from before.
   */
  it('reads the running count and the parent status under the lock the drain claims through', async () => {
    const { db, recorded } = unsplitDb([PARENT, ...CHILDREN]);

    await unsplitTile(db, PARENT);

    expect(recorded.steps[0]).toBe('lock');
    expect(recorded.steps.indexOf('countRunning')).toBeGreaterThan(recorded.steps.indexOf('lock'));
    expect(recorded.steps.indexOf('readParent')).toBeGreaterThan(recorded.steps.indexOf('lock'));
    expect(recorded.steps.indexOf('countRunning')).toBeLessThan(
      recorded.steps.indexOf('deleteJobs'),
    );
  });

  it('refuses a quadkey with no tile row at all', async () => {
    const { db } = unsplitDb([], null);

    await expect(unsplitTile(db, PARENT)).rejects.toThrow(/no ingest_tiles row/);
  });
});
