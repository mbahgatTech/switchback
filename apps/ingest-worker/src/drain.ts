/**
 * One message, one job. The work itself is `@switchback/ingest` — this decides only what a
 * result means to the broker, which is where the two systems have to agree.
 */

import { JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { backgroundPrisma } from '@switchback/db';
import {
  LEASE_TIMEOUT_MS,
  OVERPASS_MAX_TOTAL_MS,
  drainIngest,
  getOverpass,
  withDeadline,
} from '@switchback/ingest';
import type { DrainResult, OverpassQuerier } from '@switchback/ingest';
import type { WorkerLog } from './log';
import type { IngestSignal } from './message';

/** The seam tests replace. Production always passes `drainIngest`. */
export type Drain = typeof drainIngest;

/**
 * The whole handler's wall clock, measured from the moment the message arrives.
 *
 * `host.json` sets `functionTimeout` to ten minutes and Consumption will not raise it — the host
 * kills the process, which strands the `ingest_jobs` lease and redelivers the message. 540 s
 * leaves 60 s of the host's 600 s for the phase that was already running when the clock ran out:
 * one terrain fetch (20 s cap), one trail's transaction, plus the job bookkeeping. Past it no
 * phase may *begin*, whichever phase it is — `PipelineDeps.deadlineAt` carries the same number to
 * terrain and to the per-trail commits.
 */
export const HANDLER_DEADLINE_MS = 540_000;

/**
 * Wall clock held back for the commit loop, and the reason a handler can now end by finishing a
 * tile rather than by expiring.
 *
 * Overpass had its own start-by deadline of 300 s and `OVERPASS_MAX_TOTAL_MS` of 240 s, which sum
 * to the entire 540 s handler budget: a tile whose two queries were slow reached `commitTrail`
 * with nothing left, every trail threw `IngestDeadlineError`, and the tile subdivided into four
 * children that each repeated the exercise. Measured 2026-08-08: six invocations ran 540,111 ms to
 * 548,954 ms past a 540,000 ms bound, every one of them reporting success.
 *
 * Reserving the tail closes that: the last moment a pre-commit query may start is
 * `HANDLER_DEADLINE_MS - OVERPASS_MAX_TOTAL_MS - INGEST_COMMIT_RESERVE_MS`, so whatever Overpass
 * does the commit loop still gets this long. A tile that then runs out of clock has run out of it
 * *committing trails*, which is what "too big for one invocation" actually looks like and what
 * subdivision is the answer to.
 *
 * **150 s is what the commit loop measurably needs.** Of the 23 invocations between 2026-08-05 and
 * 2026-08-08 that logged `assembled` and finished inside the handler budget, the work after
 * assembly took 32.9 s to 381.2 s, median ~133 s. The reserve clears the median; it is not a
 * promise that every tile fits, which is subdivision's job and not a budget's.
 *
 * **Batching the writes does not move it.** The reserve covers the whole commit phase, and that
 * phase is compute: on quadkey 023010230 the per-trail scans in `attachWaypoints` are 99.5% of
 * it, and batching touches only the round trips underneath. Measured on a local PostGIS over the
 * same 105 trails, batching took the phase from 2,735 statements and 3,053 ms inside transactions
 * to 1,547 and 1,887 — and left wall clock at 34.8 s against 36.6 s, inside the run-to-run
 * spread. What it buys is the failure mode, not the budget.
 */
export const COMMIT_RESERVE_MS = 150_000;

function positive(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** The handler's own wall clock, from `INGEST_DEADLINE_MS`. */
export function handlerDeadlineMs(source: NodeJS.ProcessEnv = process.env): number {
  return positive(source.INGEST_DEADLINE_MS, HANDLER_DEADLINE_MS);
}

/**
 * The last moment this invocation will *start* an Overpass query that precedes the commit loop.
 *
 * Derived rather than configured, because the three numbers have to add up and a deployment that
 * sets them independently is one `az functionapp config appsettings set` away from the budget
 * arithmetic above being false again. `INGEST_OVERPASS_DEADLINE_MS` may still lower it — an
 * operator tightening the clamp is always safe — but never raise it past the reserve.
 *
 * Only the pre-commit queries. `discoverParentRoutes` runs after the tile is `ready` and after the
 * commit loop has finished, so refusing it reserves nothing for anybody; it gets the handler
 * deadline instead, through `PipelineDeps.overpassAfterCommits`.
 */
export function overpassDeadlineMs(source: NodeJS.ProcessEnv = process.env): number {
  const reserve = positive(source.INGEST_COMMIT_RESERVE_MS, COMMIT_RESERVE_MS);
  const maxTotal = positive(source.OVERPASS_MAX_TOTAL_MS, OVERPASS_MAX_TOTAL_MS);
  const derived = handlerDeadlineMs(source) - maxTotal - reserve;
  const configured = Number(source.INGEST_OVERPASS_DEADLINE_MS);
  const bound =
    Number.isFinite(configured) && configured > 0 ? Math.min(configured, derived) : derived;
  // Never zero or negative: `withDeadline` rejects on `now >= at`, so a misconfigured trio must
  // still allow the tile query that the whole invocation exists to make.
  return Math.max(1_000, bound);
}

/**
 * What this invocation may tell the broker about the message it was handed.
 *
 * The rule the two systems agree on: **no message is completed without its work having been done
 * or durably re-scheduled.** `settled` and `rescheduled` are the two ways that is true.
 */
export type Disposition = 'settled' | 'rescheduled' | 'stranded';

/** The `ingest_jobs` columns a disposition is read from. */
export interface JobLease {
  status: JobStatus;
  lockedAt: Date | null;
}

/**
 * What the broker should be told, from the job row as it stands after the drain.
 *
 * - **settled** — no row, `done` or `dead`. The work happened or has been given up on deliberately.
 * - **rescheduled** — `queued`, or `running` under a lease that has not expired.
 * - **stranded** — `running` under a lease the reaper should already have taken back, or one it can
 *   never date. Nothing is going to do the work, so completing the message here would drop it.
 *
 * **What makes `rescheduled` true is the reaper, not the lease.** A redelivery usually arrives
 * while the lease still looks live — the gap starts at `lockDuration`, below `functionTimeout`, and
 * five of 2026-08-08's six redeliveries came back inside it — so "a live lease belongs to an
 * invocation still working" is not something this can infer from the row. What it can rely on is
 * `reclaimExpiredJobs`: off its own timer, whatever any delivery decided, it returns the row to
 * `queued` at `RECLAIM_PRIORITY`, above every band `enqueue` assigns, and `runPump` sweeps before
 * it selects. So the row the reaper takes back clears the ordinary backlog instead of rejoining
 * the tail of its own priority band, where it would be reached only when five figures of due work
 * drained — a bound no delivery could complete a message on. It does not clear the reclaimed band:
 * that band is published at the same `PUMP_QUEUE_DEPTH - PUMP_DERIVED_SHARE` rows a tick as any
 * other, so recovery costs one tick while the band fits in a tick's window and the band's own
 * drain when it does not. `apps/ingest-worker/test/pump.test.ts` asserts both.
 *
 * **Abandoning instead is rejected, and it is the alternative worth naming.** Completing is
 * irreversible, so throwing looks like the conservative choice; it is not. The common reason a
 * lease is live is that its holder is alive and working. Abandoning returns the message at once,
 * the next delivery finds the same live lease and abandons again, and `maxDeliveryCount: 5`
 * dead-letters it within seconds — while the holder goes on to finish the tile normally. It also
 * costs `switchback-ingest-deadletter` its one meaning, *the worker could not reach Postgres five
 * times*, and still leaves the row to the reaper. It buys nothing it does not first spend.
 *
 * That makes `stranded` the state where *the reaper itself* has not done its job: a lease past
 * `LEASE_TIMEOUT_MS` that is still `running` means the sweep in `drainJobs` and `drainSlotGate`
 * both failed — each catches and carries on — or a `lockedAt` of NULL, which `lockedAt < cutoff`
 * never matches however long it sits. Both mean the durable rescheduler is not running, which is
 * exactly when the message must not be completed.
 */
export function classifyDisposition(
  job: JobLease | null,
  now: number,
  leaseTimeoutMs = LEASE_TIMEOUT_MS,
): Disposition {
  if (!job) return 'settled';
  if (job.status === JobStatus.done || job.status === JobStatus.dead) return 'settled';
  if (job.status !== JobStatus.running) return 'rescheduled';
  if (job.lockedAt === null) return 'stranded';
  return now - job.lockedAt.getTime() < leaseTimeoutMs ? 'rescheduled' : 'stranded';
}

/** Thrown so the host abandons the message instead of completing work that did not happen. */
export class StrandedSignalError extends Error {
  constructor(dedupeKey: string) {
    super(`ingest ${dedupeKey}: work neither done nor re-scheduled — abandoning for redelivery`);
    this.name = 'StrandedSignalError';
  }
}

/**
 * The literal `switchback-ingest-signal-stranded` greps for.
 *
 * Written on the delivery that finds a `running` row the reaper should already have freed — a lease
 * past `LEASE_TIMEOUT_MS`, or a `lockedAt` of NULL that no cutoff can match. It is not the
 * killed-handler signal; `LEASE_EXPIRED_MARKER` in `packages/ingest/src/jobs.ts` is, and the two
 * are separate arms of `switchback-ingest-drain-failed` because they are separate faults: one says
 * a handler died, this one says the process that repairs that has stopped.
 */
export const SIGNAL_STRANDED_MARKER = 'switchback-ingest-signal-stranded';

/**
 * Claim and run the one job a message names.
 *
 * `limit: 1` because the message named one unit of work and a second job claimed alongside it has
 * no message backing it — the pump would republish it anyway, and this invocation's budget is
 * sized for one tile. `derivedLimit: 0` because the pump reserves the derived share already.
 *
 * **The default `drainSlotGate` applies here, and that is the Overpass bound.** It used to be
 * disabled on the argument that `functionAppScaleLimit=1` and `FUNCTIONS_WORKER_PROCESS_COUNT=1`
 * make this process the whole fleet, so the one `OverpassClient` singleton's
 * `OVERPASS_MAX_CONCURRENT: 2` was already the ceiling. That argument holds only while exactly one
 * host is running: across a recycle two overlap, each with its own singleton, and several
 * invocations each honouring "two concurrent" locally is not two concurrent. The gate is a
 * `pg_advisory_xact_lock` in the database every claim passes through, so the bound holds across
 * processes however many the platform starts.
 *
 * **What the gate is not is a diagnosis of the strain that was measured.** Overpass answered 25×
 * 504 and 5× 429 across all three mirrors between 16:33 and 18:25 UTC on 2026-08-08, and that
 * window does not establish overlapping invocations as the cause: a comparable 429 rate is present
 * in windows with no worker load at all, and 504s are the mirrors being slow rather than us being
 * over an allowance. The gate is here because an unbounded fleet *could* exceed the per-IP
 * allowance and the consequence is an IP block, not because it has been shown to have done so.
 * `switchback-ingest-overpass-limited` is what would establish it: it reads 429s on the request
 * path, where an absorbed rate limit is visible and a job row never records one.
 *
 * A refused claim is not a failure — it is this invocation declining to be the second drainer —
 * and the disposition below is what keeps that from costing the message.
 */
export async function runIngestSignal(
  signal: IngestSignal,
  log: WorkerLog,
  options: {
    workerId: string;
    deliveryCount?: number;
    drain?: Drain;
    overpass?: OverpassQuerier;
    db?: PrismaClient;
  },
): Promise<DrainResult> {
  const drain = options.drain ?? drainIngest;
  const db = options.db ?? backgroundPrisma;
  const startedAt = Date.now();
  const handlerDeadline = startedAt + handlerDeadlineMs();
  // Views of the shared client, not second ones: the queue and the breaker stay the singleton's,
  // so the concurrency ceiling is unchanged.
  const overpass =
    options.overpass ?? withDeadline(getOverpass(), startedAt + overpassDeadlineMs());
  const overpassAfterCommits = options.overpass ?? withDeadline(getOverpass(), handlerDeadline);

  let result: DrainResult;
  try {
    result = await drain({
      limit: 1,
      derivedLimit: 0,
      dedupeKeys: [signal.dedupeKey],
      workerId: options.workerId,
      deps: {
        overpass,
        overpassAfterCommits,
        deadlineAt: handlerDeadline,
        logger: pipelineLogger(log),
      },
    });
  } catch (error) {
    /*
     * The only way out of `drainJobs` is a claim that could not be made at all — every handler
     * error is caught per job and written to the row, and both bookkeeping claims have their
     * own catch. So this is the database being unreachable, and it is the one case worth a
     * redelivery: rethrowing abandons the lock, the host redelivers, and `maxDeliveryCount`
     * failures put the message in the dead-letter queue. That is what a DLQ entry means here.
     */
    log.error(`ingest ${signal.dedupeKey}: could not claim, abandoning for redelivery`, error);
    throw error;
  }

  report(signal, result, log);
  await assertSettleable(db, signal, result, log, options.deliveryCount ?? 1);
  return result;
}

/**
 * Refuse to let the host complete a message whose work is in neither of the two states that mean
 * something will finish it.
 *
 * Only consulted when this invocation claimed nothing: a drain that ran the job has already
 * written its outcome under its own lease, and re-reading the row would only reintroduce a race.
 *
 * Throwing is the whole mechanism. `host.json` sets `autoCompleteMessages: true` and the Node
 * worker exposes no settlement API, so a handler's only vocabulary is "return" — complete — and
 * "throw" — abandon. `maxDeliveryCount` is 5, after which the message dead-letters, and a
 * dead-letter entry for a stranded tile is the honest outcome: the row is still on `ingest_jobs`
 * for the pump to find once the lease is reclaimed, and somebody has been told.
 */
async function assertSettleable(
  db: PrismaClient,
  signal: IngestSignal,
  result: DrainResult,
  log: WorkerLog,
  deliveryCount: number,
): Promise<void> {
  if (result.claimed > 0) return;

  const job = await db.ingestJob.findUnique({
    where: { dedupeKey: signal.dedupeKey },
    select: { status: true, lockedAt: true, lockedBy: true },
  });
  const disposition = classifyDisposition(job, Date.now());
  if (disposition !== 'stranded') return;

  log.error(
    `${SIGNAL_STRANDED_MARKER} ${signal.dedupeKey}: delivery ${deliveryCount} found the job ` +
      `${job?.status ?? 'missing'} under a lease held by ${job?.lockedBy ?? 'nobody'} that has expired`,
  );
  throw new StrandedSignalError(signal.dedupeKey);
}

/**
 * The literal `switchback-ingest-drain-failed` greps for.
 *
 * A job failure is invisible at the invocation level: `drainJobs` catches every handler error,
 * writes it to the row and returns normally, so the request row is `success == true`. On
 * 2026-08-04 that read as 14/14 successful invocations while six Alps tiles failed. An
 * alert therefore has to read `traces`, and a KQL query matching on prose is one reworded
 * sentence away from silence — so the sentence carries a token instead, asserted against
 * `infra/azure/ingest.bicep` in `test/drain.test.ts`.
 */
export const JOB_FAILED_MARKER = 'ingest-job-failed';

/**
 * The literal `switchback-ingest-drain-failed` greps for when a handler committed under a lease
 * that had already been taken back — the work ran twice.
 *
 * This is the condition `writeOutcome`'s lease fence exists to detect, and the fence's own count
 * (`DrainResult.lost`) is written nowhere but this line: the row belongs to whoever reclaimed it,
 * so nothing on `ingest_jobs` records that a second process also finished it.
 */
export const DOUBLE_COMMIT_MARKER = 'switchback-ingest-double-commit';

/**
 * Give the pipeline somewhere to log. Until this existed `PipelineDeps.logger` was set on no
 * deployed path — only `scripts/ingest.ts` — so every line subdivision emits went to
 * `deps.logger ?? (() => {})` and a split was indistinguishable from an ordinary `done`.
 *
 * Warning rather than information because the events that reach it are all deferrals or
 * blockages, and `host.json` excludes `Trace` from sampling so none of them can be dropped.
 */
function pipelineLogger(
  log: WorkerLog,
): (message: string, detail?: Record<string, unknown>) => void {
  return (message, detail) =>
    detail === undefined ? log.warn(message) : log.warn(message, JSON.stringify(detail));
}

/**
 * Say what happened. Every count that is not a plain success gets a line, because the worker's
 * own logs are the only place some of them appear — `failed` writes `lastError` to the row and
 * `lost` writes nothing anywhere.
 */
function report(signal: IngestSignal, result: DrainResult, log: WorkerLog): void {
  const key = signal.dedupeKey;

  if (result.claimed === 0) {
    // Not an error and not a retry: the tile is already ready, another worker holds it, or a
    // failure pushed `runAfter` into the future. `assertSettleable` decides whether that is a
    // state the message may be completed on.
    log.info(`ingest ${key}: nothing claimable — done, running elsewhere, or not yet due`);
  } else if (result.succeeded > 0) {
    log.info(`ingest ${key}: done`);
  }

  if (result.failed > 0) {
    log.error(
      `${JOB_FAILED_MARKER} ${key}: handler failed — see "lastError" on the job row; retry scheduled`,
    );
  }

  if (result.deferred > 0) {
    log.warn(`ingest ${key}: no handler for this kind in this build — handed back untried`);
  }

  if (result.lost > 0) {
    log.error(
      `${DOUBLE_COMMIT_MARKER} ${key}: finished after its lease expired — the work ran twice`,
    );
  }

  if (result.requeued > 0 || result.retired > 0) {
    log.warn(
      `ingest sweep: reclaimed ${result.requeued} expired lease(s), retired ${result.retired}`,
    );
  }
}
