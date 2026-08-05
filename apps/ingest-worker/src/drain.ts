/**
 * One message, one job. The work itself is `@switchback/ingest` — this decides only what a
 * result means to the broker, which is where the two systems have to agree.
 */

import { drainIngest, getOverpass, withDeadline } from '@switchback/ingest';
import type { DrainResult, OverpassQuerier } from '@switchback/ingest';
import type { WorkerLog } from './log';
import type { IngestSignal } from './message';

/** The seam tests replace. Production always passes `drainIngest`. */
export type Drain = typeof drainIngest;

/**
 * How long into an invocation this worker will still *start* an Overpass request.
 *
 * `host.json` sets `functionTimeout` to ten minutes and Consumption will not raise it — the host
 * kills the process, which strands the `ingest_jobs` lease and redelivers the message. Against
 * that, two numbers bound the Overpass portion of a handler:
 *
 *     300 s  this deadline — the last moment a query may start
 *   + 240 s  OVERPASS_MAX_TOTAL_MS, the most that one query may then spend
 *   = 540 s  worst case in Overpass, inside the host's 600 s
 *
 * The addition is sound because nothing sits between the two: `host.json` takes one message at a
 * time, so a query never waits for a concurrency slot it is not charged for, and `OverpassClient`
 * clamps each attempt into what is left of the budget — including the body read, which it did not
 * always. `test/drain.test.ts` asserts all three numbers against `host.json` and `ingest.bicep`.
 *
 * **Overpass is not the only wall clock in the handler, so this alone never bounded the
 * invocation.** Measured on 2026-08-03 with the flag on: 021212220 at 205 s, 031313102 at 415 s,
 * 031313120 at 491 s — then 120221230 and 120221203, both dense alpine tiles, killed at
 * 612,947 ms and 615,938 ms with Overpass inside its budget throughout. Elevation was unbounded
 * (`TerrainSource` had no per-request timeout and no budget) and so were the per-trail commits.
 * The same window has `[HostMonitor] Host CPU threshold exceeded (99 >= 80)` repeating from 22:24
 * to 23:04 with `ingestPump` ticks of 19,901 ms and 57,939 ms in the same process, so contention
 * on one saturated Consumption instance is a second, independent term — and one the
 * `maxConcurrentCalls: 1` argument above does not cover, because the timer trigger is not a
 * queue message and runs alongside the drain regardless.
 *
 * `INGEST_DEADLINE_MS` is the answer to both: a single wall clock handed to every phase through
 * `PipelineDeps.deadlineAt`, so terrain and commits refuse to start past it just as Overpass
 * does. Overpass keeps its own earlier deadline because it may then spend 240 s more.
 */
export const OVERPASS_DEADLINE_MS = 300_000;

/**
 * The whole handler's wall clock, measured from the moment the message arrives.
 *
 * 540 s leaves 60 s of the host's 600 s for the phase that was already running when the clock
 * ran out — one terrain fetch (20 s cap), one trail's transaction — plus the job bookkeeping.
 * It is deliberately the same number as the Overpass worst case: past 540 s no phase may
 * *begin*, whichever phase it is.
 */
export const HANDLER_DEADLINE_MS = 540_000;

function deadlineMs(source: NodeJS.ProcessEnv = process.env): number {
  const value = Number(source.INGEST_OVERPASS_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : OVERPASS_DEADLINE_MS;
}

function handlerDeadlineMs(source: NodeJS.ProcessEnv = process.env): number {
  const value = Number(source.INGEST_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : HANDLER_DEADLINE_MS;
}

/**
 * Claim and run the one job a message names.
 *
 * `limit: 1` because the message named one unit of work and a second job claimed alongside it
 * has no message backing it — the pump would republish it anyway, and this invocation's
 * 10-minute budget is sized for one tile.
 *
 * `derivedLimit: 0` deviates from `DEFAULT_DERIVED_SHARE` on purpose: the pump reserves the
 * derived share now, so claiming two more here would spend the budget twice over and put work
 * in flight that the concurrency reasoning below does not account for.
 */
export async function runIngestSignal(
  signal: IngestSignal,
  log: WorkerLog,
  options: { workerId: string; drain?: Drain; overpass?: OverpassQuerier },
): Promise<DrainResult> {
  const drain = options.drain ?? drainIngest;
  const startedAt = Date.now();
  // A view of the shared client, not a second one: the queue and the breaker stay the
  // singleton's, so the concurrency ceiling is unchanged.
  const overpass = options.overpass ?? withDeadline(getOverpass(), startedAt + deadlineMs());

  let result: DrainResult;
  try {
    result = await drain({
      limit: 1,
      derivedLimit: 0,
      dedupeKeys: [signal.dedupeKey],
      workerId: options.workerId,
      deps: { overpass, deadlineAt: startedAt + handlerDeadlineMs() },
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
  return result;
}

/**
 * The literal `switchback-ingest-drain-failed` greps for.
 *
 * A job failure is invisible at the invocation level: `drainJobs` catches every handler error,
 * writes it to the row and returns normally, so the request row is `success == true`. On
 * 2026-08-04 that read as 14/14 successful invocations while six Alps tiles were failing. An
 * alert therefore has to read `traces`, and a KQL query matching on prose is one reworded
 * sentence away from silence — so the sentence carries a token instead, asserted against
 * `infra/azure/ingest.bicep` in `test/drain.test.ts`.
 */
export const JOB_FAILED_MARKER = 'ingest-job-failed';

/**
 * Say what happened. Every count that is not a plain success gets a line, because the worker's
 * own logs are the only place some of them appear — `failed` writes `lastError` to the row and
 * `lost` writes nothing anywhere.
 */
function report(signal: IngestSignal, result: DrainResult, log: WorkerLog): void {
  const key = signal.dedupeKey;

  if (result.claimed === 0) {
    // Not an error and not a retry: the tile is already ready, another worker holds it, or a
    // failure pushed `runAfter` into the future. The pump will re-signal it when it is due.
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
    log.warn(`ingest ${key}: finished after its lease expired — the work ran twice`);
  }

  if (result.requeued > 0 || result.retired > 0) {
    log.warn(
      `ingest sweep: reclaimed ${result.requeued} expired lease(s), retired ${result.retired}`,
    );
  }
}
