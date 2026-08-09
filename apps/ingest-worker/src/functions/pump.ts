import { app } from '@azure/functions';
import type { InvocationContext, Timer } from '@azure/functions';
import { backgroundPrisma } from '@switchback/db';
import { TILE_WEDGED_MARKER, pruneFinishedJobs, sweepQueue } from '@switchback/ingest';
import { reportQueueHealth } from '../health';
import { runPump } from '../pump';
import { serviceBusQueue } from '../service-bus';

/**
 * The brake. `INGEST_PUMP_ENABLED=false` stops new work reaching the queue in seconds with no
 * deploy anywhere; in-flight messages finish, because each is idempotent and dropping one
 * mid-tile would leave a lease to expire for nothing.
 */
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
    await maintain(context);

    if (braked()) {
      context.warn('ingest pump: disabled by INGEST_PUMP_ENABLED');
      return;
    }
    await runPump(backgroundPrisma, serviceBusQueue(), context);
  },
});

/**
 * Reclaim expired leases, clear orphaned split markers, collect finished jobs.
 *
 * Ahead of the brake deliberately: `INGEST_PUMP_ENABLED=false` stops *new* work reaching the
 * queue, and a stopped pump that also stopped reclaiming would leave every lease a killed
 * invocation held stuck for as long as the brake was on.
 */
async function maintain(log: InvocationContext): Promise<void> {
  try {
    const sweep = await sweepQueue(backgroundPrisma);
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
    await pruneFinishedJobs(backgroundPrisma);
  } catch (error) {
    // Maintenance must not be able to stop the pump it is hung off.
    log.error('ingest sweep: failed', error);
  }
}
