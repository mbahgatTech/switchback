import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { JobKind, JobStatus, TileStatus, prisma } from '@switchback/db';
import { childQuadkeys, quadkeyToBBox, quadkeyToTile } from '@switchback/geo';
import { LEASE_TIMEOUT_MS, tileJobKey } from '../src/jobs';
import { sweepQueue } from '../src/maintenance';

/**
 * The queue sweep against a real Postgres.
 *
 * `reclaimExpiredJobs` is one raw `UPDATE ... RETURNING` whose retirement arithmetic reads the
 * pre-update row, and the marker repair turns on `startsWith` over a nullable column — neither is
 * decided by anything a fake client can show. Skipped unless `DATABASE_URL` is local; CI's `gates`
 * job runs `postgis/postgis:17-3.5` and applies the schema, so these run there.
 */
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

/**
 * A quadkey namespace owned by this file alone. Real tiles never reach `2` at z1 in this corpus and
 * no other suite writes here, which matters twice: `sweepQueue` sweeps the whole table, so the
 * assertions below filter to these keys, and the cleanup deletes by name rather than by truncation.
 */
const NS = '222';

/**
 * Six parents shaped like the ones wedged in production on 2026-08-07 — three `running`, three
 * `pending`, each marked, each with a full ten-minute `fetchMs` and no descendants. Production's
 * own keys are `031313112`, `120221231`, `120230202`, `120230203`, `120230212` and `120230220`;
 * they are not used here because two of them belong to `identity.db.test.ts`.
 */
const WEDGED = [
  { quadkey: `${NS}000000`, status: TileStatus.pending, attempts: 1, fetchMs: 545_068 },
  { quadkey: `${NS}000001`, status: TileStatus.running, attempts: 3, fetchMs: 540_022 },
  { quadkey: `${NS}000002`, status: TileStatus.running, attempts: 3, fetchMs: 542_349 },
  { quadkey: `${NS}000003`, status: TileStatus.running, attempts: 2, fetchMs: 540_582 },
  { quadkey: `${NS}000010`, status: TileStatus.pending, attempts: 1, fetchMs: 540_244 },
  { quadkey: `${NS}000011`, status: TileStatus.pending, attempts: 1, fetchMs: 540_513 },
] as const;

const MARKER = 'split into 4 tiles at z10';

/** A parent whose four children are present — the case the repair must leave alone. */
const INTACT = `${NS}111111`;

const NOW = new Date('2026-08-07T11:00:00Z');

const WEDGED_KEYS = WEDGED.map((tile) => tile.quadkey);
const FIXTURE_TILES = [...WEDGED_KEYS, INTACT, ...childQuadkeys(INTACT)];
const STALE_JOB = `ingest_tile:${NS}999999`;

async function seedTile(
  quadkey: string,
  status: TileStatus,
  extra: { attempts?: number; fetchMs?: number; lastError?: string | null } = {},
): Promise<void> {
  const { x, y, z } = quadkeyToTile(quadkey);
  const [bboxW, bboxS, bboxE, bboxN] = quadkeyToBBox(quadkey);
  await prisma.ingestTile.create({
    data: {
      quadkey,
      x,
      y,
      z,
      status,
      bboxW,
      bboxS,
      bboxE,
      bboxN,
      trailCount: 0,
      attempts: extra.attempts ?? 0,
      fetchMs: extra.fetchMs ?? null,
      lastError: extra.lastError ?? null,
    },
  });
}

/** The fixture tiles, in `WEDGED` order, however the sweep left them. */
function wedgedRows() {
  return prisma.ingestTile.findMany({
    where: { quadkey: { in: WEDGED_KEYS } },
    orderBy: { quadkey: 'asc' },
  });
}

async function cleanup(): Promise<void> {
  await prisma.ingestJob.deleteMany({
    where: { dedupeKey: { in: [...FIXTURE_TILES.map(tileJobKey), STALE_JOB] } },
  });
  await prisma.ingestTile.deleteMany({ where: { quadkey: { in: FIXTURE_TILES } } });
}

describe.runIf(IS_LOCAL).sequential('the queue sweep against a real database', () => {
  beforeEach(async () => {
    await cleanup();
    for (const tile of WEDGED) {
      await seedTile(tile.quadkey, tile.status, { ...tile, lastError: MARKER });
      await prisma.ingestJob.create({
        data: {
          kind: JobKind.ingest_tile,
          dedupeKey: tileJobKey(tile.quadkey),
          payload: { quadkey: tile.quadkey },
          status: JobStatus.queued,
        },
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('clears every wedged parent and re-queues it, without touching the tile’s own data', async () => {
    const { unsplit } = await sweepQueue(prisma, NOW);

    expect(unsplit.filter((repair) => WEDGED_KEYS.includes(repair.quadkey))).toHaveLength(
      WEDGED.length,
    );

    const after = await wedgedRows();
    expect(after.map((tile) => [tile.status, tile.lastError])).toEqual(
      WEDGED.map(() => [TileStatus.pending, null]),
    );
    // The trail data the tile carries is the reason the repair writes only two columns.
    expect(after.map((tile) => [tile.attempts, tile.fetchMs, tile.fetchedAt])).toEqual(
      WEDGED.map((tile) => [tile.attempts, tile.fetchMs, null]),
    );

    const jobs = await prisma.ingestJob.findMany({
      where: { dedupeKey: { in: WEDGED_KEYS.map(tileJobKey) } },
    });
    expect(jobs.map((job) => job.status)).toEqual(WEDGED.map(() => JobStatus.queued));
  });

  it('is a no-op the second time, so a cron that runs it daily cannot churn', async () => {
    await sweepQueue(prisma, NOW);
    const settled = await wedgedRows();

    const { unsplit } = await sweepQueue(prisma, NOW);

    expect(unsplit.filter((repair) => WEDGED_KEYS.includes(repair.quadkey))).toEqual([]);
    expect((await wedgedRows()).map((tile) => tile.updatedAt)).toEqual(
      settled.map((tile) => tile.updatedAt),
    );
  });

  it('leaves a parent whose children exist still claiming its subdivision', async () => {
    await seedTile(INTACT, TileStatus.pending, { lastError: MARKER });
    for (const child of childQuadkeys(INTACT)) await seedTile(child, TileStatus.ready);

    await sweepQueue(prisma, NOW);

    const parent = await prisma.ingestTile.findUniqueOrThrow({ where: { quadkey: INTACT } });
    expect(parent.lastError).toBe(MARKER);
  });

  it('takes back a lease the drainer died holding', async () => {
    await prisma.ingestJob.create({
      data: {
        kind: JobKind.ingest_tile,
        dedupeKey: STALE_JOB,
        payload: { quadkey: `${NS}999999` },
        status: JobStatus.running,
        attempts: 1,
        lockedBy: 'cron',
        lockedAt: new Date(NOW.getTime() - LEASE_TIMEOUT_MS - 60_000),
      },
    });

    const { requeued } = await sweepQueue(prisma, NOW);

    // The row, not only the count: `requeued` is a total over every expired lease in the table.
    const job = await prisma.ingestJob.findUniqueOrThrow({ where: { dedupeKey: STALE_JOB } });
    expect(job).toMatchObject({ status: JobStatus.queued, attempts: 2, lockedBy: null });
    expect(requeued).toBeGreaterThanOrEqual(1);
  });
});
