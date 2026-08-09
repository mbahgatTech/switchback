/**
 * The durable record of the ingest queue: every enqueue writes a row here, and the Function App
 * drains it through the idempotent handlers. See `docs/architecture.md`.
 */

import { JobKind, JobStatus, Prisma, backgroundPrisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';

/**
 * The host's kill deadline, mirrored from `apps/ingest-worker/host.json` `functionTimeout`.
 * `apps/ingest-worker/test/drain.test.ts` reads that file and fails if the two disagree.
 */
export const HOST_FUNCTION_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Margin above the host's kill deadline, covering clock skew between the app and Postgres and the
 * bookkeeping after the last phase.
 */
export const LEASE_MARGIN_MS = 2 * 60 * 1000;

/**
 * How long a claim holds a job before `reclaimExpiredJobs` may take it back.
 *
 * **Bounded by the host, not by the work, and not by the broker.** One process claims — the
 * Function App's `ingestDrain` — so a lease older than `functionTimeout` has provably lost its
 * holder. Deriving it from that constant is what stops the two drifting apart: raising
 * `functionTimeout` without raising this would let a reclaim fire under a handler still working,
 * and a second process would then commit the same trails alongside it.
 *
 * **A redelivery cannot be relied on to find this expired, and no value of it would change that.**
 * The broker's redelivery gap starts at `lockDuration` — auto-renewal stops the instant the process
 * dies, and an eviction can kill it before the first renewal — while this must exceed
 * `functionTimeout` to be safe under a live handler. `lockDuration` (300 s) is below
 * `functionTimeout` (600 s), so the two requirements have no common value. Measured over
 * 2026-08-08's six redeliveries, the gaps were 299.9, 300.0, 455.0, 592.8, 708.1 and 1012.7 s:
 * five of the six arrived while the lease was still live, and the two at the floor came back at
 * exactly `lockDuration`.
 *
 * So the redelivery is not the repair. The reaper is: `reclaimExpiredJobs` returns the row to
 * `queued` at `RECLAIM_PRIORITY`, above every band `enqueue` assigns, and `runPump` sweeps before
 * it selects — so the row clears the ordinary backlog rather than rejoining the tail of its own
 * band. It does not clear the reclaimed band: that elevation is a fixed value, so reclaimed rows
 * sort among themselves by `runAfter` and a tick publishes at most
 * `PUMP_QUEUE_DEPTH - PUMP_DERIVED_SHARE` of them. `apps/ingest-worker/test/pump.test.ts` asserts
 * both halves.
 * `apps/ingest-worker/test/drain.test.ts` asserts the template relation that makes the republish
 * durable: the broker's duplicate detection window has to be *shorter* than this, or the republish
 * is discarded as a duplicate of the message a delivery already completed and the work is lost
 * with nothing logged.
 */
export const LEASE_TIMEOUT_MS = HOST_FUNCTION_TIMEOUT_MS + LEASE_MARGIN_MS;

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
 *   and a tile whose attempts landed during an outage stays `dead`. `attempts` and `priority`
 *   are both reset: this is a new request, not a sixth try, so it starts at the band its caller
 *   asks for. Leaving `priority` alone would let a row the reaper had raised to
 *   `RECLAIM_PRIORITY` keep that elevation for the rest of its life, because the raise below
 *   cannot lower it and nothing else writes the column.
 *
 * Three statements, each a single conditional `UPDATE` Postgres applies atomically. A
 * read-then-write would let two concurrent enqueues both revive and reset `attempts` twice, and
 * would let either of them write back a priority the other had already raised. The reset above
 * is the one write that lowers, and it is safe under concurrency because the revive clears the
 * very status it selects on: one of two racing enqueues performs it, and every raise that
 * follows — the loser's included — only climbs.
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
      priority,
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
    // Priority is raised by the statement below, never here. `update` cannot read the row it is
    // writing, so any value set here is unconditional — and an enqueue at `VIEWPORT_PRIORITY` (5)
    // landing on a lease the reaper had just raised to `RECLAIM_PRIORITY` (6) would demote the one
    // row in the table that has to reach the head of the queue.
    update: {},
  });

  await db.ingestJob.updateMany({
    where: { dedupeKey: input.dedupeKey, priority: { lt: priority } },
    data: { priority },
  });
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  /** The lease this claim was granted. Every outcome is written under it — see `writeOutcome`. */
  lockedAt: Date;
  lockedBy: string;
}

/**
 * Atomically claim up to `limit` runnable jobs. One statement, because two workers reading
 * then writing would both claim the same row, and `FOR UPDATE SKIP LOCKED` in the subquery
 * makes the second skip rather than block.
 *
 * Runnable means queued and due, and nothing else. Reclaiming an expired lease used to be a
 * second arm of this predicate, which put it behind `ORDER BY priority DESC … LIMIT`: with a
 * five-figure backlog ahead of them, nineteen jobs a dead worker was holding never once
 * reached the top four in seventy-five hours. `reclaimExpiredJobs` owns that transition now,
 * under no limit and no ordering, and it is the only way out of `running`.
 *
 * `dedupeKeys` narrows the claim to specific work: a message names one tile, and the global
 * answer is usually not that, since every pending tile shares one viewport priority and ordering
 * falls through to the oldest `runAfter`.
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

  const rows = await db.$queryRaw<ClaimedJob[]>`
    UPDATE ingest_jobs SET
      status     = 'running',
      "lockedAt" = ${now},
      "lockedBy" = ${workerId},
      attempts   = attempts + 1
    WHERE id IN (
      SELECT id FROM ingest_jobs
       WHERE status = 'queued' AND "runAfter" <= ${now}
       ${scope}
       ${kindScope}
       ORDER BY priority DESC, "runAfter" ASC
       LIMIT ${limit}
       FOR UPDATE SKIP LOCKED
    )
    RETURNING id, kind, "dedupeKey", payload, attempts, "maxAttempts", "lockedAt", "lockedBy"
  `;

  return rows;
}

/** What a worker must still hold for its outcome to be believed. */
type Lease = Pick<ClaimedJob, 'id' | 'lockedAt' | 'lockedBy'>;

/**
 * Write a job's outcome, but only if the worker still holds the lease it was granted — a fence,
 * not an idempotent write. The handlers are idempotent (every commit is an upsert on a natural
 * key), so a duplicate *run* is merely wasted; the bookkeeping is not, and that is what this
 * guards. A late `failJob` would requeue work that has since finished and null a lock a live
 * worker is holding, letting a third worker run the job alongside it.
 *
 * `(status, lockedBy, lockedAt)` names one lease. `status` is what releases it: every exit from
 * `running` writes a different status, so a stale worker matches nothing the moment anything else
 * has touched the row — including the case the other two cannot see, where a reclaim requeued the
 * job and left the same pair behind. The pair then distinguishes two *running* leases, and
 * `lockedBy` alone would not do, since `'cron'` and `'inline'` are fixed strings.
 *
 * **The lease columns survive the outcome, and that is deliberate.** Nulling them on the way out
 * is the obvious way to release a lease and it erases the only record of which process ran the
 * job — see `lockedBy` in `packages/db/prisma/schema.prisma` for the forensic queries that
 * depend on their surviving, and `docs/architecture.md` for why `INGEST_MAX_DRAINERS` is
 * otherwise unobservable.
 */
async function writeOutcome(
  db: Db,
  lease: Lease,
  data: Prisma.IngestJobUpdateManyMutationInput,
): Promise<boolean> {
  const { count } = await db.ingestJob.updateMany({
    where: {
      id: lease.id,
      status: JobStatus.running,
      lockedBy: lease.lockedBy,
      lockedAt: lease.lockedAt,
    },
    data,
  });
  return count > 0;
}

/** Mark a job done. False when the lease had already been reclaimed — see `writeOutcome`. */
export async function completeJob(db: Db, job: Lease, now = new Date()): Promise<boolean> {
  return writeOutcome(db, job, {
    status: JobStatus.done,
    completedAt: now,
    lastError: null,
  });
}

/**
 * Record a failure and either reschedule or bury the job. `dead` rather than deleted: a job
 * that failed five times names a tile Overpass cannot serve, or a bug, and deleting it deletes
 * the evidence.
 */
export async function failJob(
  db: Db,
  job: Lease & Pick<ClaimedJob, 'attempts' | 'maxAttempts'>,
  error: unknown,
  now = new Date(),
): Promise<boolean> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;
  const delay = RETRY_DELAYS_MS[Math.min(job.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;

  return writeOutcome(db, job, {
    status: exhausted ? JobStatus.dead : JobStatus.queued,
    runAfter: exhausted ? undefined : new Date(now.getTime() + delay),
    lastError: message.slice(0, 1000),
    completedAt: exhausted ? now : undefined,
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
  job: Lease & Pick<ClaimedJob, 'attempts'>,
  reason: string,
  now = new Date(),
  delayMs = DEFER_DELAY_MS,
): Promise<boolean> {
  return writeOutcome(db, job, {
    status: JobStatus.queued,
    attempts: Math.max(job.attempts - 1, 0),
    runAfter: new Date(now.getTime() + delayMs),
    lastError: reason.slice(0, 1000),
  });
}

/** How long a deferred job waits. Long enough that a rolling deploy finishes inside it. */
export const DEFER_DELAY_MS = 5 * 60_000;

export interface ReclaimResult {
  /** Leases returned to the queue for another worker to take. */
  requeued: number;
  /** Leases whose job was out of attempts and is now `dead`. */
  retired: number;
  /** The units of work that lost their holder, in the order the reaper found them. */
  reclaimed: ReclaimedLease[];
}

/** A lease that expired with no outcome, and the process that held it when it died. */
export interface ReclaimedLease {
  dedupeKey: string;
  /** Where the reaper put it: `queued` to run again, or `dead` if it was out of attempts. */
  status: JobStatus;
  lockedBy: string | null;
}

/**
 * The literal `switchback-ingest-lease-expired` greps for.
 *
 * A handler the host kills mid-tile writes no request row and no error — the invocation stops
 * between two awaits — so a rule reading `requests | success == false` is structurally incapable
 * of firing on it. What it does leave behind is a `running` row nothing will renew, and the
 * reaper below is the process that discovers it.
 *
 * The token belongs here rather than on the redelivery that finds the tile busy. A redelivery
 * mostly arrives while the lease is still live — measured 2026-08-08, five of six did — so it sees
 * a `running` row it cannot distinguish from healthy work and has nothing to report. The reaper is
 * the only participant that observes the death itself, whenever it happens to run.
 */
export const LEASE_EXPIRED_MARKER = 'switchback-ingest-lease-expired';

/** How many keys the marker line names before it stops; the count is always exact. */
const MARKER_KEY_LIMIT = 10;

/**
 * Priority a requeued lease is raised to: above every band `enqueue` assigns, so the next pump
 * tick reaches the row ahead of the backlog rather than from wherever that backlog had put it.
 *
 * **Returning the row to `queued` is not on its own enough to get it re-run.** `runPump` publishes
 * `PUMP_QUEUE_DEPTH - PUMP_DERIVED_SHARE` primary rows a tick from the head of
 * `priority DESC, "runAfter" ASC`, and every viewport tile shares one priority — so a row put back
 * at the priority it had sorts to the tail of its own band and is reached when the backlog ahead of
 * it drains. `classifyDisposition` completes a Service Bus message on the strength of this
 * elevation, and that decision is irreversible.
 *
 * **What it buys is the ordinary backlog, not the head of the queue.** Raised to a fixed value
 * rather than incremented, so repeated reclaims are idempotent: reclaimed rows form one band
 * ordered among themselves by `runAfter`, never a ladder that climbs away from the queue. The band
 * is therefore subject to the same per-tick window as any other — one tick while it fits inside
 * that window, its own drain when it does not. `apps/ingest-worker/test/pump.test.ts` asserts each
 * half against an ordered backlog.
 *
 * It cannot starve ordinary work, and two things hold that. `reclaimExpiredJobs` is the only
 * writer of this band and spends an attempt every time it writes, so `maxAttempts` retires a
 * reliably fatal job rather than republishing it forever. Retirement leaves the elevation on the
 * row, so `enqueue` resets `priority` when it revives a finished one — the elevation cannot
 * outlive the lease that earned it, and a revived row competes at the band its request asks for.
 * `packages/ingest/test/jobs.test.ts` asserts both halves.
 */
export const RECLAIM_PRIORITY = 6;

/**
 * Take back every job whose lease has expired: the reaper, and the only route out of `running`
 * for a worker that never came back. Unbounded and unordered on purpose — that is the whole
 * difference from the arm of `claimJobs` this replaces, which could only ever recover a job
 * that also happened to be in the top `limit` of `priority DESC, runAfter ASC`.
 *
 * The increment is what makes a job that kills its worker terminate: it costs an attempt per
 * crash, on top of the one the claim spent, so `maxAttempts` retires a reliably fatal job in
 * two crashes rather than five. `runAfter` is deliberately left where it is — a crash is not an
 * upstream saying "slow down", and `LEASE_TIMEOUT_MS` has already spaced the retry by twelve
 * minutes. `lastError` is set on both paths because these rows carried a null one for
 * seventy-five hours and nothing on them said why.
 */
export async function reclaimExpiredJobs(
  db: Db,
  now = new Date(),
  timeoutMs = LEASE_TIMEOUT_MS,
  log: (line: string) => void = (line) => console.warn(line),
): Promise<ReclaimResult> {
  const cutoff = new Date(now.getTime() - timeoutMs);
  const reason = `lease expired after ${Math.round(timeoutMs / 60_000)} min with no outcome`;

  // One statement, so a job cannot be requeued and buried by two racing sweeps. Every
  // `attempts + 1` here reads the *old* row — Postgres evaluates the whole SET against the row
  // as it was — so the retirement test and the new count are the same number. `RETURNING`
  // reports the new status, which is how the two dispositions are counted apart.
  //
  // `lockedAt` and `lockedBy` are left alone: the status change is what releases the lease, and
  // they are the record of which process held it when it died.
  const rows = await db.$queryRaw<ReclaimedLease[]>`
    UPDATE ingest_jobs SET
      attempts      = attempts + 1,
      status        = CASE WHEN attempts + 1 >= "maxAttempts"
                           THEN 'dead'::"JobStatus" ELSE 'queued'::"JobStatus" END,
      priority      = CASE WHEN attempts + 1 >= "maxAttempts"
                           THEN priority ELSE GREATEST(priority, ${RECLAIM_PRIORITY}::int) END,
      "completedAt" = CASE WHEN attempts + 1 >= "maxAttempts"
                           THEN ${now} ELSE "completedAt" END,
      "lastError"   = ${reason}
    WHERE status = 'running' AND "lockedAt" < ${cutoff}
    RETURNING status, "dedupeKey", "lockedBy"
  `;

  if (rows.length > 0) {
    const named = rows
      .slice(0, MARKER_KEY_LIMIT)
      .map((row) => `${row.dedupeKey} (held by ${row.lockedBy ?? 'nobody'} -> ${row.status})`)
      .join('; ');
    const rest = rows.length > MARKER_KEY_LIMIT ? `; +${rows.length - MARKER_KEY_LIMIT} more` : '';
    log(`${LEASE_EXPIRED_MARKER} ${rows.length} lease(s) expired with no outcome: ${named}${rest}`);
  }

  const retired = rows.filter((row) => row.status === JobStatus.dead).length;
  return { requeued: rows.length - retired, retired, reclaimed: rows };
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** The two claims one drain makes: its batch, and the derived share reserved on top. */
export interface ClaimedBatch {
  primary: ClaimedJob[];
  derived: ClaimedJob[];
}

/**
 * Wraps a drain's claims so a caller can bound how many processes drain at once.
 *
 * It has to wrap the claim rather than precede it. A check that runs first and a claim that runs
 * after are two statements, and under `READ COMMITTED` two processes both read "nobody is
 * draining" before either has committed — see `drainSlotGate`, the implementation that closes
 * that window, and `docs/architecture.md` for why the bound is a correctness requirement.
 */
export type ClaimGate = (claim: (db: Db) => Promise<ClaimedBatch>) => Promise<ClaimedBatch>;

export interface DrainResult {
  claimed: number;
  succeeded: number;
  failed: number;
  /** Claimed but handed back untried — a kind this build has no handler for. */
  deferred: number;
  /** Claimed, run, and the outcome dropped because the lease had expired — see `writeOutcome`. */
  lost: number;
  /** How many of `claimed` came from the reserved derived share. */
  derived: number;
  /** Expired leases this drain returned to the queue before claiming. */
  requeued: number;
  /** Expired leases this drain buried, out of attempts. */
  retired: number;
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
 * plain claim orders by `priority DESC` and derived jobs sit at `-10`, while a message-scoped
 * drain narrows its claim to the one tile the message named and so cannot reach one at all. The
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
    /**
     * Bounds how many processes may hold Overpass-making work at once. Omitted means unbounded,
     * which is right only for a caller that is not draining Overpass work — a test, or a
     * bookkeeping pass. Application code reaches the queue through `drainIngest`, which supplies
     * `drainSlotGate` unless the caller explicitly passes `null`.
     */
    gate?: ClaimGate;
  } = {},
): Promise<DrainResult> {
  const db = options.db ?? backgroundPrisma;
  const now = options.now ?? (() => new Date());
  const workerId = options.workerId ?? `drain-${now().toISOString()}`;

  /*
   * Before claiming, not after: a lease that expired a moment ago should be claimable in this
   * same tick rather than the next one.
   *
   * No longer the *only* sweep, and that is the point: `sweepQueue` runs it from `ingestPump`'s
   * two-minute tick, which drains nothing, so a lease left by a killed handler is reclaimed on a
   * schedule of its own rather than waiting for the next drainer to arrive.
   *
   * Its own try/catch for the same reason the derived claim below has one: bookkeeping must not
   * be able to stop the drain.
   */
  let requeued = 0;
  let retired = 0;
  try {
    ({ requeued, retired } = await reclaimExpiredJobs(db, now()));
  } catch (error) {
    console.error('[ingest] lease sweep failed; draining without it', error);
  }

  /*
   * Both claims, under whatever gate the caller supplied.
   *
   * Together rather than separately because the gate admits a *drainer*, not a statement: a
   * process let through for its primary batch has to be able to take its derived share too, and
   * one that was turned away must take neither. The derived claim keeps its own try/catch —
   * inside the gate now, so a failure there still leaves the primary batch claimed rather than
   * unwinding a transaction that has already flipped it to `running`.
   */
  const derivedLimit = options.derivedLimit ?? 0;
  const claim = async (client: Db): Promise<ClaimedBatch> => {
    const primary = await claimJobs(
      client,
      workerId,
      options.limit ?? 4,
      now(),
      options.dedupeKeys,
    );

    /*
     * Unscoped by `dedupeKey` on purpose — the point is to reach work nobody asked for by name.
     * Claimed after the primary batch so a caller waiting on specific tiles still gets those
     * first.
     */
    let derived: ClaimedJob[] = [];
    if (derivedLimit > 0) {
      try {
        derived = await claimJobs(client, workerId, derivedLimit, now(), undefined, DERIVED_KINDS);
      } catch (error) {
        console.error('[ingest] derived claim failed; draining primary batch only', error);
      }
    }
    return { primary, derived };
  };

  const { primary, derived } = options.gate ? await options.gate(claim) : await claim(db);

  const jobs = [...primary, ...derived];
  let succeeded = 0;
  let failed = 0;
  let deferred = 0;
  let lost = 0;

  for (const job of jobs) {
    const handler = handlers[job.kind];
    if (!handler) {
      // An unhandled kind is a deploy-ordering problem, not a data problem: a newer client
      // enqueued work this build has no handler for. Counting it as a failure would bury it
      // before the deploy that can run it lands.
      const held = await deferJob(
        db,
        job,
        `no handler registered for job kind "${job.kind}"`,
        now(),
      );
      if (held) deferred += 1;
      else lost += 1;
      continue;
    }
    try {
      await handler(job);
      if (await completeJob(db, job, now())) succeeded += 1;
      else lost += 1;
    } catch (error) {
      if (await failJob(db, job, error, now())) failed += 1;
      else lost += 1;
    }
  }

  return {
    claimed: jobs.length,
    succeeded,
    failed,
    deferred,
    lost,
    derived: derived.length,
    requeued,
    retired,
  };
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
