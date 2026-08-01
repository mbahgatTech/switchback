/**
 * The durable half of the ingest queue: every `waitUntil` kick also writes a row here and a
 * cron drains it, both through the same idempotent handler. See `docs/architecture.md`.
 */

import { JobKind, JobStatus, Prisma, backgroundPrisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';

/** How long a claimed job may run before another worker may take it. */
export const LOCK_TIMEOUT_MS = 10 * 60 * 1000;

/** Backoff between attempts, indexed by attempt number. Capped at the last entry. */
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000];

export type Db = PrismaClient | Prisma.TransactionClient;

export interface EnqueueInput {
  kind: JobKind;
  /** Stable per unit of work, e.g. `ingest_tile:0213012`. Collisions are the point. */
  dedupeKey: string;
  payload: Record<string, unknown>;
  /** Higher runs first. A tile someone is looking at outranks a scheduled refresh. */
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
}

/**
 * Queue a job, or revive the existing one. `dedupeKey` is unique, so twelve requests for one
 * cold tile produce one job, and what happens on the collision is the whole subtlety:
 *
 * - **Still in flight** (`queued`, `running`) — leave the schedule alone, or a fresh page load
 *   resets the backoff and a rate-limited tile becomes one we hammer once per render.
 * - **Finished** (`done`, `failed`, `dead`) — reset and run again. A `dedupeKey` lives
 *   forever, so without this each tile is ingestable exactly once in the database's lifetime
 *   and a tile whose attempts landed during an outage stays `dead`. `attempts` is cleared too:
 *   this is a new request, not a sixth try.
 *
 * Two statements, and the order matters. The revival is a single conditional `UPDATE ... WHERE
 * status IN (terminal)`, which Postgres applies atomically — a read-then-write would let two
 * concurrent enqueues both revive and reset `attempts` twice.
 */
export async function enqueue(db: Db, input: EnqueueInput): Promise<void> {
  const priority = input.priority ?? 0;
  const runAfter = input.runAfter ?? new Date();

  await db.ingestJob.updateMany({
    where: {
      dedupeKey: input.dedupeKey,
      status: { in: [JobStatus.done, JobStatus.failed, JobStatus.dead] },
    },
    data: {
      status: JobStatus.queued,
      attempts: 0,
      runAfter,
      lockedAt: null,
      lockedBy: null,
      completedAt: null,
      // `lastError` is deliberately kept: until this attempt writes its own outcome, why the
      // last one failed is the only diagnostic the row carries.
    },
  });

  await db.ingestJob.upsert({
    where: { dedupeKey: input.dedupeKey },
    create: {
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      payload: input.payload as Prisma.InputJsonValue,
      priority,
      runAfter,
      maxAttempts: input.maxAttempts ?? 5,
    },
    update: {
      // Only ever raised, never lowered: a background refresh enqueues at 0, which leaves
      // whatever a live viewport already set in place.
      priority: priority > 0 ? priority : undefined,
    },
  });
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/**
 * Atomically claim up to `limit` runnable jobs. One statement, because two workers reading
 * then writing would both claim the same row, and `FOR UPDATE SKIP LOCKED` in the subquery
 * makes the second skip rather than block. Runnable means queued and due, or running with an
 * expired lock — that second case recovers a worker that died mid-job.
 *
 * `dedupeKeys` narrows the claim to specific work: a request drain wants the tiles under the
 * map in front of somebody, and the global answer is usually not that, since every pending
 * tile shares one viewport priority and ordering falls through to the oldest `runAfter`.
 *
 * `kinds` narrows it the other way, because `ORDER BY priority DESC` is a starvation order:
 * derived work sits at `-10` and is never claimed while any request job is runnable. See
 * `drainJobs`, which uses this to reserve a share.
 */
export async function claimJobs(
  db: Db,
  workerId: string,
  limit = 4,
  now = new Date(),
  dedupeKeys?: readonly string[],
  kinds?: readonly JobKind[],
): Promise<ClaimedJob[]> {
  const lockCutoff = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  // An empty array is a caller with nothing to ask for, not a caller asking for anything, so
  // it must not become "no filter" — and `IN ()` is not valid SQL either way.
  const scope =
    dedupeKeys === undefined
      ? Prisma.empty
      : dedupeKeys.length === 0
        ? Prisma.sql`AND false`
        : Prisma.sql`AND "dedupeKey" IN (${Prisma.join([...dedupeKeys])})`;

  // Same rule for the kind filter. The cast is on the *parameter*, never on the column:
  // `kind::text = ANY(…)` reads identically and quietly throws away `@@index([kind, status])`,
  // because a cast column is not the indexed expression, so the predicate demotes from a seek
  // to a filter over the whole `status` range (measured: cost 2595 against 4127 on 164k rows).
  const kindScope =
    kinds === undefined
      ? Prisma.empty
      : kinds.length === 0
        ? Prisma.sql`AND false`
        : Prisma.sql`AND kind = ANY(${kinds.map(String)}::"JobKind"[])`;

  const rows = await db.$queryRaw<
    Array<{
      id: string;
      kind: JobKind;
      dedupeKey: string;
      payload: Record<string, unknown>;
      attempts: number;
      maxAttempts: number;
    }>
  >`
    UPDATE ingest_jobs SET
      status     = 'running',
      "lockedAt" = ${now},
      "lockedBy" = ${workerId},
      attempts   = attempts + 1
    WHERE id IN (
      SELECT id FROM ingest_jobs
       WHERE ((status = 'queued'  AND "runAfter" <= ${now})
           OR (status = 'running' AND "lockedAt" < ${lockCutoff}))
       ${scope}
       ${kindScope}
       ORDER BY priority DESC, "runAfter" ASC
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, "dedupeKey", payload, attempts, "maxAttempts"
  `;

  return rows;
}

export async function completeJob(db: Db, jobId: string, now = new Date()): Promise<void> {
  await db.ingestJob.update({
    where: { id: jobId },
    data: {
      status: JobStatus.done,
      completedAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
}

/**
 * Record a failure and either reschedule or bury the job. `dead` rather than deleted: a job
 * that failed five times names a tile Overpass cannot serve, or a bug, and deleting it deletes
 * the evidence.
 */
export async function failJob(
  db: Db,
  job: Pick<ClaimedJob, 'id' | 'attempts' | 'maxAttempts'>,
  error: unknown,
  now = new Date(),
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const delay = RETRY_DELAYS_MS[Math.min(job.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;

  await db.ingestJob.update({
    where: { id: job.id },
    data: {
      status: exhausted ? JobStatus.dead : JobStatus.queued,
      runAfter: exhausted ? undefined : new Date(now.getTime() + delay),
      lockedAt: null,
      lockedBy: null,
      lastError: message.slice(0, 1000),
      completedAt: exhausted ? now : undefined,
    },
  });
}

/**
 * Put a job back without spending an attempt — for work this build is not equipped to do, as
 * opposed to work it tried and could not finish. `failJob` counts, and five counts is `dead`,
 * so a job that merely arrived at the wrong build would be buried before the deploy that could
 * run it lands. `claimJobs` has already incremented `attempts`, so the increment is handed
 * back here, and the delay is fixed rather than the backoff ladder: nothing is struggling.
 */
export async function deferJob(
  db: Db,
  job: Pick<ClaimedJob, 'id' | 'attempts'>,
  reason: string,
  now = new Date(),
  delayMs = DEFER_DELAY_MS,
): Promise<void> {
  await db.ingestJob.update({
    where: { id: job.id },
    data: {
      status: JobStatus.queued,
      attempts: Math.max(job.attempts - 1, 0),
      runAfter: new Date(now.getTime() + delayMs),
      lockedAt: null,
      lockedBy: null,
      lastError: reason.slice(0, 1000),
    },
  });
}

/** How long a deferred job waits. Long enough that a rolling deploy finishes inside it. */
export const DEFER_DELAY_MS = 5 * 60_000;

export type JobHandler = (job: ClaimedJob) => Promise<void>;

export interface DrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
  /** Claimed but handed back untried — a kind this build has no handler for. */
  deferred: number;
  /** How many of `claimed` came from the reserved derived share. */
  derived: number;
}

/**
 * The kinds `drainJobs` reserves a share for. Duplicated from `backpressure.ts` rather than
 * imported, because importing would be a cycle (`backpressure` → `coverage` → `jobs`). A third
 * derived kind belongs in both lists.
 */
const DERIVED_KINDS = [JobKind.enrich_trail, JobKind.ingest_route] as const;

/**
 * Claim and run a batch of jobs. Sequential, not parallel: the expensive step in every handler
 * is an Overpass call and that client already caps concurrency at two, so four handlers at
 * once would queue three inside the client while holding four connections. The ceiling across
 * drains is `commitGate` in `pipeline.ts`, over the `backgroundPrisma` pool.
 *
 * **`derivedLimit` is a fairness reservation, and without it derived work never runs.** A
 * plain claim orders by `priority DESC` and derived jobs sit at `-10`, while both inline kicks
 * scope their claim to the tile keys they just queued and so cannot reach one at all. The
 * second, kind-scoped claim costs one more indexed statement and makes the backlog fall at the
 * rate of the traffic that creates it.
 */
export async function drainJobs(
  handlers: Partial<Record<JobKind, JobHandler>>,
  options: {
    db?: Db;
    workerId?: string;
    limit?: number;
    now?: () => Date;
    /** Claim only these units of work. Omitted means "whatever is most important". */
    dedupeKeys?: readonly string[];
    /** Additionally claim up to this many derived jobs, which priority would never reach. */
    derivedLimit?: number;
  } = {},
): Promise<DrainResult> {
  const db = options.db ?? backgroundPrisma;
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `drain-${now().toISOString()}`;

  const primary = await claimJobs(db, workerId, options.limit ?? 4, now(), options.dedupeKeys);

  /*
   * Unscoped by `dedupeKey` on purpose — the point is to reach work nobody asked for by name.
   * Claimed after the primary batch so a caller waiting on specific tiles still gets those
   * first.
   *
   * Its own try/catch, and the ordering is why: the primary statement has already flipped its
   * batch to `running`, so a rejection propagating out of `drainJobs` would leave that batch
   * locked until `LOCK_TIMEOUT_MS` expires. A fairness optimisation is not worth ten minutes
   * of the queue, so a failure degrades to "no derived work this tick".
   */
  const derivedLimit = options.derivedLimit ?? 0;
  let derived: ClaimedJob[] = [];
  if (derivedLimit > 0) {
    try {
      derived = await claimJobs(db, workerId, derivedLimit, now(), undefined, DERIVED_KINDS);
    } catch (error) {
      console.error('[ingest] derived claim failed; draining primary batch only', error);
    }
  }

  const jobs = [...primary, ...derived];
  let succeeded = 0;
  let failed = 0;
  let deferred = 0;

  for (const job of jobs) {
    const handler = handlers[job.kind];
    if (!handler) {
      // An unhandled kind is a deploy-ordering problem, not a data problem: a newer client
      // enqueued work this build has no handler for. Counting it as a failure would bury it
      // before the deploy that can run it lands.
      await deferJob(db, job, `no handler registered for job kind "${job.kind}"`, now());
      deferred += 1;
      continue;
    }
    try {
      await handler(job);
      await completeJob(db, job.id, now());
      succeeded += 1;
    } catch (error) {
      await failJob(db, job, error, now());
      failed += 1;
    }
  }

  return { claimed: jobs.length, succeeded, failed, deferred, derived: derived.length };
}

/** The dedupe key for a tile ingest. Exported so the router can enqueue without importing the pipeline. */
export function tileJobKey(quadkey: string): string {
  return `${JobKind.ingest_tile}:${quadkey}`;
}

export function trailEnrichJobKey(trailId: string): string {
  return `${JobKind.enrich_trail}:${trailId}`;
}

/**
 * The dedupe key for one routing tile's walkable network. Separate from `tileJobKey` despite
 * both being quadkeys: a shared key would let a z9 trail tile and a z12 network tile dedupe
 * onto one another whenever their quadkeys collide.
 */
export function networkJobKey(quadkey: string): string {
  return `${JobKind.ingest_network}:${quadkey}`;
}

/**
 * The dedupe key for one long-distance route, keyed by its OSM relation id and deliberately
 * not tile-scoped: every one of the PCT's 340 tiles rediscovers it, and this makes that one
 * job rather than 340 identical ones.
 */
export function routeIngestJobKey(osmId: number): string {
  return `${JobKind.ingest_route}:${osmId}`;
}

/**
 * How long a finished job is kept before the drain collects it. A `done` row is pure history —
 * `enqueue` revives a terminal row rather than reading it — so a week is just long enough to
 * answer "did that tile ever run". `failed` and `dead` are kept longer: a `dead` row is the
 * only record of five attempts, and `scripts/requeue-jobs.ts` reads them.
 */
export const DONE_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const FAILED_JOB_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Delete terminal jobs past their window, so the table grows with queue depth rather than with
 * lifetime job count — admission control counts it on the hot path behind `trails.browse`.
 * Bounded by `completedAt`, which every terminal transition sets; a row missing it is left
 * alone rather than guessed at.
 */
export async function pruneFinishedJobs(
  db: Db,
  now: Date = new Date(),
): Promise<{ done: number; failed: number }> {
  const [done, failed] = await Promise.all([
    db.ingestJob.deleteMany({
      where: {
        status: JobStatus.done,
        completedAt: { lt: new Date(now.getTime() - DONE_JOB_TTL_MS) },
      },
    }),
    db.ingestJob.deleteMany({
      where: {
        status: { in: [JobStatus.failed, JobStatus.dead] },
        completedAt: { lt: new Date(now.getTime() - FAILED_JOB_TTL_MS) },
      },
    }),
  ]);

  return { done: done.count, failed: failed.count };
}
