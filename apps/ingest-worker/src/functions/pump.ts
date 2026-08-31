import { app } from '@azure/functions';
import type { InvocationContext, Timer } from '@azure/functions';
import { backgroundPrisma } from '@switchback/db';
import {
  JOB_ABANDONED_MARKER,
  JOB_REVIVED_MARKER,
  RECLAIM_PRIORITY,
  TILE_WEDGED_MARKER,
  describeRevived,
  pruneFinishedJobs,
  sweepQueue,
} from '@switchback/ingest';
import { reconcileDeadLetters } from '../dead-letter';
import { reportEmptyWriteRates, reportQueueHealth } from '../health';
import { pumpBounds, runPump } from '../pump';
import { deadLetterQueue, serviceBusQueue } from '../service-bus';

/** `INGEST_PUMP_ENABLED=false` — see `refill` for what the brake does and does not stop. */
function braked(): boolean {
  return process.env.INGEST_PUMP_ENABLED === 'false';
}

/**
 * Every two minutes, not once over the backlog: Service Bus is FIFO and `ingest_jobs` holds
 * the priority, so re-deriving the top of the queue is what keeps a tile someone is looking at
 * ahead of five figures of scheduled work. Makes no Overpass request of its own.
 *
 * It is also the estate's only queue-maintenance schedule. Lease reclaim, split-marker repair and
 * finished-job collection ran on Vercel until the ingestion path there was removed; they belong
 * beside the drainer, and a two-minute tick is a schedule where a once-a-day cron was not.
 */
app.timer('ingestPump', {
  schedule: '0 */2 * * * *',
  handler: async (_timer: Timer, context: InvocationContext): Promise<void> => {
    await reportQueueHealth(backgroundPrisma, context);
    await reportEmptyWriteRates(backgroundPrisma, context);
    await maintain(context);

    if (braked()) {
      context.warn('ingest pump: disabled by INGEST_PUMP_ENABLED — reclaimed leases only');
      await refill(context, RECLAIM_PRIORITY);
    } else {
      await refill(context);
    }
    await drainDeadLetters(context);
  },
});

/**
 * Publish the runnable head, optionally narrowed to one priority band.
 *
 * **The brake narrows this rather than skipping it, and that is what keeps the drain's settlement
 * honest.** `classifyDisposition` completes a Service Bus message — irreversibly — on the strength
 * of the reaper returning the row to `queued` at `RECLAIM_PRIORITY` and the pump republishing it.
 * A brake that stopped publishing outright would leave the first half of that true and the second
 * half false: the row would persist, so nothing is lost, but nothing would carry it back to the
 * broker until an operator lifted the brake, and how long that takes is not a bound.
 *
 * Reclaimed work is not new work, which is what the brake is for. The bleed is bounded twice over:
 * `reclaimExpiredJobs` is the only writer of this band and spends an attempt every time it writes,
 * so a tile that reliably kills its handler is retired rather than republished forever; and
 * `enqueue` resets `priority` when it revives a finished row, so a request for a tile that was
 * once reclaimed re-enters at its own band and the brake still holds it. A brake that must stop
 * the ingestion of a tile outright is `AzureWebJobs.ingestDrain.Disabled`, and the one that must
 * stop everything is stopping the host.
 */
async function refill(log: InvocationContext, minPriority?: number): Promise<void> {
  await runPump(backgroundPrisma, serviceBusQueue(), log, new Date(), pumpBounds(), minPriority);
}

/**
 * Reclaim expired leases, clear orphaned split markers, decide what happens to buried jobs,
 * collect finished jobs.
 *
 * Ahead of the brake deliberately: `INGEST_PUMP_ENABLED=false` stops *new* work reaching the
 * queue, and a stopped pump that also stopped reclaiming would leave every lease a killed
 * invocation held stuck for as long as the brake was on.
 *
 * Ahead of `refill` for a narrower reason: `classifyDisposition` completes a Service Bus message
 * on the strength of the reaper returning the row to `queued` and this tick republishing it, so
 * the reclaim has to be on the queue before the publish reads it. That coupling is what keeps
 * this work here and put `drainDeadLetters` after the publish instead — nothing in `refill`
 * reads the broker's dead-letter sub-queue, so its blocking receive had no reason to be
 * spending the publish's wall clock.
 */
async function maintain(log: InvocationContext): Promise<void> {
  try {
    /*
     * The brake reaches the triage and nothing else in this sweep. Reviving is the only part that
     * puts work back on the queue, which is what `INGEST_PUMP_ENABLED=false` means to stop; a
     * braked tick still reclaims leases, repairs splits and wedged tiles, and still retires the
     * burials it has finished with, none of which needs queue capacity. That last one is only true
     * because the triage reads retirements in a window of their own — see `reconcileDeadJobs`.
     */
    const sweep = await sweepQueue(backgroundPrisma, new Date(), { revive: !braked() });
    if (sweep.requeued > 0 || sweep.retired > 0) {
      log.warn(
        `ingest sweep: reclaimed ${sweep.requeued} expired lease(s), retired ${sweep.retired}`,
      );
    }
    if (sweep.unsplit.length > 0) {
      log.warn(
        `ingest sweep: cleared ${sweep.unsplit.length} orphaned split marker(s): ` +
          sweep.unsplit.map((repair) => repair.quadkey).join(', '),
      );
    }
    if (sweep.unwedged.length > 0) {
      log.error(
        `${TILE_WEDGED_MARKER}: ${sweep.unwedged.length} tile(s) left running with no job that ` +
          `could finish them, now failed: ${sweep.unwedged.join(', ')}`,
      );
    }
    if (sweep.revived.length > 0) {
      log.warn(`${JOB_REVIVED_MARKER}: ${describeRevived(sweep.revived)}`);
    }
    for (const job of sweep.abandoned) {
      // One line each, not one line for the batch: this is the end of every automatic path, and
      // the rule that pages on it needs the reason beside the key rather than a count.
      log.error(
        `${JOB_ABANDONED_MARKER} ${job.dedupeKey}: ${job.cause} — ${job.reason}; ` +
          'nothing automatic runs it again — fetchArea over the tile, or scripts/requeue-jobs.ts',
      );
    }
    await pruneFinishedJobs(backgroundPrisma);
  } catch (error) {
    // Maintenance must not be able to stop the pump it is hung off.
    log.error('ingest sweep: failed', error);
  }
}

/**
 * Return anything the broker gave up on to `ingest_jobs`, after the publish rather than before it.
 *
 * `DEAD_LETTER_WAIT_MS` is a blocking receive that a healthy estate spends in full confirming an
 * empty queue, and the timer is singleton — so ahead of `refill` it was five seconds of every
 * tick charged to a viewport tile waiting in Postgres. Nothing here feeds the publish: a message
 * this recovers is enqueued for a later tick either way.
 *
 * Its own catch rather than the sweep's. The two fail for unrelated reasons, and one shared catch
 * would let an unreachable namespace skip `pruneFinishedJobs`, which is the one part of this that
 * keeps a table from growing.
 */
async function drainDeadLetters(log: InvocationContext): Promise<void> {
  try {
    await reconcileDeadLetters(backgroundPrisma, deadLetterQueue(), log);
  } catch (error) {
    log.error('ingest dead-letter sweep: failed', error);
  }
}
