import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JobKind, JobStatus, TileStatus, prisma } from '@switchback/db';
import { childQuadkeys, quadkeyToBBox, quadkeyToTile } from '@switchback/geo';
import type { BBox } from '@switchback/core';
import { ensureCoverage, surveyArea } from '../src/coverage';
import { TILE_TTL_MS } from '../src/freshness';
import { tileJobKey } from '../src/jobs';
import { processTile } from '../src/pipeline';
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
const ROLLED_UP = [ROLLED_UP_STALE, ROLLED_UP_CURRENT, ROLLED_UP_UNSTAMPED];

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

const FIXTURES = [
  CURRENT,
  STALE_SOURCE,
  UNSTAMPED,
  ...VIEWED,
  ...[...ROLLED_UP, ...SPLIT].flatMap((parent) => [parent, ...childQuadkeys(parent)]),
];

const NOW = new Date('2026-06-01T12:00:00Z');
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

/** A day either side of the TTL, so moving the TTL moves every fixture judged against it. */
const INSIDE_TTL = ago(TILE_TTL_MS - 86_400_000);
const PAST_TTL = ago(TILE_TTL_MS + 86_400_000);

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

async function seedTile(quadkey: string, sourceSnapshotAt: Date | null): Promise<void> {
  await prisma.ingestTile.create({
    data: {
      ...tileGeometry(quadkey),
      status: TileStatus.ready,
      trailCount: 1,
      // The fetch is always recent. Whatever these tiles are judged on, it is not this.
      fetchedAt: NOW,
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
): Promise<string[]> {
  await seedUnpromoted(parent);
  const children = childQuadkeys(parent);
  for (const [index, child] of children.entries()) {
    await seedTile(child, stampAt(index, children.length));
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
): Promise<void> {
  await seedSplit(parent, stampAt);
  await promoteFrom(prisma, parent);
}

/**
 * `oldest` on a child that is neither the first of the set nor the last, so a roll-up reaching
 * for one end of it is caught alongside one that ignores the column altogether.
 */
const oldestInTheMiddle =
  (oldest: Date) =>
  (index: number, count: number): Date =>
    index === Math.floor(count / 2) ? oldest : NOW;

/** What a parent row holds once a roll-up has written it. */
function promotedRow(quadkey: string) {
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
 */
describe.runIf(IS_LOCAL).sequential('the freshness a roll-up hands its parent', () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it('writes the stalest child’s source stamp, and is judged stale on it', async () => {
    await promoteParent(ROLLED_UP_STALE, oldestInTheMiddle(PAST_TTL));

    // The stamp on the row, before the reading taken from it: the parent's own `fetchedAt` is
    // `NOW`, so a survey calling this tile stale for any other reason is a green for nothing.
    const row = await promotedRow(ROLLED_UP_STALE);
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
  });

  it('leaves a parent fresh when every child’s source data is inside the TTL', async () => {
    await promoteParent(ROLLED_UP_CURRENT, oldestInTheMiddle(INSIDE_TTL));

    expect((await promotedRow(ROLLED_UP_CURRENT)).sourceSnapshotAt).toEqual(INSIDE_TTL);

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
    expect((await promotedRow(ROLLED_UP_UNSTAMPED)).sourceSnapshotAt).toBeNull();

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
    await seedTile(VIEWED_STALE_SOURCE, PAST_TTL);
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

  it('re-queues the child whose fetch is recent but whose source data is past the TTL', async () => {
    const children = await seedSplit(SPLIT_STALE_SOURCE, oldestInTheMiddle(PAST_TTL));

    const result = await drainSplitParent(SPLIT_STALE_SOURCE);

    // The roll-up path, not a fetch: a drain that queried a source could not have got this far.
    expect(result.children).toEqual(children);
    expect(await queuedChildren(SPLIT_STALE_SOURCE)).toEqual([children[2]]);
  });

  it('queues nothing when every child’s source data is inside the TTL', async () => {
    await seedSplit(SPLIT_CURRENT, oldestInTheMiddle(INSIDE_TTL));

    await drainSplitParent(SPLIT_CURRENT);

    expect(await queuedChildren(SPLIT_CURRENT)).toEqual([]);
  });
});
