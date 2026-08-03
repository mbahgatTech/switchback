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
 * kills the process, which strands the `ingest_jobs` lease and redelivers the message. So the
 * numbers have to be reconciled rather than merely both written down:
 *
 *     300 s  this deadline — the last moment a query may start
 *   + 240 s  OVERPASS_MAX_TOTAL_MS, the most that one query may then spend
 *   = 540 s  worst case in Overpass, inside the host's 600 s, leaving 60 s to finish the write
 *
 * The addition is only sound because nothing sits between the two: `host.json` takes one message
 * at a time, so a query never waits for a concurrency slot it is not being charged for, and
 * `OverpassClient` clamps each attempt into what is left of the budget — including the body read,
 * which it did not always. `test/drain.test.ts` asserts all three numbers against `host.json` and
 * `infra/azure/ingest.bicep` rather than against themselves.
 *
 * Observed before this existed: `ingest_tile:120221221` ran 600008 ms and was killed mid-tile.
 */
export const OVERPASS_DEADLINE_MS = 300_000;

function deadlineMs(source: NodeJS.ProcessEnv = process.env): number {
  const value = Number(source.INGEST_OVERPASS_DEADLINE_MS);
  return Number.isFinite(value) && value > 0 ? value : OVERPASS_DEADLINE_MS;
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
  // A view of the shared client, not a second one: the queue and the breaker stay the
  // singleton's, so the concurrency ceiling is unchanged.
  const overpass = options.overpass ?? withDeadline(getOverpass(), Date.now() + deadlineMs());

  let result: DrainResult;
  try {
    result = await drain({
      limit: 1,
      derivedLimit: 0,
      dedupeKeys: [signal.dedupeKey],
      workerId: options.workerId,
      deps: { overpass },
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
    log.error(`ingest ${key}: handler failed — see "lastError" on the job row; retry scheduled`);
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
