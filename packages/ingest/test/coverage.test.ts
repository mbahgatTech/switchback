import { describe, expect, it, vi } from 'vitest';
import { JobKind, TileStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import {
  AREA_PRIORITY,
  MAX_AREA_TILES,
  VIEWPORT_PRIORITY,
  ensureCoverage,
  queueTiles,
  requestArea,
  surveyArea,
} from '../src/coverage';
import { MAX_TILE_QUEUE_DEPTH } from '../src/backpressure';
import { TILE_TTL_MS } from '../src/pipeline';

/** A bbox small enough to need exactly one z9 tile. */
const ONE_TILE: [number, number, number, number] = [-4.08, 53.06, -4.07, 53.07];
/** Most of Europe — far more z9 tiles than one request will cover. */
const HUGE: [number, number, number, number] = [-10, 35, 30, 60];

const NOW = new Date('2026-07-26T12:00:00Z');

interface TileRow {
  quadkey: string;
  status: TileStatus;
  fetchedAt: Date | null;
}

interface Recorded {
  tileUpserts: Array<{ where: { quadkey: string }; create: Record<string, unknown> }>;
  jobUpserts: Array<Record<string, unknown>>;
}

interface FakeOptions {
  /** Dedupe keys the fake should report as queued or running. */
  inFlight?: string[];
  /** What the admission guard's grouped count answers — the queue-depth guard's input. */
  queueDepth?: number;
}

/**
 * A Prisma stand-in covering the calls this module makes.
 *
 * `ensureCoverage`'s job is to partition and to record intent, and both are decisions we
 * want pinned without a database in the loop — the partition especially, since getting it
 * wrong shows up as a spinner over a map that already has data, or an empty map with no
 * spinner at all.
 */
function fakeDb(
  existing: TileRow[] = [],
  options: FakeOptions = {},
): { db: PrismaClient; recorded: Recorded } {
  const recorded: Recorded = { tileUpserts: [], jobUpserts: [] };
  const inFlight = options.inFlight ?? [];
  const db = {
    ingestTile: {
      findMany: ({ where }: { where: { quadkey: { in: string[] } } }) =>
        Promise.resolve(existing.filter((tile) => where.quadkey.in.includes(tile.quadkey))),
      upsert: (args: { where: { quadkey: string }; create: Record<string, unknown> }) => {
        recorded.tileUpserts.push(args);
        return Promise.resolve(args.create);
      },
    },
    ingestJob: {
      findMany: ({ where }: { where: { dedupeKey: { in: string[] } } }) =>
        Promise.resolve(
          inFlight
            .filter((key) => where.dedupeKey.in.includes(key))
            .map((dedupeKey) => ({ dedupeKey })),
        ),
      groupBy: () =>
        Promise.resolve([{ kind: JobKind.ingest_tile, _count: { _all: options.queueDepth ?? 0 } }]),
      updateMany: () => Promise.resolve({ count: 0 }),
      upsert: (args: Record<string, unknown>) => {
        recorded.jobUpserts.push(args);
        return Promise.resolve({ id: 'job' });
      },
    },
  } as unknown as PrismaClient;
  return { db, recorded };
}

function fresh(quadkey: string): TileRow {
  return { quadkey, status: TileStatus.ready, fetchedAt: new Date(NOW.getTime() - 1_000) };
}

function stale(quadkey: string): TileRow {
  return {
    quadkey,
    status: TileStatus.ready,
    fetchedAt: new Date(NOW.getTime() - TILE_TTL_MS - 1_000),
  };
}

describe('ensureCoverage partitioning', () => {
  it('treats an unknown tile as pending, with nothing to serve', async () => {
    const { db } = fakeDb();
    const result = await ensureCoverage(ONE_TILE, { db, now: NOW });

    expect(result.quadkeys).toHaveLength(1);
    expect(result.pending).toEqual(result.quadkeys);
    expect(result.ready).toEqual([]);
    expect(result.refreshing).toEqual([]);
    expect(result.queued).toEqual(result.quadkeys);
  });

  it('serves a fresh tile and queues nothing', async () => {
    const quadkey = (await ensureCoverage(ONE_TILE, { db: fakeDb().db, now: NOW })).quadkeys[0]!;
    const { db, recorded } = fakeDb([fresh(quadkey)]);

    const result = await ensureCoverage(ONE_TILE, { db, now: NOW });

    expect(result.ready).toEqual([quadkey]);
    expect(result.pending).toEqual([]);
    expect(result.queued).toEqual([]);
    // The point of the whole cache: a warm viewport writes nothing at all.
    expect(recorded.jobUpserts).toHaveLength(0);
  });

  it('serves a stale tile while refreshing it, rather than blanking the map', async () => {
    const quadkey = (await ensureCoverage(ONE_TILE, { db: fakeDb().db, now: NOW })).quadkeys[0]!;
    const { db } = fakeDb([stale(quadkey)]);

    const result = await ensureCoverage(ONE_TILE, { db, now: NOW });

    // Both ready and refreshing: there are trails to draw, and a fetch behind them.
    expect(result.ready).toEqual([quadkey]);
    expect(result.refreshing).toEqual([quadkey]);
    expect(result.pending).toEqual([]);
    expect(result.queued).toEqual([quadkey]);
  });

  it('does not offer a failed tile as ready', async () => {
    const quadkey = (await ensureCoverage(ONE_TILE, { db: fakeDb().db, now: NOW })).quadkeys[0]!;
    const { db } = fakeDb([{ quadkey, status: TileStatus.failed, fetchedAt: null }]);

    const result = await ensureCoverage(ONE_TILE, { db, now: NOW });

    expect(result.ready).toEqual([]);
    expect(result.pending).toEqual([quadkey]);
    expect(result.queued).toEqual([quadkey]);
  });

  it('counts an empty tile as covered — "no trails here" is an answer', async () => {
    const quadkey = (await ensureCoverage(ONE_TILE, { db: fakeDb().db, now: NOW })).quadkeys[0]!;
    const { db } = fakeDb([
      { quadkey, status: TileStatus.empty, fetchedAt: new Date(NOW.getTime() - 1_000) },
    ]);

    const result = await ensureCoverage(ONE_TILE, { db, now: NOW });

    expect(result.ready).toEqual([quadkey]);
    expect(result.queued).toEqual([]);
  });
});

describe('ensureCoverage bounds', () => {
  it('refuses a bbox needing more tiles than the cap, and queues none of it', async () => {
    const { db, recorded } = fakeDb();
    const result = await ensureCoverage(HUGE, { db, now: NOW });

    expect(result.tooLarge).toBe(true);
    expect(result.requiredTiles).toBeGreaterThan(result.maxTiles);
    // The important half: a zoomed-out viewport must not enqueue hundreds of Overpass
    // queries on its way to telling the user to zoom in.
    expect(result.queued).toEqual([]);
    expect(recorded.jobUpserts).toHaveLength(0);
    expect(result.ready).toEqual([]);
    expect(result.pending).toEqual([]);
  });

  it('reports the cap it applied, so the client can say how far to zoom', async () => {
    const result = await ensureCoverage(HUGE, { db: fakeDb().db, now: NOW, maxTiles: 4 });
    expect(result.maxTiles).toBe(4);
  });
});

describe('queueTiles', () => {
  it('writes the tile row before the job', async () => {
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['031311230']);

    // Order matters: a job whose tile row does not exist would force the handler to
    // invent one. The reverse gap is self-healing.
    expect(recorded.tileUpserts).toHaveLength(1);
    expect(recorded.jobUpserts).toHaveLength(1);
    expect(recorded.tileUpserts[0]!.where.quadkey).toBe('031311230');
    expect((recorded.jobUpserts[0] as { create: { kind: JobKind } }).create.kind).toBe(
      JobKind.ingest_tile,
    );
  });

  it('creates a pending tile carrying its own bbox', async () => {
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['031311230']);

    const created = recorded.tileUpserts[0]!.create;
    expect(created).toMatchObject({ quadkey: '031311230', z: 9, status: TileStatus.pending });
    expect(created.bboxW).toBeLessThan(created.bboxE as number);
    expect(created.bboxS).toBeLessThan(created.bboxN as number);
  });

  it('leaves an existing row untouched, so a re-queue cannot un-serve a stale tile', async () => {
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['031311230']);

    // An empty `update` is the whole guarantee: re-queueing must not reset `fetchedAt` or
    // `trailCount` on a tile that is still serving trails while its refresh runs.
    expect(
      (recorded.tileUpserts[0] as unknown as { update: Record<string, unknown> }).update,
    ).toEqual({});
  });

  it('gives a live viewport priority over a background sweep', async () => {
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['031311230']);
    await queueTiles(db, ['031311231'], { urgent: false });

    const priority = (index: number) =>
      (recorded.jobUpserts[index] as { create: { priority: number } }).create.priority;

    expect(priority(0)).toBe(VIEWPORT_PRIORITY);
    expect(priority(1)).toBe(0);
    expect(priority(0)).toBeGreaterThan(priority(1));
  });

  it('dedupes on the quadkey, so a cold viewport queues one job per tile', async () => {
    const { db, recorded } = fakeDb();
    await queueTiles(db, ['031311230']);
    await queueTiles(db, ['031311230']);

    const keys = recorded.jobUpserts.map(
      (job) => (job as { where: { dedupeKey: string } }).where.dedupeKey,
    );
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toContain('031311230');
  });
});

describe('surveyArea', () => {
  it('answers a box the viewport path refuses outright', async () => {
    const { db, recorded } = fakeDb();

    // The premise of the whole feature: `ensureCoverage` gives up here and reports nothing.
    expect((await ensureCoverage(HUGE, { db, now: NOW })).quadkeys).toEqual([]);

    const area = await surveyArea(HUGE, { db, now: NOW });

    expect(area.quadkeys).toHaveLength(MAX_AREA_TILES);
    expect(area.capped).toBe(true);
    expect(area.requiredTiles).toBeGreaterThan(MAX_AREA_TILES);
    // Read-only. A survey that queued work would fire on every poll of a wide viewport.
    expect(recorded.jobUpserts).toHaveLength(0);
    expect(recorded.tileUpserts).toHaveLength(0);
  });

  it('partitions fresh from outstanding, and reports what has nothing to show', async () => {
    const { db: probe } = fakeDb();
    const keys = (await surveyArea(HUGE, { db: probe, now: NOW })).quadkeys;
    const [a, b, c] = [keys[0]!, keys[1]!, keys[2]!];

    const { db } = fakeDb([
      fresh(a),
      stale(b),
      { quadkey: c, status: TileStatus.failed, fetchedAt: null },
    ]);
    const area = await surveyArea(HUGE, { db, now: NOW });

    expect(area.fresh).toContain(a);
    expect(area.outstanding).toContain(b);
    expect(area.outstanding).toContain(c);
    // A stale-but-ready tile still has trails behind it; a failed one has none.
    expect(area.missing).not.toContain(b);
    expect(area.missing).toContain(c);
    expect(area.fresh.length + area.outstanding.length).toBe(area.quadkeys.length);
  });

  /*
   * The reason `working` is read from the job table rather than inferred from tile status.
   * `queueTiles` upserts with an empty `update`, so re-queueing a stale tile leaves its
   * status at `ready` — and a UI that polled on tile status alone would call the fetch
   * finished while every one of its Overpass calls was still in flight.
   */
  it('counts a stale tile with a live job as working, though its status still says ready', async () => {
    const { db: probe } = fakeDb();
    const key = (await surveyArea(HUGE, { db: probe, now: NOW })).quadkeys[0]!;

    const { db } = fakeDb([stale(key)], { inFlight: [`ingest_tile:${key}`] });
    const area = await surveyArea(HUGE, { db, now: NOW });

    expect(area.working).toEqual([key]);
    expect(area.outstanding).toContain(key);
  });

  it('behaves like coverBBox on a box that fits, reporting nothing capped', async () => {
    const { db } = fakeDb();
    const area = await surveyArea(ONE_TILE, { db, now: NOW });

    expect(area.quadkeys).toHaveLength(1);
    expect(area.capped).toBe(false);
    expect(area.requiredTiles).toBe(1);
  });
});

describe('requestArea', () => {
  it('queues every outstanding tile below the viewport priority', async () => {
    const { db, recorded } = fakeDb();
    const result = await requestArea(HUGE, { db, now: NOW });

    expect(result.queued).toHaveLength(MAX_AREA_TILES);
    expect(recorded.jobUpserts).toHaveLength(MAX_AREA_TILES);

    const priority = (recorded.jobUpserts[0] as { create: { priority: number } }).create.priority;
    expect(priority).toBe(AREA_PRIORITY);
    // Somebody who kicked off a five-minute sweep must not outrank somebody staring at a
    // blank viewport — but must outrank a background refresh.
    expect(priority).toBeLessThan(VIEWPORT_PRIORITY);
    expect(priority).toBeGreaterThan(0);
  });

  it('is free to press twice — a fully fresh area queues nothing at all', async () => {
    const { db: probe } = fakeDb();
    const keys = (await surveyArea(HUGE, { db: probe, now: NOW })).quadkeys;

    const { db, recorded } = fakeDb(keys.map(fresh));
    const result = await requestArea(HUGE, { db, now: NOW });

    expect(result.outstanding).toEqual([]);
    expect(result.queued).toEqual([]);
    expect(result.busy).toBe(false);
    expect(recorded.jobUpserts).toHaveLength(0);
  });

  it('refuses once the tile queue is already too deep, and says so', async () => {
    // The guard logs its refusal for an operator; this suite is not the audience.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { db, recorded } = fakeDb([], { queueDepth: MAX_TILE_QUEUE_DEPTH });
    const result = await requestArea(HUGE, { db, now: NOW });

    expect(result.busy).toBe(true);
    expect(result.queued).toEqual([]);
    // The point of the guard: a scripted press cannot bury the live viewports.
    expect(recorded.jobUpserts).toHaveLength(0);
    // Still reports the survey, so the UI can explain rather than just fail.
    expect(result.outstanding).toHaveLength(MAX_AREA_TILES);
  });

  it('lets a request through while the queue is one job short of the cap', async () => {
    const { db } = fakeDb([], { queueDepth: MAX_TILE_QUEUE_DEPTH - 1 });
    const result = await requestArea(HUGE, { db, now: NOW });

    expect(result.busy).toBe(false);
    expect(result.queued).toHaveLength(MAX_AREA_TILES);
  });

  it('folds what it queued into `working`, so the caller can poll immediately', async () => {
    const { db } = fakeDb();
    const result = await requestArea(HUGE, { db, now: NOW });

    expect(result.working).toEqual(result.queued);
    expect(new Set(result.working).size).toBe(result.working.length);
  });

  it('queues centre-first, so the middle of the view fills before the corners', async () => {
    const { db, recorded } = fakeDb();
    const result = await requestArea(HUGE, { db, now: NOW });

    // Equal-priority jobs come off the queue in the order they went on, so this ordering is
    // the reason the ground under the user's eye arrives first.
    const queuedOrder = recorded.tileUpserts.map((upsert) => upsert.where.quadkey);
    expect(queuedOrder).toEqual(result.quadkeys);
  });
});
