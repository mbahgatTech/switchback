/**
 * The durable half of the ingest queue.
 *
 * `waitUntil` gives us latency: a user pans the map onto an unfetched tile and the work
 * starts before the response has finished streaming. What it does not give us is
 * durability — a deploy mid-flight, a function timeout, or a cold-start kill and the work
 * is simply gone, with the tile left marked `running` forever.
 *
 * So every kick also writes a row here, and a cron drains the table once a minute. The
 * immediate path and the durable path run the *same* handler, and the handler is
 * idempotent, so it does not matter which one gets there first or whether both do.
 *
 * The locking is a visibility timeout rather than `SELECT ... FOR UPDATE` held across the
 * work: the work takes minutes and holding a transaction open that long on a serverless
 * connection pool is how you exhaust it. Instead a claim stamps `lockedAt`/`lockedBy` in
 * one atomic statement, and a lock older than the timeout is treated as abandoned.
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
 * Queue a job, or revive the existing one.
 *
 * Twelve map requests for the same cold tile in the same second must produce one job, so
 * `dedupeKey` is unique and the eleven duplicate inserts collide. What happens on that
 * collision is the whole subtlety, and getting it wrong is silent:
 *
 * - **Still in flight** (`queued`, `running`) — leave the schedule alone. A job that has
 *   already backed off twice must not have its backoff reset by a fresh page load, or a
 *   tile Overpass is rate-limiting becomes a tile we hammer once per render.
 * - **Finished** (`done`, `failed`, `dead`) — reset it and run it again. This is the case
 *   the first version missed, and the bug was not subtle in its effects: a `dedupeKey`
 *   lives forever, so once `ingest_tile:0213012` reached `done` the row stayed `done`, and
 *   every later enqueue for that tile — a thirty-day staleness refresh, a retry after a
 *   fix, a user sitting on the tile watching it never load — collided with it and updated
 *   nothing. Each tile was ingestable exactly once in the lifetime of the database, and a
 *   tile whose five attempts happened to land during an Overpass outage stayed `dead`
 *   permanently. Reviving clears `attempts` too: this is a new request for the work, not a
 *   sixth try at the old one.
 *
 * Priority is raised in either case. If someone is now looking at a tile that was queued
 * as a background refresh, it should jump the line.
 *
 * Two statements rather than one, and the order matters. The revival runs first and is a
 * single conditional `UPDATE ... WHERE status IN (terminal)`, which Postgres applies
 * atomically: two concurrent enqueues against a `done` row both issue it, the first
 * matches and revives, the second matches nothing and does nothing. A read-then-write
 * would let both read `done` and both revive, resetting `attempts` twice. The upsert then
 * creates the row if this is the first time anyone has asked, and bumps priority if not.
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
      // `lastError` is deliberately kept. Until this attempt writes its own outcome, why
      // the last one failed is the only diagnostic the row carries.
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
 * Atomically claim up to `limit` runnable jobs.
 *
 * One statement, because two workers reading then writing would both claim the same row.
 * `FOR UPDATE SKIP LOCKED` in the subquery is what makes concurrent drains safe: the
 * second worker skips the rows the first is claiming instead of blocking on them.
 *
 * A job is runnable when it is queued and due, *or* when it is marked running but its lock
 * has expired — that second case is the recovery path for a worker that died mid-job.
 *
 * `dedupeKeys` narrows the claim to specific work, and the distinction it draws is between
 * the two callers. A cron drain wants whatever is most important in the whole table. A
 * request drain wants *the tiles under the map in front of someone*, and the global answer
 * is usually not that: every pending tile carries the same viewport priority, so ordering
 * falls through to `runAfter` and the oldest wins. Without this, panning to a new valley
 * starts four tiles from a viewport somebody left an hour ago and the one being watched
 * waits behind them — the work is not lost, it is merely never the work you are waiting on.
 */
export async function claimJobs(
  db: Db,
  workerId: string,
  limit = 4,
  now = new Date(),
  dedupeKeys?: readonly string[],
): Promise<ClaimedJob[]> {
  const lockCutoff = new Date(now.getTime() - LOCK_TIMEOUT_MS);
  // An empty array is a caller with nothing to ask for, not a caller asking for anything —
  // `IN ()` is not even valid SQL — so it is the one case that must not become "no filter".
  const scope =
    dedupeKeys === undefined
      ? Prisma.empty
      : dedupeKeys.length === 0
        ? Prisma.sql`AND false`
        : Prisma.sql`AND "dedupeKey" IN (${Prisma.join([...dedupeKeys])})`;

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
 * Record a failure and either reschedule or bury the job.
 *
 * `dead` rather than deleted, because a job that failed five times is the most
 * informative row in the table — it names a tile Overpass cannot serve, or a bug. Deleting
 * it would delete the evidence.
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
 * Put a job back without spending an attempt.
 *
 * For work this build is not equipped to do — as opposed to work it tried and could not
 * finish. The distinction matters because `failJob` counts, and five counts is `dead`: a
 * job whose only problem is that it arrived at the wrong build would be buried in under
 * three minutes of cron, and stay buried after the deploy that could have run it landed.
 *
 * `claimJobs` has already incremented `attempts` by the time anything can decide to defer,
 * so the increment is handed back here. A fixed delay rather than the backoff ladder, for
 * the same reason: the ladder is calibrated to a struggling upstream, and nothing is
 * struggling. The job is simply early.
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
}

/**
 * Claim and run a batch of jobs.
 *
 * Sequential, not parallel. The expensive step inside every handler is an Overpass call,
 * and that client already caps concurrency at two — running four handlers at once would
 * just queue three of them inside the client while holding four database connections open.
 * Serial here keeps this function's own connection count equal to one.
 *
 * That is this function's count, not the process's. A handler fans out internally, and more
 * than one drain can be running: the ceiling that matters is `commitGate` in `pipeline.ts`,
 * and the pool all of it draws from is `backgroundPrisma`, which is not the pool serving
 * requests. See `packages/db/src/client.ts` for why those are two pools and not one.
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
  } = {},
): Promise<DrainResult> {
  const db = options.db ?? backgroundPrisma;
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `drain-${now().toISOString()}`;

  const jobs = await claimJobs(db, workerId, options.limit ?? 4, now(), options.dedupeKeys);
  let succeeded = 0;
  let failed = 0;
  let deferred = 0;

  for (const job of jobs) {
    const handler = handlers[job.kind];
    if (!handler) {
      // An unhandled kind is a deploy-ordering problem, not a data problem: a newer
      // client enqueued work this build has no handler for. Hand it back untouched —
      // counting it as a failure would bury it before the deploy that can run it lands.
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

  return { claimed: jobs.length, succeeded, failed, deferred };
}

/** The dedupe key for a tile ingest. Exported so the router can enqueue without importing the pipeline. */
export function tileJobKey(quadkey: string): string {
  return `${JobKind.ingest_tile}:${quadkey}`;
}

export function trailEnrichJobKey(trailId: string): string {
  return `${JobKind.enrich_trail}:${trailId}`;
}

/**
 * The dedupe key for one routing tile's walkable network.
 *
 * Separate from `tileJobKey` despite both being quadkeys, and it has to be: the two fetches
 * cover the same ground at different zooms and answer different questions, so a shared key
 * would mean the trail ingest for a z9 tile and the network ingest for a z12 tile inside it
 * silently deduping onto one another the moment their quadkeys happened to collide.
 */
export function networkJobKey(quadkey: string): string {
  return `${JobKind.ingest_network}:${quadkey}`;
}

/**
 * The dedupe key for one long-distance route, keyed by its OSM relation id.
 *
 * Deliberately not tile-scoped, unlike everything else in this queue. A superroute is
 * discovered from whichever of its hundreds of tiles happens to be ingested, and every one
 * of them will discover it again; keying on the relation is what turns "the Pacific Crest
 * Trail crosses 340 of our tiles" into one job instead of 340 identical ones.
 */
export function routeIngestJobKey(osmId: number): string {
  return `${JobKind.ingest_route}:${osmId}`;
}
