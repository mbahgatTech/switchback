/**
 * The drain slot against a real Postgres. What the gate is made of is a `WHERE` clause, and no fake
 * client can answer whether Postgres counts a running row of a given kind against the bound.
 */

import { describe, expect, it, vi } from 'vitest';
import { JobKind, JobStatus, prisma } from '@switchback/db';
import type { Prisma, PrismaClient } from '@switchback/db';
import { OVERPASS_FREE_JOB_KINDS, OVERPASS_JOB_KINDS } from '../src/backpressure';
import { DRAIN_ADMISSION_KEY, drainSlotGate } from '../src/drain-slot';
import type { ClaimedBatch } from '../src/jobs';
import { enrichTrailPhotos } from '../src/pipeline';

const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(
  process.env.DATABASE_URL ?? '',
);

// Each case opens a transaction and takes the admission lock inside it, so it waits on whatever
// else is draining the same database. The default five seconds is a coin toss under a parallel run.
vi.setConfig({ testTimeout: 30_000 });

/** Owned by this file. Every row it writes is rolled back, so the names only have to be unique. */
const NS = 'zz-drain-slot-db';

class Rollback extends Error {}

/**
 * Run the body against the real tables and discard its writes. The gate counts `ingest_jobs`
 * database-wide, so a committed fixture would shut the slot for every other suite running now.
 */
async function rolledBack(body: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  let ran = false;
  await prisma
    .$transaction(
      async (tx) => {
        ran = true;
        await body(tx);
        throw new Rollback();
      },
      { timeout: 60_000, maxWait: 20_000 },
    )
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });

  // Without this a case could pass by never having run.
  expect(ran, 'the transaction body never ran').toBe(true);
}

/**
 * Hand the gate the transaction being rolled back in place of the one it would open. Its
 * statements stay the real ones, and `pg_advisory_xact_lock` releases on the rollback as it would
 * on a commit.
 */
function joinTransaction(tx: Prisma.TransactionClient): PrismaClient {
  return new Proxy(tx as object, {
    get(target, key) {
      if (key === '$transaction') {
        return (run: (client: Prisma.TransactionClient) => unknown) => run(tx);
      }
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as PrismaClient;
}

const EMPTY: ClaimedBatch = { primary: [], derived: [] };

/** Whether the gate admits at `limit`, observed without letting the drainer claim anything. */
async function admits(client: PrismaClient, limit: number): Promise<boolean> {
  let admitted = false;
  await drainSlotGate(
    client,
    limit,
  )(async () => {
    admitted = true;
    return EMPTY;
  });
  return admitted;
}

/**
 * The smallest limit the gate admits at, which is one more than the drainers it counted. Read
 * through the gate rather than by re-running its query, so a wrong query cannot agree with itself.
 */
async function admissionThreshold(client: PrismaClient): Promise<number> {
  for (let limit = 1; limit <= 64; limit += 1) {
    if (await admits(client, limit)) return limit;
  }
  throw new Error('the gate refused a drainer at every limit up to 64');
}

/** Drainers by the rule the gate used before it knew about kinds — the control, not the subject. */
async function drainersOfEveryKind(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ drainers: number }>>`
    select count(distinct "lockedBy")::int as drainers from ingest_jobs where status = 'running'
  `;
  return row?.drainers ?? 0;
}

let seq = 0;

/** A `running` row under a worker of its own, its lease fresh so the gate's sweep leaves it. */
async function seedDrainer(tx: Prisma.TransactionClient, kind: JobKind): Promise<void> {
  seq += 1;
  await tx.ingestJob.create({
    data: {
      kind,
      dedupeKey: `${NS}:${kind}:${seq}`,
      payload: {},
      status: JobStatus.running,
      lockedAt: new Date(),
      lockedBy: `${NS}-worker-${seq}`,
    },
  });
}

describe.runIf(IS_LOCAL).sequential('what the drain slot counts', () => {
  const PHOTO_DRAINERS = 3;

  it('admits a drainer while photo jobs run, because they reach no Overpass mirror', async () => {
    await rolledBack(async (tx) => {
      const client = joinTransaction(tx);
      const before = await admissionThreshold(client);
      const everyKindBefore = await drainersOfEveryKind(tx);

      for (let i = 0; i < PHOTO_DRAINERS; i += 1) {
        await seedDrainer(tx, JobKind.enrich_trail);
      }

      // The fixture is three drainers by the old rule: without this the case below could pass
      // against a seed that never landed.
      expect(await drainersOfEveryKind(tx)).toBe(everyKindBefore + PHOTO_DRAINERS);
      expect(await admissionThreshold(client), 'photo jobs closed the drain slot').toBe(before);
    });
  });

  it.each([...OVERPASS_JOB_KINDS])('keeps the slot shut against a running %s job', async (kind) => {
    await rolledBack(async (tx) => {
      const client = joinTransaction(tx);
      const before = await admissionThreshold(client);

      await seedDrainer(tx, kind);

      expect(await admissionThreshold(client), `a running ${kind} job is uncounted`).toBe(
        before + 1,
      );
    });
  });

  it('holds the admission lock while the claim runs', async () => {
    await rolledBack(async (tx) => {
      const client = joinTransaction(tx);
      const limit = await admissionThreshold(client);
      let heldAtClaim: number | null = null;

      await drainSlotGate(
        client,
        limit,
      )(async (db) => {
        const [row] = await db.$queryRaw<Array<{ held: number }>>`
          select count(*)::int as held from pg_locks
           where locktype = 'advisory' and objsubid = 1 and granted
             and pid = pg_backend_pid()
             and ((classid::bigint << 32) | objid::bigint) = ${DRAIN_ADMISSION_KEY}
        `;
        heldAtClaim = row?.held ?? 0;
        return EMPTY;
      });

      // Postgres itself, not the order of statements a fake recorded: under `READ COMMITTED` the
      // count is only worth anything while this lock is held.
      expect(heldAtClaim, 'the claim ran outside the admission lock').toBeGreaterThan(0);
    });
  });
});

/**
 * A kind is released from the bound on a claim about its handler, so each release is checked by
 * running that handler against an Overpass client that would record a request.
 */
describe.runIf(IS_LOCAL).sequential('what the drain slot releases', () => {
  it('releases only the kinds cleared below', () => {
    // A tripwire, not a restatement: adding a kind here without clearing it fails this case.
    expect([...OVERPASS_FREE_JOB_KINDS]).toEqual([JobKind.enrich_trail]);
  });

  const COMMONS_PHOTOS = 4;

  /** Four accepted Commons results, the shape `fetchCommonsPhotos` parses. */
  const commonsFetch = (async () =>
    new Response(
      JSON.stringify({
        query: {
          pages: Array.from({ length: COMMONS_PHOTOS }, (_unused, index) => ({
            pageid: index,
            title: `File:${NS}-${index}.jpg`,
            imageinfo: [{ url: `https://upload.wikimedia.org/${NS}-${index}.jpg` }],
            categories: [{ title: 'Category:Mountains of Scotland' }],
          })),
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )) as unknown as typeof fetch;

  async function seedTrail(tx: Prisma.TransactionClient): Promise<string> {
    const trail = await tx.trail.create({
      data: {
        slug: `${NS}-trail`,
        name: `${NS} Ridge`,
        geometryJson: {
          type: 'LineString',
          coordinates: [
            [-5, 56.8],
            [-4.9, 56.9],
          ],
        },
        centroidLng: -4.95,
        centroidLat: 56.85,
        bboxW: -5,
        bboxS: 56.8,
        bboxE: -4.9,
        bboxN: 56.9,
        lengthM: 8000,
        gainM: 0,
        lossM: 0,
        minEleM: 0,
        maxEleM: 0,
        estimatedTimeS: 1,
        difficulty: 'easy',
        difficultyScore: 0,
        routeType: 'point_to_point',
      },
      select: { id: true },
    });
    return trail.id;
  }

  it('runs a photo job to its last write without reaching Overpass', async () => {
    await rolledBack(async (tx) => {
      const trailId = await seedTrail(tx);
      const queries: string[] = [];

      const saved = await enrichTrailPhotos(trailId, {
        db: tx as unknown as PrismaClient,
        overpass: {
          query: (q: string) => {
            queries.push(q);
            return Promise.reject(new Error('enrich_trail reached Overpass'));
          },
        },
        fetchImpl: commonsFetch,
      });

      // The handler ran the whole way — fetch, upsert, hero, trail update — so the silence below
      // is a completed run rather than an early return.
      expect(saved, 'the handler returned before it could have made a request').toBe(
        COMMONS_PHOTOS,
      );
      expect(await tx.trail.findUniqueOrThrow({ where: { id: trailId } })).toMatchObject({
        photoCount: COMMONS_PHOTOS,
      });
      expect(queries, 'enrich_trail is not Overpass-free').toEqual([]);
    });
  });
});
