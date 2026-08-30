import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TileSource, TileStatus, prisma } from '@switchback/db';
import { childQuadkeys, quadkeyToBBox, quadkeyToTile } from '@switchback/geo';
import { TerrainSource } from '../src/elevate';
import { processTile } from '../src/pipeline';
import type { PipelineDeps } from '../src/pipeline';
import type { OverpassElement, OverpassQuerier, OverpassResponse } from '../src/overpass';
import { EMPTY_WRITE_WINDOW_MS, readEmptyWriteRates } from '../src/maintenance';
import { tileJobKey, trailEnrichJobKey } from '../src/jobs';
import { CHILDREN_PER_TILE } from '../src/subdivide';
import { flatTile, pngResponse } from './fixtures/terrarium';

/**
 * Tile provenance and the empty-write share, against a real Postgres.
 *
 * Both are about what a column holds after a write, and a fake client returns whatever the test
 * handed it — which is the whole failure mode here, since the defect this guards against is a
 * column that reads plausible and says something false. The share is one `count(*) FILTER`
 * grouped by an enum; no fake shows whether that SQL groups or filters anything. Skipped unless
 * `DATABASE_URL` is local, as CI's `gates` job makes it.
 */
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

/**
 * A quadkey namespace this file owns, and a clock ahead of every other suite's.
 *
 * `222` and `333` are taken, and `rate-limit.db.test.ts` deletes its whole prefix rather than its
 * own keys — so a namespace here is a claim on the prefix, not on the keys inside it.
 *
 * `readEmptyWriteRates` has a lower bound and no upper one — a window that ends is not a thing
 * production ever wants — so a window anchored in the past would also count every tile the
 * suites running beside this one write at the real clock. Anchoring it ahead of them inverts
 * that: their writes fall before `NOW - EMPTY_WRITE_WINDOW_MS` and these fixtures are the only
 * rows the reading can see.
 */
const NS = '321';
const NOW = new Date('2027-01-08T12:00:00Z');
const INSIDE_WINDOW = new Date(NOW.getTime() - EMPTY_WRITE_WINDOW_MS / 2);
const BEFORE_WINDOW = new Date(NOW.getTime() - EMPTY_WRITE_WINDOW_MS - 60_000);

/** What the source says its own copy of OSM was current to — days behind the fetch, deliberately. */
const SNAPSHOT = new Date('2027-01-05T04:31:07Z');

const FILLED = `${NS}000000`;
const EMPTIED = `${NS}000001`;
const UNSTAMPED = `${NS}000002`;
const REFUSED = `${NS}000003`;
const SEEDED = [`${NS}000010`, `${NS}000011`, `${NS}000012`, `${NS}000013`];

/**
 * A z9 parent and its four z10 children, for the roll-up write.
 *
 * The only fixtures in this file below the zoom the others use, deliberately: `rollUpAncestors`
 * stops at `INGEST_ZOOM`, so nothing written at z9 can promote anything.
 */
const ROLLED_UP = `${NS}000020`;
const ROLLED_UP_CHILDREN = childQuadkeys(ROLLED_UP);

/** A z9 parent holding one child, which is all an interrupted `splitTile` leaves behind. */
const INTERRUPTED = `${NS}000030`;
const STRAY_CHILD = `${INTERRUPTED}0`;

/**
 * A parent for every child count a stalled `splitTile` can leave, `STALLED_PARENTS[n]` holding `n`.
 *
 * Sized off `CHILDREN_PER_TILE` so the sweep below covers the whole range whatever that number
 * becomes. The count doubles as the last quadkey digit, the two alphabets being the same one.
 */
const STALLED_PARENTS = Array.from({ length: CHILDREN_PER_TILE }, (_, held) => `${NS}00011${held}`);

/**
 * The count the sweep cannot reach: a parent holding the full set.
 *
 * Not a further entry in `STALLED_PARENTS`, which encodes the count it holds in the last quadkey
 * digit — and a quadkey has no digit `CHILDREN_PER_TILE`.
 */
const FULL_SET_PARENT = `${NS}000120`;

/**
 * A parent holding one child that was itself subdivided: one child, five descendants.
 *
 * The only shape that tells a count of children from a count of descendants apart. `splitTile`
 * enqueues each child as it upserts it, so a stray child an interrupted split left is already on
 * the queue, and one that runs out of Overpass clock subdivides in its turn — which z10 to z11
 * permits.
 */
const DEEP_SPLIT_PARENT = `${NS}000130`;
const DEEP_SPLIT_CHILD = childQuadkeys(DEEP_SPLIT_PARENT)[0];

/** One tile, re-seeded once per `TileStatus`, for the status the empty count names. */
const STATUS_TILE = `${NS}000200`;

const FIXTURE_TILES = [
  FILLED,
  EMPTIED,
  UNSTAMPED,
  REFUSED,
  ...SEEDED,
  ROLLED_UP,
  ...ROLLED_UP_CHILDREN,
  INTERRUPTED,
  STRAY_CHILD,
  ...STALLED_PARENTS.flatMap((parent) => [parent, ...childQuadkeys(parent)]),
  FULL_SET_PARENT,
  ...childQuadkeys(FULL_SET_PARENT),
  DEEP_SPLIT_PARENT,
  ...childQuadkeys(DEEP_SPLIT_PARENT),
  ...childQuadkeys(DEEP_SPLIT_CHILD),
  STATUS_TILE,
];

/** Every trail this file creates starts here, and the cleanup deletes on the prefix. */
const PREFIX = 'ZZ Provenance';

/** A named way down the middle of `quadkey`, long enough to survive `MIN_TRAIL_LENGTH_M`. */
function wayIn(quadkey: string, id: number): OverpassElement {
  const [west, south, east, north] = quadkeyToBBox(quadkey);
  const lat = (south + north) / 2;
  return {
    type: 'way',
    id,
    tags: { name: `${PREFIX} Ridge`, highway: 'path', surface: 'dirt' },
    geometry: [
      { lat, lon: west + (east - west) * 0.4 },
      { lat, lon: west + (east - west) * 0.6 },
    ],
  };
}

/** Answers the tile query with `response` and every `is_in` region query with nothing. */
function overpassOf(response: OverpassResponse): OverpassQuerier {
  return {
    query: (ql: string) =>
      Promise.resolve(ql.includes('is_in(') ? { elements: [] } : { ...response }),
  };
}

const terrain = new TerrainSource({
  fetchImpl: () => Promise.resolve(pngResponse(flatTile(1000))),
});

function deps(response: OverpassResponse): PipelineDeps {
  return {
    db: prisma,
    overpass: overpassOf(response),
    terrain,
    enrichWaypoints: false,
    now: () => NOW,
  } satisfies PipelineDeps;
}

function tileRow(quadkey: string) {
  return prisma.ingestTile.findUniqueOrThrow({
    where: { quadkey },
    select: { status: true, fetchedAt: true, sourceSnapshotAt: true, sourceKind: true },
  });
}

/** A tile written by a fetch that landed at `fetchedAt`, without running the pipeline for it. */
async function seedWrite(
  quadkey: string,
  status: TileStatus,
  fetchedAt: Date | null,
  sourceKind: TileSource | null = TileSource.overpass,
): Promise<void> {
  const { x, y, z } = quadkeyToTile(quadkey);
  const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(quadkey);
  await prisma.ingestTile.create({
    data: { quadkey, x, y, z, status, bboxW, bboxS, bboxE, bboxN, fetchedAt, sourceKind },
  });
}

/**
 * A parent that answered inside the window, under `held` children a subdivision left behind.
 *
 * The one seeder for both sides of the child-count boundary, so the count is all that changes
 * across it: every child is `pending` with no `fetchedAt` and no `sourceKind`, a set `rollUp`
 * refuses at any size, and the parent's own row is a source's answer at every size.
 */
async function seedParentHolding(parent: string, held: number): Promise<void> {
  for (const child of childQuadkeys(parent).slice(0, held)) {
    await seedWrite(child, TileStatus.pending, null, null);
  }
  await seedWrite(parent, TileStatus.empty, INSIDE_WINDOW, TileSource.overpass);
}

/** The window's reading for one source, or zeroes when it wrote nothing inside it. */
async function shareFor(source: TileSource | null) {
  const rates = await readEmptyWriteRates(prisma, NOW);
  return rates.find((rate) => rate.source === source) ?? { source, written: 0, empty: 0 };
}

async function cleanup(): Promise<void> {
  const doomed = await prisma.trail.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = doomed.map((row) => row.id);
  await prisma.ingestJob.deleteMany({
    where: { dedupeKey: { in: [...ids.map(trailEnrichJobKey), ...FIXTURE_TILES.map(tileJobKey)] } },
  });
  await prisma.trail.deleteMany({ where: { id: { in: ids } } });
  await prisma.ingestTile.deleteMany({ where: { quadkey: { in: FIXTURE_TILES } } });
}

/**
 * What the tile row says about the answer that filled it.
 *
 * The product tells a reader "Reconciled with OSM on ..." off a stamp, so a stamp taken from the
 * local clock is a claim about OSM made out of nothing. `osm3s.timestamp_osm_base` is the only
 * value in the response that answers the question actually being asked.
 */
describe.runIf(IS_LOCAL).sequential('the provenance a tile fetch records', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('stamps the source’s own snapshot, not the moment we asked', async () => {
    await processTile(
      FILLED,
      deps({
        elements: [wayIn(FILLED, 930_001)],
        osm3s: { timestamp_osm_base: SNAPSHOT.toISOString() },
      }),
    );

    const row = await tileRow(FILLED);
    expect(row.status).toBe(TileStatus.ready);
    expect(row.sourceSnapshotAt).toEqual(SNAPSHOT);
    expect(row.sourceKind).toBe(TileSource.overpass);
    // The distinction the column exists for: the fetch and the data behind it are days apart.
    expect(row.fetchedAt).toEqual(NOW);
    expect(row.sourceSnapshotAt).not.toEqual(row.fetchedAt);
  });

  it('stamps a tile it wrote empty too, so an empty write can be attributed', async () => {
    await processTile(
      EMPTIED,
      deps({ elements: [], osm3s: { timestamp_osm_base: SNAPSHOT.toISOString() } }),
    );

    const row = await tileRow(EMPTIED);
    expect(row.status).toBe(TileStatus.empty);
    expect(row.sourceKind).toBe(TileSource.overpass);
    expect(row.sourceSnapshotAt).toEqual(SNAPSHOT);
  });

  it('leaves the snapshot null on an answer that carried none, and still names the source', async () => {
    await processTile(UNSTAMPED, deps({ elements: [] }));

    const row = await tileRow(UNSTAMPED);
    expect(row.sourceSnapshotAt).toBeNull();
    expect(row.sourceKind).toBe(TileSource.overpass);
  });
});

/**
 * The empty-write share against a real database.
 *
 * The detector for a source that answers an out-of-area query `200 OK` with zero elements: that
 * response is indistinguishable from ocean on the tile it lands on and is cached `empty` for
 * thirty days. Nothing else in the estate records it.
 */
describe.runIf(IS_LOCAL).sequential('the empty-write share', () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('weighs the tiles a source emptied against the tiles it filled', async () => {
    await processTile(
      FILLED,
      deps({
        elements: [wayIn(FILLED, 930_002)],
        osm3s: { timestamp_osm_base: SNAPSHOT.toISOString() },
      }),
    );
    await processTile(EMPTIED, deps({ elements: [] }));
    await processTile(UNSTAMPED, deps({ elements: [] }));

    expect(await shareFor(TileSource.overpass)).toEqual({
      source: TileSource.overpass,
      written: 3,
      empty: 2,
    });
  });

  it('counts each source on its own, so one cannot hide inside another’s total', async () => {
    // The comparison the whole signal is for. Until a second source exists the split is
    // degenerate, and a reading that collapsed the groups would look identical to this one.
    await seedWrite(SEEDED[0]!, TileStatus.empty, INSIDE_WINDOW, TileSource.overpass);
    await seedWrite(SEEDED[1]!, TileStatus.ready, INSIDE_WINDOW, TileSource.overpass);
    await seedWrite(SEEDED[2]!, TileStatus.empty, INSIDE_WINDOW, null);

    expect(await shareFor(TileSource.overpass)).toEqual({
      source: TileSource.overpass,
      written: 2,
      empty: 1,
    });
    expect(await shareFor(null)).toEqual({ source: null, written: 1, empty: 1 });
  });

  it('leaves a write older than the window out of both counts', async () => {
    // Without this the denominator is every tile ever written and the share can no longer move.
    await seedWrite(SEEDED[0]!, TileStatus.empty, BEFORE_WINDOW);
    await seedWrite(SEEDED[1]!, TileStatus.empty, INSIDE_WINDOW);

    expect(await shareFor(TileSource.overpass)).toEqual({
      source: TileSource.overpass,
      written: 1,
      empty: 1,
    });
  });

  it('counts a fetch that failed in neither total, having written no data either way', async () => {
    const refused = {
      ...deps({ elements: [] }),
      overpass: { query: () => Promise.reject(new Error('overpass 504 gateway timeout')) },
    } satisfies PipelineDeps;

    await expect(processTile(REFUSED, refused)).rejects.toThrow(/504/);

    /*
     * Moved into the window on purpose. `updatedAt` is the row's own clock and a failed attempt
     * bumps it, so without this the tile would fall outside the reading for a reason that has
     * nothing to do with the claim — and a share counting attempts rather than writes would pass
     * this test unchanged.
     */
    await prisma.$executeRaw`
      UPDATE ingest_tiles SET "updatedAt" = ${INSIDE_WINDOW} WHERE quadkey = ${REFUSED}
    `;

    const row = await tileRow(REFUSED);
    expect(row.status).toBe(TileStatus.failed);
    expect(row.fetchedAt).toBeNull();
    // The whole reading, not one source's row: the failure wrote no `sourceKind` either, so
    // asking for the Overpass group alone would answer zero whether or not the tile was counted.
    expect(await readEmptyWriteRates(prisma, NOW)).toEqual([]);
  });

  /**
   * The half of the separation that needs a real table: the tiles are there, inside the window,
   * attributed to a source, and countable.
   *
   * That they stay out of `QueueHealth` is asserted in `maintenance.test.ts`, where the reading is
   * decided by fixtures alone — `queueHealth` reads whole tables, so a delta taken here would be
   * measuring whatever the suites running beside this one happen to be writing.
   */
  it('counts a window of tiles a source wrote empty', async () => {
    for (const quadkey of SEEDED) await seedWrite(quadkey, TileStatus.empty, INSIDE_WINDOW);

    expect(await shareFor(TileSource.overpass)).toEqual({
      source: TileSource.overpass,
      written: SEEDED.length,
      empty: SEEDED.length,
    });
  });

  /**
   * A row a roll-up filled, which no source ever answered about.
   *
   * `promoteFrom` composes a parent from its children and is the only path outside `processTile`
   * that moves `fetchedAt` on `ingest_tiles`. It runs after every tile a fetch finishes, so a
   * reading windowed on that column alone counted one derived row per ancestor on top of the
   * answers underneath it — inflating the denominator everywhere, and over ground whose children
   * all come back empty the numerator with it.
   */
  it('leaves out a parent a roll-up filled, which no source answered about', async () => {
    const [first, second, third, fetched] = ROLLED_UP_CHILDREN;
    await seedWrite(ROLLED_UP, TileStatus.ready, BEFORE_WINDOW);
    await seedWrite(first, TileStatus.empty, INSIDE_WINDOW);
    await seedWrite(second, TileStatus.empty, INSIDE_WINDOW);
    await seedWrite(third, TileStatus.ready, INSIDE_WINDOW);

    await processTile(fetched, deps({ elements: [] }));

    // The roll-up landed, and it moved the parent into the window. Without this the count below
    // would also be right on a run that promoted nothing, which is the same green for the wrong
    // reason.
    const parent = await tileRow(ROLLED_UP);
    expect(parent.status).toBe(TileStatus.ready);
    expect(parent.fetchedAt).toEqual(INSIDE_WINDOW);

    // Four answers — three seeded, one fetched — and not the fifth row the roll-up wrote.
    expect(await shareFor(TileSource.overpass)).toEqual({
      source: TileSource.overpass,
      written: 4,
      empty: 3,
    });
  });

  /**
   * A parent that answered for itself while one child of a stalled subdivision sits beside it.
   *
   * `splitTile` upserts its four children one at a time outside a transaction and writes the
   * parent's marker last, so a host kill part-way through leaves 1–3 children and no marker —
   * a state nothing repairs, since `reconcileOrphanedSplits` keys on the marker and `processTile`
   * promotes only at four. The parent is re-fetched on the ordinary path and the row is its own
   * answer, which is exactly the hazard this reading exists to see. An exclusion keyed on *any*
   * child would drop it from both counts for as long as the stray row lives.
   */
  it('counts a tile that answered for itself, beside a child a stalled split left', async () => {
    await seedWrite(STRAY_CHILD, TileStatus.pending, null, null);

    await processTile(INTERRUPTED, deps({ elements: [] }));

    // The parent's own write, from the ordinary fetch path rather than from a roll-up.
    const parent = await tileRow(INTERRUPTED);
    expect(parent.status).toBe(TileStatus.empty);
    expect(parent.fetchedAt).toEqual(NOW);
    expect(parent.sourceKind).toBe(TileSource.overpass);

    expect(await shareFor(TileSource.overpass)).toEqual({
      source: TileSource.overpass,
      written: 1,
      empty: 1,
    });
  });

  /**
   * Every child count short of a full set, each against its own reading.
   *
   * A host kill mid-`splitTile` leaves any of these counts, and `rollUp` returns null below
   * `CHILDREN_PER_TILE`, so none of them can be the derived row this exclusion drops. Asserting
   * only the ends leaves the comparison free to be `< 2` or `< 3` — an exclusion wider than the
   * roll-up's precondition, which discards a real answer for as long as the stray children live.
   * The full set is the boundary's other half, seeded below out of the same `seedParentHolding`,
   * so the count is the only thing that differs across it.
   *
   * One reading per count rather than one total over all of them, for the diagnosis and not the
   * detection: `count(*) < N` is unbounded below, so a threshold that moves keeps a prefix and a
   * single total over the range moves with it. What a total cannot do is name the count that moved.
   */
  it.each(STALLED_PARENTS.map((_, held) => held))(
    'counts a parent holding %i children, short of the full set a roll-up needs',
    async (held) => {
      await seedParentHolding(STALLED_PARENTS[held]!, held);

      // One parent in the window, so the total names which row was kept and not merely how many.
      expect(await shareFor(TileSource.overpass)).toEqual({
        source: TileSource.overpass,
        written: 1,
        empty: 1,
      });
    },
  );

  /**
   * The boundary's other half: a full set of children, none of them a roll-up could have used.
   *
   * The exclusion counts children and reads nothing off them, which is what makes it the roll-up's
   * precondition taken conservatively — a box split into four no longer stands for ground one
   * answer covers, whether or not the split ever finished. Counting only the children that carry
   * a `sourceKind`, or a `fetchedAt`, or a status past `pending` reads the same on every other
   * fixture in this file, and only the first is dangerous: `rollUp` refuses unless all four
   * children are settled and stamped, so the other two still exclude every row `promoteFrom`
   * writes and merely narrow the exclusion's conservatism. `sourceKind` is the one column that
   * precondition does not constrain — null on every row a fetch wrote before provenance was
   * recorded, so under a parent whose children predate the column such a predicate counts zero,
   * and each row `promoteFrom` composed returns to both totals at every zoom above the answer.
   */
  it('leaves out a parent holding a full set of children, whatever those children hold', async () => {
    await seedParentHolding(FULL_SET_PARENT, CHILDREN_PER_TILE);

    // The parent is inside the window and attributed, so the zeroes below are the exclusion and
    // not a fixture that never landed.
    const parent = await tileRow(FULL_SET_PARENT);
    expect(parent.fetchedAt).toEqual(INSIDE_WINDOW);
    expect(parent.sourceKind).toBe(TileSource.overpass);

    expect(await shareFor(TileSource.overpass)).toEqual({
      source: TileSource.overpass,
      written: 0,
      empty: 0,
    });
  });

  /**
   * A stray child of a stalled split, subdivided in its turn.
   *
   * The exclusion probes the four immediate children by primary key, and only a subtree deeper
   * than one level tells that apart from a count of descendants. The distinction is one character
   * wide: `countOrphanedSplits` takes the same count with `LIKE parent.quadkey || '_'`, and the
   * prefix form of that counts the whole subtree — reintroducing through the depth what
   * `< CHILDREN_PER_TILE` refuses through the threshold, and dropping this parent's own answer
   * from both totals for as long as the stray subtree lives.
   */
  it('counts a parent holding one child, however deep that child was split', async () => {
    await seedParentHolding(DEEP_SPLIT_PARENT, 1);
    for (const grandchild of childQuadkeys(DEEP_SPLIT_CHILD)) {
      await seedWrite(grandchild, TileStatus.pending, null, null);
    }

    // The subtree is on the ground, so the reading below is the exclusion counting one level and
    // not a fixture that never landed.
    const descendants = await prisma.ingestTile.count({
      where: { quadkey: { startsWith: DEEP_SPLIT_CHILD } },
    });
    expect(descendants).toBe(CHILDREN_PER_TILE + 1);

    expect(await shareFor(TileSource.overpass)).toEqual({
      source: TileSource.overpass,
      written: 1,
      empty: 1,
    });
  });

  /**
   * Every status the enum holds, against a numerator that names exactly one of them.
   *
   * `status = 'empty'` and `status <> 'ready'` differ only on a tile that is neither, and this
   * estate leaves three such rows inside the window: `processTile` re-enters a tile that answered
   * before at `running`, its catch writes `failed`, and `splitTile` returns a parent to `pending`
   * when what it split was not settled. None of the three moves `fetchedAt`, so a tile that
   * answered once stays in the denominator under a status no other fixture here constructs.
   * Swept off `TileStatus` rather than a chosen status, so a sixth arrives with its own case.
   */
  it.each(Object.values(TileStatus))(
    'counts a %s tile as a write, and in the empty count only when it is empty',
    async (status) => {
      await seedWrite(STATUS_TILE, status, INSIDE_WINDOW);

      expect(await shareFor(TileSource.overpass)).toEqual({
        source: TileSource.overpass,
        written: 1,
        empty: status === TileStatus.empty ? 1 : 0,
      });
    },
  );
});
