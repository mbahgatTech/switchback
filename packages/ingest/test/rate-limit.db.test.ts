import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus, prisma } from '@switchback/db';
import { MAX_TILE_QUEUE_DEPTH, admitIngest } from '../src/backpressure';
import { MAX_AREA_TILES, queueTiles } from '../src/coverage';
import {
  BUCKET_CAPACITY,
  BUCKET_REFILL_MS,
  MIN_BUCKET_CAPACITY,
  PRINCIPAL_QUEUE_SHARE,
  pruneIngestBuckets,
  resetIngestBudgetState,
  spendIngestBudget,
} from '../src/rate-limit';
import type { IngestPrincipal } from '../src/rate-limit';

/**
 * The per-caller allowance against a real Postgres.
 *
 * The whole guard is one `INSERT … ON CONFLICT … WHERE` — the refill arithmetic, the atomicity
 * and the "a refusal writes nothing" property are all decided by that statement, and a fake
 * client asserting on the arguments it was handed would prove none of them. Skipped unless
 * `DATABASE_URL` is local; CI's `gates` job runs `postgis/postgis:17-3.5` and applies the schema.
 */
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

/** A quadkey namespace owned by this file alone, so the cleanup deletes by name. */
const NS = '333';

/** Bucket keys owned by this file alone, for the same reason. */
const ABUSER: IngestPrincipal = { key: 'u:zz-rate-abuser', kind: 'user' };
const BYSTANDER: IngestPrincipal = { key: 'u:zz-rate-bystander', kind: 'user' };
const KEYS = [ABUSER.key, BYSTANDER.key, 'u:zz-rate-third'];

const NOW = new Date('2026-08-29T09:00:00Z');

/** One viewport's worth of tiles, as `ensureCoverage` would hand them over. */
const VIEWPORT = 12;

/**
 * Generous on purpose. `queueTiles` writes two rows per tile and awaits each, so the loop below
 * is a few hundred round trips — fast against a local Postgres, and nowhere near vitest's
 * five-second default on a machine that is busy doing something else.
 */
const TIMEOUT = 120_000;

/** `n` distinct z9 quadkeys inside `NS`, deterministic so a failure names the same tiles twice. */
function quadkeys(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, index) =>
    (from + index).toString(4).padStart(6, '0').slice(-6),
  ).map((tail) => `${NS}${tail}`);
}

async function clear(): Promise<void> {
  await prisma.ingestJob.deleteMany({ where: { dedupeKey: { contains: `:${NS}` } } });
  await prisma.ingestTile.deleteMany({ where: { quadkey: { startsWith: NS } } });
  await prisma.ingestRateBucket.deleteMany({ where: { principal: { in: KEYS } } });
}

/** How many of this file's tiles are on the request queue right now. */
async function queuedTiles(): Promise<number> {
  return prisma.ingestJob.count({
    where: {
      kind: JobKind.ingest_tile,
      status: { in: [JobStatus.queued, JobStatus.running] },
      dedupeKey: { contains: `:${NS}` },
    },
  });
}

describe.skipIf(!IS_LOCAL)('the per-caller ingest allowance', () => {
  beforeEach(async () => {
    resetIngestBudgetState();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await clear();
    await prisma.$disconnect();
  });

  it(
    'queues a first cold viewport in full, for a caller it has never seen',
    async () => {
      const outcome = await queueTiles(prisma, quadkeys(0, VIEWPORT), {
        principal: ABUSER,
        now: NOW,
      });

      expect(outcome.refused).toBeNull();
      expect(outcome.queued).toHaveLength(VIEWPORT);
      expect(await queuedTiles()).toBe(VIEWPORT);
    },
    TIMEOUT,
  );

  it(
    'refuses the enqueue once the allowance is spent, and writes nothing when it does',
    async () => {
      await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY, NOW);

      const outcome = await queueTiles(prisma, quadkeys(0, VIEWPORT), {
        principal: ABUSER,
        now: NOW,
      });

      expect(outcome.refused).toBe('rate-limit');
      expect(outcome.queued).toEqual([]);
      expect(await queuedTiles()).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'charges nothing for already-ingested ground, so panning over it is never throttled',
    async () => {
      await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY, NOW);

      // What `ensureCoverage` passes when every outstanding tile already has a job behind it:
      // tiles to re-prioritise, no new ground to bound.
      const outcome = await queueTiles(prisma, quadkeys(0, VIEWPORT), {
        principal: ABUSER,
        newGround: [],
        now: NOW,
      });

      expect(outcome.refused).toBeNull();
      expect(outcome.queued).toHaveLength(VIEWPORT);
    },
    TIMEOUT,
  );

  it(
    'refills on the clock alone, with no job, sweep or operator involved',
    async () => {
      await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY, NOW);
      expect((await spendIngestBudget(prisma, ABUSER, VIEWPORT, NOW)).spent).toBe(false);

      const later = new Date(NOW.getTime() + BUCKET_REFILL_MS);
      const recovered = await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY, later);

      expect(recovered.spent).toBe(true);
      expect(recovered.remaining).toBeCloseTo(0, 6);
    },
    TIMEOUT,
  );

  it(
    'spends nothing on a refusal, so a client polling into one cannot latch its own bucket',
    async () => {
      await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY, NOW);

      // A client that polls every couple of seconds, refused every time, for two of the three
      // minutes its next viewport costs. If a refusal settled the row, the third minute would
      // start the refill over and the call below would be refused too.
      const minute = 60_000;
      for (const at of [1, 2]) {
        const outcome = await spendIngestBudget(
          prisma,
          ABUSER,
          VIEWPORT,
          new Date(NOW.getTime() + at * minute),
        );
        expect(outcome.spent).toBe(false);
      }

      const perMinute = BUCKET_CAPACITY / (BUCKET_REFILL_MS / minute);
      const waited = new Date(NOW.getTime() + Math.ceil(VIEWPORT / perMinute) * minute);
      expect((await spendIngestBudget(prisma, ABUSER, VIEWPORT, waited)).spent).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'keeps two callers apart, so one spending its own says nothing about the other',
    async () => {
      await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY, NOW);

      expect((await spendIngestBudget(prisma, ABUSER, VIEWPORT, NOW)).spent).toBe(false);
      expect((await spendIngestBudget(prisma, BYSTANDER, VIEWPORT, NOW)).spent).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'cannot be double-spent by two requests arriving at once',
    async () => {
      // Two calls that together want more than the allowance holds. Serialised by the row lock
      // the conflicting insert takes, so exactly one of them may win.
      const half = Math.ceil(BUCKET_CAPACITY * 0.6);
      const outcomes = await Promise.all([
        spendIngestBudget(prisma, ABUSER, half, NOW),
        spendIngestBudget(prisma, ABUSER, half, NOW),
      ]);

      expect(outcomes.filter((outcome) => outcome.spent)).toHaveLength(1);
    },
    TIMEOUT,
  );

  it(
    'refuses a cost past the whole allowance rather than driving the bucket negative',
    async () => {
      const outcome = await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY + 1, NOW);

      expect(outcome.spent).toBe(false);
      expect(
        await prisma.ingestRateBucket.findUnique({ where: { principal: ABUSER.key } }),
      ).toBeNull();
    },
    TIMEOUT,
  );

  it('always leaves room for one deliberate area fetch, whatever the ceiling is re-tuned to', () => {
    // The floor is what stops a lowered `MAX_TILE_QUEUE_DEPTH` from killing the "fetch this
    // area" button outright — an allowance under one press is a button that can never be
    // pressed, which is the latch shape this whole guard is built to avoid.
    expect(MIN_BUCKET_CAPACITY).toBe(MAX_AREA_TILES);
    expect(BUCKET_CAPACITY).toBeGreaterThanOrEqual(MAX_AREA_TILES);
  });

  it(
    'leaves the shared failure domain: one caller cannot take the queue everybody else needs',
    async () => {
      // Ten viewports of cold ground fill this caller's allowance exactly; the eleventh is where
      // the old behaviour kept going, all the way to the product-wide ceiling.
      const rounds = Math.ceil(BUCKET_CAPACITY / VIEWPORT) + 1;
      let refusals = 0;

      for (let round = 0; round < rounds; round += 1) {
        const outcome = await queueTiles(prisma, quadkeys(round * VIEWPORT, VIEWPORT), {
          principal: ABUSER,
          now: NOW,
        });
        if (outcome.refused === 'rate-limit') refusals += 1;
      }

      // The claim, and the assertion that goes red without the guard: eleven viewports of new
      // ground asked for, at most one allowance of it queued.
      expect(await queuedTiles()).toBeLessThanOrEqual(BUCKET_CAPACITY);
      expect(refusals).toBeGreaterThan(0);
      // What one caller may hold is a fraction of what the estate has, which is the whole point:
      // the ceiling is still there for everybody else to reach.
      expect(BUCKET_CAPACITY).toBeLessThan(MAX_TILE_QUEUE_DEPTH * (PRINCIPAL_QUEUE_SHARE + 0.01));
      expect(await admitIngest(prisma)).toBeNull();

      const bystander = await queueTiles(prisma, quadkeys(9000, VIEWPORT), {
        principal: BYSTANDER,
        now: NOW,
      });
      expect(bystander.refused).toBeNull();
      expect(bystander.queued).toHaveLength(VIEWPORT);
    },
    TIMEOUT,
  );

  it(
    'collects buckets that have refilled to full, and leaves the ones still spent',
    async () => {
      await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY, NOW);
      await spendIngestBudget(prisma, BYSTANDER, BUCKET_CAPACITY, new Date(NOW.getTime() + 60_000));

      const swept = await pruneIngestBuckets(
        prisma,
        new Date(NOW.getTime() + BUCKET_REFILL_MS + 1),
      );

      expect(swept).toBe(1);
      expect(
        await prisma.ingestRateBucket.findUnique({ where: { principal: ABUSER.key } }),
      ).toBeNull();
      expect(
        await prisma.ingestRateBucket.findUnique({ where: { principal: BYSTANDER.key } }),
      ).not.toBeNull();
    },
    TIMEOUT,
  );
});
