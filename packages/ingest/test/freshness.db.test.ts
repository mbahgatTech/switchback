import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JobKind, JobStatus, TileStatus, prisma } from '@switchback/db';
import { childQuadkeys, quadkeyToBBox, quadkeyToTile } from '@switchback/geo';
import type { BBox } from '@switchback/core';
import { ensureCoverage, surveyArea } from '../src/coverage';
import { REFETCH_INTERVAL_MS, TILE_TTL_MS, isTileFresh, isTileSettled } from '../src/freshness';
import { tileJobKey } from '../src/jobs';
import { STALE_SOURCE_MARKER, processTile } from '../src/pipeline';
import type { PipelineDeps } from '../src/pipeline';
import { promoteFrom } from '../src/subdivide';

/**
 * Freshness against a real Postgres.
 *
 * The unit tests pin what `isTileFresh` decides once it holds a row. They cannot pin that the
 * row arrives holding `sourceSnapshotAt` at all: every caller names its columns in a Prisma
 * `select`, the in-memory fakes elsewhere in this suite return whatever the fixture literal
 * holds regardless of what was selected, and a `select` that omits the column would leave the
 * predicate reading `undefined` and silently answering the old, weaker question. Only a real
 * query proves the column survives the round trip — in either direction, which is why the
 * roll-up's write of it is pinned here too rather than on `rollUp`'s return value alone.
 */
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

/** A quadkey namespace owned by this file alone, so the cleanup can delete by name. */
const NS = '301';

/** Fetched a moment ago from a source whose data was current. Genuinely fresh. */
const CURRENT = `${NS}000000`;
/** Fetched a moment ago from a source whose data was already past the TTL. The lie. */
const STALE_SOURCE = `${NS}000001`;
/** Fetched a moment ago, with no source stamp at all — every row predating the column. */
const UNSTAMPED = `${NS}000002`;

/**
 * Three parents a roll-up composes out of a full set of real children, one per stamp those
 * children can carry. `surveyArea` covers at `INGEST_ZOOM`, so a parent at that zoom — not the
 * children under it — is the row a reader is actually judged on.
 */
const ROLLED_UP_STALE = `${NS}000010`;
const ROLLED_UP_CURRENT = `${NS}000011`;
const ROLLED_UP_UNSTAMPED = `${NS}000012`;
/** The fourth: a parent an extract answered `empty` on all four quarters. */
const ROLLED_UP_EMPTY = `${NS}000013`;
const ROLLED_UP = [ROLLED_UP_STALE, ROLLED_UP_CURRENT, ROLLED_UP_UNSTAMPED, ROLLED_UP_EMPTY];

/**
 * The same three stamps again, for the viewport reader rather than the area survey. Their own
 * quadkeys because this reader queues, and a survey must not inherit a job it did not ask for.
 */
const VIEWED_STALE_SOURCE = `${NS}000020`;
const VIEWED_CURRENT = `${NS}000021`;
const VIEWED_UNSTAMPED = `${NS}000022`;
const VIEWED = [VIEWED_STALE_SOURCE, VIEWED_CURRENT, VIEWED_UNSTAMPED];

/**
 * Two parents already split into four children, for the reader that judges the split tier. Their
 * own quadkeys because this reader queues the children it finds stale, and a block above must not
 * inherit a job it did not ask for.
 */
const SPLIT_STALE_SOURCE = `${NS}000030`;
const SPLIT_CURRENT = `${NS}000031`;
const SPLIT = [SPLIT_STALE_SOURCE, SPLIT_CURRENT];

/**
 * Every status the predicate serves, from the helper rather than named here. The blocks below
 * are parameterised over it, so a settled status the stamp is never asked about would have to be
 * added to `isTileSettled` and left out of the tests in the same edit.
 */
const SETTLED = Object.values(TileStatus).filter(isTileSettled);

/**
 * One tile per reading, re-seeded per status by the block that owns them — cheaper than a quadkey
 * per status, and a quadkey has only four digits to spend at each level.
 */
const SETTLED_STALE_SOURCE = `${NS}000100`;
const SETTLED_CURRENT = `${NS}000101`;

/** The tile a partial extract writes: `200 OK`, zero elements, and the extract's own date. */
const EXTRACT_EMPTY = `${NS}000102`;

/** The same answer, given over and over, to count what a source that cannot advance costs. */
const LOOPING = `${NS}000103`;

const FIXTURES = [
  CURRENT,
  STALE_SOURCE,
  UNSTAMPED,
  SETTLED_STALE_SOURCE,
  SETTLED_CURRENT,
  EXTRACT_EMPTY,
  LOOPING,
  ...VIEWED,
  ...[...ROLLED_UP, ...SPLIT].flatMap((parent) => [parent, ...childQuadkeys(parent)]),
];

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** A day either side of the TTL, so moving the TTL moves every fixture judged against it. */
const INSIDE_TTL = ago(TILE_TTL_MS - 86_400_000);
const PAST_TTL = ago(TILE_TTL_MS + 86_400_000);

/**
 * A fetch old enough to clear `REFETCH_INTERVAL_MS` and recent enough to stay well inside
 * `TILE_TTL_MS`, derived from both so moving either moves the fixture with it. A tile seeded with
 * it is fresh on its fetch clock alone, which leaves the source stamp the only column that can
 * put it back on the queue.
 */
const ASKED_BEFORE = ago(REFETCH_INTERVAL_MS * 2);

/**
 * The premise every re-queue below rests on, pinned rather than assumed. Should the two constants
 * ever cross, `ASKED_BEFORE` would expire on the fetch clock and those tests would go green
 * without the source stamp deciding anything — which is the reading they exist to take.
 */
describe('the fetch clock the re-queue fixtures are seeded with', () => {
  it('is one the TTL alone would still call fresh', () => {
    expect(
      isTileFresh(
        { status: TileStatus.ready, fetchedAt: ASKED_BEFORE, sourceSnapshotAt: null },
        NOW,
      ),
    ).toBe(true);
  });
});

/**
 * A bbox that covers this tile and cannot spill into its neighbours. The tile's own bbox shares
 * all four edges with them, and the cover is taken from the centre outwards, so a pinpoint box
 * at the centre is what selects exactly one quadkey.
 */
function centreOf(quadkey: string): BBox {
  const [w, s, e, n] = quadkeyToBBox(quadkey);
  const [lng, lat] = [(w + e) / 2, (s + n) / 2];
  return [lng - 1e-6, lat - 1e-6, lng + 1e-6, lat + 1e-6];
}

/** The columns a tile row derives from its quadkey alone. */
function tileGeometry(quadkey: string) {
  const { x, y, z } = quadkeyToTile(quadkey);
  const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(quadkey);
  return { quadkey, x, y, z, bboxW, bboxS, bboxE, bboxN };
}

async function seedTile(
  quadkey: string,
  sourceSnapshotAt: Date | null,
  status: TileStatus = TileStatus.ready,
  fetchedAt: Date = NOW,
): Promise<void> {
  await prisma.ingestTile.create({
    data: {
      ...tileGeometry(quadkey),
      status,
      // The row invariant the writer keeps, not a knob: `processTile` writes `empty` exactly
      // when it assembled no trails.
      trailCount: status === TileStatus.empty ? 0 : 1,
      // `NOW` unless a block is about the fetch clock itself, so whatever these tiles are
      // judged on, it is not this.
      fetchedAt,
      sourceSnapshotAt,
    },
  });
}

/** A parent as a split leaves it: a row holding nothing a roll-up has not put there yet. */
async function seedUnpromoted(quadkey: string): Promise<void> {
  await prisma.ingestTile.create({
    data: { ...tileGeometry(quadkey), status: TileStatus.pending },
  });
}

/**
 * A parent as a split leaves it: an unpromoted row over a full set of real children, each
 * stamped by `stampAt`. Every child's fetch is `NOW`, so whatever these fixtures are judged on,
 * it is not the fetch clock.
 */
async function seedSplit(
  parent: string,
  stampAt: (index: number, count: number) => Date | null,
  statusAt: (index: number, count: number) => TileStatus = () => TileStatus.ready,
  fetchedAt: Date = NOW,
): Promise<string[]> {
  await seedUnpromoted(parent);
  const children = childQuadkeys(parent);
  for (const [index, child] of children.entries()) {
    await seedTile(
      child,
      stampAt(index, children.length),
      statusAt(index, children.length),
      fetchedAt,
    );
  }
  return children;
}

/**
 * Compose `parent` from a full set of real children, each stamped by `stampAt`, through the
 * roll-up the pipeline promotes with. Every child's fetch is `NOW`, so the parent's own fetch
 * clock reports fresh whichever children it was built from — leaving the source stamp the only
 * column left that can decide the survey.
 */
async function promoteParent(
  parent: string,
  stampAt: (index: number, count: number) => Date | null,
  statusAt?: (index: number, count: number) => TileStatus,
): Promise<void> {
  await seedSplit(parent, stampAt, statusAt);
  await promoteFrom(prisma, parent);
}

/**
 * `value` on a child that is neither the first of the set nor the last, so a reader reaching for
 * one end of the set is caught alongside one that ignores the column altogether.
 */
const inTheMiddle =
  <T>(value: T, rest: T) =>
  (index: number, count: number): T =>
    index === Math.floor(count / 2) ? value : rest;

/** The stamp form of `inTheMiddle`: one child cut at `oldest`, the rest current. */
const oldestInTheMiddle = (oldest: Date) => inTheMiddle<Date>(oldest, NOW);

/** The three columns freshness is decided on, off the row as it actually landed. */
function freshnessRow(quadkey: string) {
  return prisma.ingestTile.findUniqueOrThrow({
    where: { quadkey },
    select: { status: true, fetchedAt: true, sourceSnapshotAt: true },
  });
}

/**
 * A fetch already on this tile's queue.
 *
 * Load-bearing, not scenery: `ensureCoverage` runs admission over *new ground* only, so a tile
 * already in flight never reaches `admitIngest` — which counts queued jobs database-wide and
 * would otherwise let another agent's queue decide this test. The re-enqueue then lands on this
 * row as a priority bump, so the run leaves behind nothing `cleanup` does not take.
 */
async function seedQueuedJob(quadkey: string): Promise<void> {
  await prisma.ingestJob.create({
    data: {
      kind: JobKind.ingest_tile,
      dedupeKey: tileJobKey(quadkey),
      payload: { quadkey },
      status: JobStatus.queued,
    },
  });
}

/** What a viewport poll makes of the single tile `quadkey` covers. */
function viewportOver(quadkey: string) {
  return ensureCoverage(centreOf(quadkey), { db: prisma, now: NOW, principal: null, maxTiles: 4 });
}

/**
 * A source stuck at `stamp` however often it is asked, and a count of what asking costs.
 *
 * Its clock is a variable because the whole reading is about elapsed time, and the query count is
 * the measurement: a tile this source can never make fresh still has to cost one query per
 * `REFETCH_INTERVAL_MS` rather than one per poll.
 */
function stuckSource(stamp: Date) {
  const state = { at: NOW, queries: 0 };
  const deps: PipelineDeps = {
    db: prisma,
    now: () => state.at,
    overpass: {
      query: () => {
        state.queries += 1;
        return Promise.resolve({
          elements: [],
          osm3s: { timestamp_osm_base: stamp.toISOString() },
        });
      },
    },
  };
  return { state, deps };
}

/**
 * One viewport poll and the drain it asks for — the loop an open map actually runs.
 *
 * `refreshing` decides rather than `queued` because `queueTiles` puts new ground through
 * `admitIngest`, which counts queued jobs database-wide and would let another agent's queue
 * answer this. `refreshing` is written before admission and says the same thing: this poll wants
 * the tile fetched.
 */
async function pollAndDrain(
  quadkey: string,
  at: Date,
  source: ReturnType<typeof stuckSource>,
): Promise<boolean> {
  source.state.at = at;
  const view = await ensureCoverage(centreOf(quadkey), {
    db: prisma,
    now: at,
    principal: null,
    maxTiles: 4,
  });
  const wanted = view.refreshing.includes(quadkey) || view.pending.includes(quadkey);
  if (wanted) await processTile(quadkey, source.deps);
  return wanted;
}

/**
 * A drain of a split parent through the production path.
 *
 * `processTile` hands a tile that already has four children to the roll-up before it reaches a
 * source, so the querier here refuses rather than answers: a drain that got as far as querying
 * has taken a path this block is not about, and should fail loudly instead of quietly passing.
 */
function drainSplitParent(parent: string) {
  const deps: PipelineDeps = {
    db: prisma,
    now: () => NOW,
    overpass: { query: () => Promise.reject(new Error('a split parent must not query a source')) },
  };
  return processTile(parent, deps);
}

/** The children of `parent` sitting on the queue, in quadkey order. */
async function queuedChildren(parent: string): Promise<string[]> {
  const children = childQuadkeys(parent);
  const jobs = await prisma.ingestJob.findMany({
    where: { dedupeKey: { in: children.map(tileJobKey) }, status: JobStatus.queued },
    select: { dedupeKey: true },
  });
  const queued = new Set(jobs.map((job) => job.dedupeKey));
  return children.filter((child) => queued.has(tileJobKey(child)));
}

const cleanup = async (): Promise<void> => {
  await prisma.ingestJob.deleteMany({ where: { dedupeKey: { in: FIXTURES.map(tileJobKey) } } });
  await prisma.ingestTile.deleteMany({ where: { quadkey: { in: FIXTURES } } });
};

describe.runIf(IS_LOCAL).sequential('freshness against a real database', () => {
  beforeEach(async () => {
    await cleanup();
    await seedTile(CURRENT, INSIDE_TTL);
    await seedTile(STALE_SOURCE, PAST_TTL);
    await seedTile(UNSTAMPED, null);
  });

  afterAll(cleanup);

  it('does not report a tile fresh when the source data behind it is past the TTL', async () => {
    const survey = await surveyArea(centreOf(STALE_SOURCE), { db: prisma, now: NOW, maxTiles: 4 });

    expect(survey.quadkeys).toContain(STALE_SOURCE);
    expect(survey.fresh).not.toContain(STALE_SOURCE);
    expect(survey.outstanding).toContain(STALE_SOURCE);
  });

  it('still reports a tile fresh when the source data behind it is inside the TTL', async () => {
    const survey = await surveyArea(centreOf(CURRENT), { db: prisma, now: NOW, maxTiles: 4 });

    expect(survey.fresh).toContain(CURRENT);
  });

  it('serves a row that predates the column on its fetch time alone', async () => {
    const survey = await surveyArea(centreOf(UNSTAMPED), { db: prisma, now: NOW, maxTiles: 4 });

    expect(survey.fresh).toContain(UNSTAMPED);
  });
});

/**
 * The write end of the same column: a parent row no source ever answered about.
 *
 * `rollUp` is a pure function of four rows and its unit tests read its return value, which says
 * nothing about whether that value reaches `ingest_tiles`. A column list in `promoteFrom` that
 * omitted the stamp would leave every promoted parent unstamped, and the z9 tier that
 * `ensureCoverage` and `surveyArea` actually read would go back to being judged on fetch time.
 *
 * Asked of every settled status the deciding child can hold, and of a parent composed entirely of
 * `empty` quarters. A roll-up that dropped the stamp for those alone leaves a z9 parent judged on
 * its fetch clock, and the two readers above are the only paths back to a re-fetch at that zoom —
 * so the ground under it is never re-queried and the map over it stays blank.
 */
describe.runIf(IS_LOCAL).sequential('the freshness a roll-up hands its parent', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it.each(SETTLED)(
    'writes the stalest child’s source stamp when that child is %s, and is judged stale on it',
    async (status) => {
      await promoteParent(
        ROLLED_UP_STALE,
        oldestInTheMiddle(PAST_TTL),
        inTheMiddle(status, TileStatus.ready),
      );

      // The stamp on the row, before the reading taken from it: the parent's own `fetchedAt` is
      // `NOW`, so a survey calling this tile stale for any other reason is a green for nothing.
      const row = await freshnessRow(ROLLED_UP_STALE);
      expect(row.status).toBe(TileStatus.ready);
      expect(row.fetchedAt).toEqual(NOW);
      expect(row.sourceSnapshotAt).toEqual(PAST_TTL);

      const survey = await surveyArea(centreOf(ROLLED_UP_STALE), {
        db: prisma,
        now: NOW,
        maxTiles: 4,
      });
      expect(survey.quadkeys).toContain(ROLLED_UP_STALE);
      expect(survey.fresh).not.toContain(ROLLED_UP_STALE);
      expect(survey.outstanding).toContain(ROLLED_UP_STALE);
    },
  );

  it('writes the stamp of a parent every one of whose quarters came back empty', async () => {
    // Four `200 OK`s with zero elements is what a partial extract answers over out-of-area
    // ground, and the parent it composes still has a data age. Unstamped it is judged on a fetch
    // clock the next pass over the same extract resets, and no sweep revisits it: `promoteFrom`
    // has just cleared the split marker `reconcileOrphanedSplits` looks for.
    await promoteParent(ROLLED_UP_EMPTY, oldestInTheMiddle(PAST_TTL), () => TileStatus.empty);

    const row = await freshnessRow(ROLLED_UP_EMPTY);
    expect(row.status).toBe(TileStatus.empty);
    expect(row.fetchedAt).toEqual(NOW);
    expect(row.sourceSnapshotAt).toEqual(PAST_TTL);

    const survey = await surveyArea(centreOf(ROLLED_UP_EMPTY), {
      db: prisma,
      now: NOW,
      maxTiles: 4,
    });
    expect(survey.quadkeys).toContain(ROLLED_UP_EMPTY);
    expect(survey.fresh).not.toContain(ROLLED_UP_EMPTY);
    expect(survey.outstanding).toContain(ROLLED_UP_EMPTY);
  });

  it('leaves a parent fresh when every child’s source data is inside the TTL', async () => {
    await promoteParent(ROLLED_UP_CURRENT, oldestInTheMiddle(INSIDE_TTL));

    expect((await freshnessRow(ROLLED_UP_CURRENT)).sourceSnapshotAt).toEqual(INSIDE_TTL);

    const survey = await surveyArea(centreOf(ROLLED_UP_CURRENT), {
      db: prisma,
      now: NOW,
      maxTiles: 4,
    });
    expect(survey.fresh).toContain(ROLLED_UP_CURRENT);
  });

  it('leaves a parent whose children carried no stamp on its fetch time alone', async () => {
    await promoteParent(ROLLED_UP_UNSTAMPED, () => null);

    // Null rather than left alone: a parent holding a stamp no child carried would be claiming
    // an age for data that never reported one.
    expect((await freshnessRow(ROLLED_UP_UNSTAMPED)).sourceSnapshotAt).toBeNull();

    const survey = await surveyArea(centreOf(ROLLED_UP_UNSTAMPED), {
      db: prisma,
      now: NOW,
      maxTiles: 4,
    });
    expect(survey.fresh).toContain(ROLLED_UP_UNSTAMPED);
  });
});

/**
 * The same reading, taken through the viewport path.
 *
 * `surveyArea` above proves the column survives one caller's round trip. `ensureCoverage` is the
 * other, it names its own columns in its own `select`, and it is the reader every open map polls
 * every few seconds. A select that stopped loading the stamp there — or a row rebuilt without it
 * on the way to the predicate — would put the whole viewport tier back on fetch time alone while
 * every test above stayed green.
 */
describe.runIf(IS_LOCAL).sequential('the freshness a viewport is judged on', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('re-queues a tile whose fetch is recent but whose source data is past the TTL', async () => {
    await seedTile(VIEWED_STALE_SOURCE, PAST_TTL, TileStatus.ready, ASKED_BEFORE);
    await seedQueuedJob(VIEWED_STALE_SOURCE);

    const view = await viewportOver(VIEWED_STALE_SOURCE);

    // One tile, so `refreshing` and `queued` are about this row and no other.
    expect(view.quadkeys).toEqual([VIEWED_STALE_SOURCE]);
    // Both served and refreshed: the trails it holds keep being drawn under the fetch it earned.
    expect(view.ready).toEqual([VIEWED_STALE_SOURCE]);
    expect(view.refreshing).toEqual([VIEWED_STALE_SOURCE]);
    expect(view.queued).toEqual([VIEWED_STALE_SOURCE]);
  });

  it('serves a tile whose source data is inside the TTL and queues nothing', async () => {
    await seedTile(VIEWED_CURRENT, INSIDE_TTL);

    const view = await viewportOver(VIEWED_CURRENT);

    expect(view.ready).toEqual([VIEWED_CURRENT]);
    expect(view.refreshing).toEqual([]);
    expect(view.queued).toEqual([]);
  });

  it('serves a row that predates the column on its fetch time alone', async () => {
    await seedTile(VIEWED_UNSTAMPED, null);

    const view = await viewportOver(VIEWED_UNSTAMPED);

    expect(view.ready).toEqual([VIEWED_UNSTAMPED]);
    expect(view.refreshing).toEqual([]);
    expect(view.queued).toEqual([]);
  });
});

/**
 * The same reading again, for the tier the two readers above cannot reach.
 *
 * `ensureCoverage` and `surveyArea` both cover `INGEST_ZOOM` alone, so once a parent has split,
 * `queueStaleChildren` is the only path from "this ground is stale" to a re-fetch of it. A reader
 * blind to the stamp judges every child fresh on its recent `fetchedAt` and queues nothing, the
 * roll-up re-promotes the parent from the same stale children, and the viewport tier queues the
 * parent again on the next poll — a drain per poll that never re-fetches the ground underneath,
 * with an extract's year-old data serving under a tile that reports itself refreshing.
 *
 * Driven through `processTile` rather than the filter directly: the select that loads the column,
 * the reading taken from it and the enqueue that acts on the reading are three separate places it
 * can be lost, and only the last is observable to a caller.
 */
describe.runIf(IS_LOCAL).sequential('the freshness a split parent’s children are judged on', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it.each(SETTLED)(
    're-queues the %s child whose fetch is recent but whose source data is past the TTL',
    async (status) => {
      const children = await seedSplit(
        SPLIT_STALE_SOURCE,
        oldestInTheMiddle(PAST_TTL),
        inTheMiddle(status, TileStatus.ready),
        ASKED_BEFORE,
      );

      const result = await drainSplitParent(SPLIT_STALE_SOURCE);

      // The roll-up path, not a fetch: a drain that queried a source could not have got this far.
      expect(result.children).toEqual(children);
      expect(await queuedChildren(SPLIT_STALE_SOURCE)).toEqual([children[2]]);
    },
  );

  it('queues nothing when every child’s source data is inside the TTL', async () => {
    await seedSplit(SPLIT_CURRENT, oldestInTheMiddle(INSIDE_TTL));

    await drainSplitParent(SPLIT_CURRENT);

    expect(await queuedChildren(SPLIT_CURRENT)).toEqual([]);
  });

  it('queues nothing for a child just asked, whose source stamp cannot advance', async () => {
    /*
     * The runaway the `SPLIT_CHILD_ATTEMPT_CAP` cannot see. That cap counts a child whose job
     * reaches `dead`; a child whose fetch *succeeds* every time with data past the TTL settles
     * `done`, so `enqueue` revives it and this filter queues it again on the next drain — and the
     * parent is drained on every viewport poll while it is unpromoted.
     */
    await seedSplit(SPLIT_STALE_SOURCE, oldestInTheMiddle(PAST_TTL));

    await drainSplitParent(SPLIT_STALE_SOURCE);

    expect(await queuedChildren(SPLIT_STALE_SOURCE)).toEqual([]);
  });
});

/**
 * The same two readers again, asked of every status the predicate serves rather than `ready`.
 *
 * `isTileSettled` admits two, and `isTileFresh` applies the source stamp to both — but every
 * fixture above is `ready`, so a stamp applied to `ready` alone leaves each reader green while
 * `empty` goes back to being judged on fetch time. That is the worse half rather than the lesser:
 * a stale `ready` tile keeps drawing the trails it fetched last month, while a stale `empty` one
 * draws nothing at all over ground that has them.
 */
describe.runIf(IS_LOCAL).sequential('the freshness every settled status is judged on', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it.each(SETTLED)(
    're-queues a %s tile whose fetch is recent but whose source data is past the TTL',
    async (status) => {
      await seedTile(SETTLED_STALE_SOURCE, PAST_TTL, status, ASKED_BEFORE);
      await seedQueuedJob(SETTLED_STALE_SOURCE);

      const view = await viewportOver(SETTLED_STALE_SOURCE);

      // One tile, so `refreshing` and `queued` are about this row and no other.
      expect(view.quadkeys).toEqual([SETTLED_STALE_SOURCE]);
      expect(view.refreshing).toEqual([SETTLED_STALE_SOURCE]);
      expect(view.queued).toEqual([SETTLED_STALE_SOURCE]);

      const survey = await surveyArea(centreOf(SETTLED_STALE_SOURCE), {
        db: prisma,
        now: NOW,
        maxTiles: 4,
      });
      expect(survey.fresh).not.toContain(SETTLED_STALE_SOURCE);
      expect(survey.outstanding).toContain(SETTLED_STALE_SOURCE);
    },
  );

  it.each(SETTLED)(
    'still serves a %s tile whose source data is inside the TTL, and queues nothing',
    async (status) => {
      // The boundary from the other side, so the reading cannot become "any stamp is stale" —
      // which would re-fetch every ocean tile in the estate once a month for nothing.
      await seedTile(SETTLED_CURRENT, INSIDE_TTL, status);

      const view = await viewportOver(SETTLED_CURRENT);

      expect(view.ready).toEqual([SETTLED_CURRENT]);
      expect(view.refreshing).toEqual([]);
      expect(view.queued).toEqual([]);

      const survey = await surveyArea(centreOf(SETTLED_CURRENT), {
        db: prisma,
        now: NOW,
        maxTiles: 4,
      });
      expect(survey.fresh).toContain(SETTLED_CURRENT);
    },
  );
});

/**
 * The writer that produces the stale `empty` row, rather than a seed standing in for it.
 *
 * A partial extract answers an out-of-area query `200 OK` with zero elements, and `processTile`
 * writes exactly that as `empty` carrying the extract's own `timestamp_osm_base`. Seeded rows
 * pin the reading; only the pipeline pins that the stamp reaches the row at all, from the one
 * source that ever writes it.
 */
describe.runIf(IS_LOCAL).sequential('the freshness an extract’s empty answer is judged on', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('re-queues ground an extract answered empty with a stamp past the TTL', async () => {
    const result = await processTile(EXTRACT_EMPTY, {
      db: prisma,
      now: () => NOW,
      overpass: {
        query: () =>
          Promise.resolve({ elements: [], osm3s: { timestamp_osm_base: PAST_TTL.toISOString() } }),
      },
    });
    expect(result.status).toBe(TileStatus.empty);

    // The row the writer left, before the reading taken from it: its `fetchedAt` is `NOW`, so a
    // survey calling this tile stale for any other reason would be a green for nothing.
    const row = await freshnessRow(EXTRACT_EMPTY);
    expect(row.status).toBe(TileStatus.empty);
    expect(row.fetchedAt).toEqual(NOW);
    expect(row.sourceSnapshotAt).toEqual(PAST_TTL);

    const survey = await surveyArea(centreOf(EXTRACT_EMPTY), { db: prisma, now: NOW, maxTiles: 4 });
    expect(survey.quadkeys).toContain(EXTRACT_EMPTY);
    expect(survey.fresh).not.toContain(EXTRACT_EMPTY);
    expect(survey.outstanding).toContain(EXTRACT_EMPTY);
  });
});

/**
 * What a source that cannot advance costs, counted rather than reasoned about.
 *
 * Refusing to call such a tile fresh is only half the job. The other half is that nothing else
 * notices when a re-fetch cannot move the stamp: `ensureCoverage` puts the tile back in
 * `needsWork` on every poll, `enqueue` revives the settled job with `attempts` cleared, the drain
 * re-queries the same source, and the same stamp lands. The fetch *succeeds* every time, so no
 * ladder engages — `failJob` never runs, `SPLIT_CHILD_ATTEMPT_CAP` is only read for split
 * children, and `reconcileDeadJobs` only for dead jobs. One tile then costs a real Overpass query
 * per browse request, spending the ingest budget on ground that cannot improve while genuinely
 * new ground is refused, and `coverage-note.tsx` reports "refreshing cached ground" for as long
 * as the map stays open.
 *
 * Driven end to end and measured in queries: the count is the defect, and any assertion about the
 * predicate alone would leave the loop free to run through some other caller.
 */
describe.runIf(IS_LOCAL).sequential('what a source that cannot advance costs', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('is re-queried once per refetch interval, not once per poll', async () => {
    const source = stuckSource(PAST_TTL);

    // The first fetch is the one worth making — nothing is known about this ground yet.
    await processTile(LOOPING, source.deps);
    expect(source.state.queries).toBe(1);
    const written = await freshnessRow(LOOPING);
    expect(written.status).toBe(TileStatus.empty);
    expect(written.fetchedAt).toEqual(NOW);
    expect(written.sourceSnapshotAt).toEqual(PAST_TTL);

    // Four polls over the day that follows: one map, left open.
    const polls = [60_000, 3_600_000, REFETCH_INTERVAL_MS / 2, REFETCH_INTERVAL_MS - 60_000];
    const wanted: boolean[] = [];
    for (const ms of polls) {
      wanted.push(await pollAndDrain(LOOPING, new Date(NOW.getTime() + ms), source));
    }
    // The count is the measurement — asserted whole so a regression reports how far it ran.
    expect(wanted).toEqual(polls.map(() => false));
    expect(source.state.queries).toBe(1);

    // Served throughout, and never claiming a refresh nobody is running.
    const view = await ensureCoverage(centreOf(LOOPING), {
      db: prisma,
      now: new Date(NOW.getTime() + 60_000),
      principal: null,
      maxTiles: 4,
    });
    expect(view.ready).toEqual([LOOPING]);
    expect(view.refreshing).toEqual([]);
    expect(view.queued).toEqual([]);

    // A floor, not a cap: the source may have caught up by now, so it is asked again — once.
    const due = new Date(NOW.getTime() + REFETCH_INTERVAL_MS);
    expect(await pollAndDrain(LOOPING, due, source)).toBe(true);
    expect(source.state.queries).toBe(2);
    expect((await freshnessRow(LOOPING)).fetchedAt).toEqual(due);
  });

  it('says so in the log, so an estate on a stale extract is not silent', async () => {
    // The retry being quiet is the point of the interval, and a quiet retry over year-old data
    // is indistinguishable from a healthy estate unless the fetch itself reports the age.
    const lines: string[] = [];
    const source = stuckSource(PAST_TTL);
    await processTile(LOOPING, { ...source.deps, logger: (message) => lines.push(message) });

    expect(lines.filter((line) => line.startsWith(STALE_SOURCE_MARKER))).toHaveLength(1);
    expect(lines.find((line) => line.startsWith(STALE_SOURCE_MARKER))).toContain(LOOPING);
  });

  it('stays quiet for a source whose data is inside the TTL', async () => {
    const lines: string[] = [];
    const source = stuckSource(INSIDE_TTL);
    await processTile(LOOPING, { ...source.deps, logger: (message) => lines.push(message) });

    expect(lines.filter((line) => line.startsWith(STALE_SOURCE_MARKER))).toEqual([]);
  });
});
