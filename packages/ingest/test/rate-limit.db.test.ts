import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { JobKind, JobStatus, prisma } from '@switchback/db';
import { MAX_TILE_QUEUE_DEPTH, admitIngest } from '../src/backpressure';
import { MAX_AREA_TILES, queueTiles } from '../src/coverage';
import { REQUEST_DRAIN_TILES_PER_HOUR } from '../src/drain-rate';
import {
  BUCKET_CAPACITY,
  BUCKET_REFILL_MS,
  MIN_BUCKET_CAPACITY,
  PRINCIPAL_QUEUE_SHARE,
  PRINCIPAL_TILES_PER_HOUR,
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

/** Instances racing for one bucket. Eight is well past the point the race becomes reliable. */
const CONTENDERS = 8;

/** A session zone that is not UTC and observes DST, so the offset is real rather than nominal. */
const SKEWED_ZONE = 'America/Denver';

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

/** How many of this file's buckets still exist. The sweep's own count is table-wide. */
async function mine(): Promise<number> {
  return prisma.ingestRateBucket.count({ where: { principal: { in: KEYS } } });
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

      // `pruneIngestBuckets` sweeps the whole table and `clear()` only owns `KEYS`, so the
      // return value counts other people's rows too. What this file may assert is its own.
      expect(swept).toBeGreaterThanOrEqual(1);
      expect(await mine()).toBe(1);
      expect(
        await prisma.ingestRateBucket.findUnique({ where: { principal: ABUSER.key } }),
      ).toBeNull();
      expect(
        await prisma.ingestRateBucket.findUnique({ where: { principal: BYSTANDER.key } }),
      ).not.toBeNull();
    },
    TIMEOUT,
  );
  /**
   * Instances that share nothing, which is the only shape these two properties are visible in.
   *
   * `prisma` runs a `Promise.all` of raw queries down one connection and serialises them, so a
   * spend split into a read and a write passes when raced against itself through it — proven by
   * mutation, and the reason the original concurrency test could not fail. A separate client is
   * a separate pool and a separate Postgres backend, which is what a second Vercel instance is.
   *
   * `timeZone` sets the session zone Postgres will read and write timestamps in. Instances are
   * not guaranteed to agree on it, and every one of them talks to the same row.
   */
  function instancesOf(count: number, timeZone?: string): PrismaClient[] {
    const url = new URL(process.env.DATABASE_URL ?? '');
    url.searchParams.set('connection_limit', '2');
    if (timeZone !== undefined) url.searchParams.set('options', `-c timezone=${timeZone}`);
    return Array.from({ length: count }, () => new PrismaClient({ datasourceUrl: url.toString() }));
  }

  describe('raced by instances that share nothing', () => {
    let instances: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(instances.map((instance) => instance.$disconnect()));
      instances = [];
    });

    it(
      'settles on one winner when several instances reach for the same allowance at once',
      async () => {
        instances = instancesOf(CONTENDERS);
        // Each wants more than half, so a second grant would be an overdraft by arithmetic
        // rather than by judgement.
        const cost = Math.ceil(BUCKET_CAPACITY * 0.6);

        const outcomes = await Promise.all(
          instances.map((instance) => spendIngestBudget(instance, ABUSER, cost, NOW)),
        );

        expect(outcomes.filter((outcome) => outcome.spent)).toHaveLength(1);
      },
      TIMEOUT,
    );

    it(
      'debits exactly what it granted, so no spend is lost between two instances',
      async () => {
        instances = instancesOf(CONTENDERS);
        const cost = Math.floor(BUCKET_CAPACITY / 4);

        const outcomes = await Promise.all(
          instances.map((instance) => spendIngestBudget(instance, ABUSER, cost, NOW)),
        );
        const granted = outcomes.filter((outcome) => outcome.spent).length;
        const row = await prisma.ingestRateBucket.findUnique({ where: { principal: ABUSER.key } });

        // The assertion a lost update fails: two instances that both read a full bucket and
        // both write their own answer grant twice and debit once.
        expect(granted).toBeLessThanOrEqual(4);
        expect(BUCKET_CAPACITY - (row?.tokens ?? BUCKET_CAPACITY)).toBeCloseTo(granted * cost, 6);
        expect(row?.tokens ?? 0).toBeGreaterThanOrEqual(0);
      },
      TIMEOUT,
    );
  });

  describe('read by an instance in a different session time zone', () => {
    let skewed: PrismaClient[] = [];

    afterEach(async () => {
      await Promise.all(skewed.map((instance) => instance.$disconnect()));
      skewed = [];
    });

    it(
      'measures refill as elapsed time, not as the offset between two instances',
      async () => {
        skewed = instancesOf(1, SKEWED_ZONE);
        await spendIngestBudget(skewed[0]!, ABUSER, BUCKET_CAPACITY, NOW);

        // One minute later, from an instance whose session is in another zone. A column with no
        // zone stores the writer's wall clock and the reader converts it back in its own, so the
        // bucket appears to have been refilling for the offset between them — hours of allowance
        // that no time has passed for.
        const soon = new Date(NOW.getTime() + 60_000);

        expect((await spendIngestBudget(prisma, ABUSER, VIEWPORT, soon)).spent).toBe(false);
      },
      TIMEOUT,
    );

    it(
      'is swept on the clock the spend recorded, so retention cannot collect a live bucket',
      async () => {
        skewed = instancesOf(1, SKEWED_ZONE);
        await spendIngestBudget(skewed[0]!, ABUSER, BUCKET_CAPACITY, NOW);

        // `pruneIngestBuckets` reads the column through Prisma while the spend wrote it through
        // raw SQL. The two must agree about what instant the row holds, or retention deletes a
        // spent bucket and hands its owner a full allowance early.
        await pruneIngestBuckets(prisma, new Date(NOW.getTime() + 60_000));

        // This file's own rows, not the table-wide count the sweep returns.
        expect(await mine()).toBe(1);
        expect(
          await prisma.ingestRateBucket.findUnique({ where: { principal: ABUSER.key } }),
        ).not.toBeNull();
      },
      TIMEOUT,
    );
  });
  it(
    'holds a sustained caller to what the estate can drain, not just to its first burst',
    async () => {
      // Six hours of one caller asking for a viewport every three minutes — the shape that pinned
      // the product-wide queue while the allowance refilled at 240 tiles/hour against an estate
      // that drains a fraction of that. Measured at 780 tiles granted over this run.
      const step = 3 * 60_000;
      const hours = 6;
      let granted = 0;

      for (let at = 0; at < hours * 3_600_000; at += step) {
        const outcome = await spendIngestBudget(
          prisma,
          ABUSER,
          VIEWPORT,
          new Date(NOW.getTime() + at),
        );
        if (outcome.spent) granted += VIEWPORT;
      }

      // The burst, plus six hours of refill at the sustained rate, and nothing past it.
      expect(granted).toBeLessThanOrEqual(
        Math.ceil(BUCKET_CAPACITY + hours * PRINCIPAL_TILES_PER_HOUR),
      );
      /*
       * And under what the estate drains *of this kind* in those six hours, which is the property
       * that stops one caller pinning the ceiling against every other reader. Request kinds, not
       * all kinds: a bucket prices new ground, and comparing it to the all-kinds rate both flatters
       * the caller and leaves the assertion dead — the cap above is already below that number.
       */
      expect(granted).toBeLessThan(hours * REQUEST_DRAIN_TILES_PER_HOUR);
    },
    TIMEOUT,
  );

  it(
    'takes only the cost from an instance behind the clock: no phantom drain, no rewound clock',
    async () => {
      await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY - 10, NOW);
      const stored = await prisma.ingestRateBucket.findUnique({
        where: { principal: ABUSER.key },
      });

      const slow = new Date(NOW.getTime() - 15 * 60_000);
      const outcome = await spendIngestBudget(prisma, ABUSER, 1, slow);
      const after = await prisma.ingestRateBucket.findUnique({ where: { principal: ABUSER.key } });

      // Elapsed is clamped at zero, so the reading buys no refill — and costs nothing beyond the
      // spend. Without `GREATEST(0, …)` this bucket is drained by tiles nobody asked for.
      expect(outcome.spent).toBe(true);
      expect(after?.tokens).toBeCloseTo(9, 6);
      // And the row's clock never moves backwards. Writing the slow instance's `now` unclamped
      // rewinds it, and the next reader on a normal clock is handed the skew as free tokens.
      expect(after?.refilledAt.getTime()).toBe(stored?.refilledAt.getTime());
    },
    TIMEOUT,
  );
  it(
    'gives each caller its own log budget, so one cannot silence the warning for the rest',
    async () => {
      const warn = vi.mocked(console.warn);
      await spendIngestBudget(prisma, ABUSER, BUCKET_CAPACITY, NOW);
      await spendIngestBudget(prisma, BYSTANDER, BUCKET_CAPACITY, NOW);
      warn.mockClear();

      // Two callers refused inside the same minute. Held on one process-wide mark, whichever
      // trips first owns the budget and the second never appears — so a sustained abuser hides
      // itself and everybody else from the operator told to watch for this line.
      await spendIngestBudget(prisma, ABUSER, VIEWPORT, NOW);
      await spendIngestBudget(prisma, BYSTANDER, VIEWPORT, NOW);
      // ...and the interval still holds per caller, or the line becomes the flood it guards against.
      await spendIngestBudget(prisma, ABUSER, VIEWPORT, new Date(NOW.getTime() + 1_000));

      const lines = warn.mock.calls.map((call) => String(call[0]));
      expect(lines.filter((line) => line.includes(ABUSER.key))).toHaveLength(1);
      expect(lines.filter((line) => line.includes(BYSTANDER.key))).toHaveLength(1);
    },
    TIMEOUT,
  );
});
