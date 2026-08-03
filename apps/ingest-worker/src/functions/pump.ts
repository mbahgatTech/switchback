import { app } from '@azure/functions';
import type { InvocationContext, Timer } from '@azure/functions';
import { backgroundPrisma } from '@switchback/db';
import { ingestQueueDriver } from '@switchback/ingest';
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
 * `INGEST_QUEUE_DRIVER` is read here and not only on Vercel, which is what makes the flag a
 * rollback rather than a fan-out: set it to `postgres` on both sides and the Vercel cron drains
 * again while this stops publishing, instead of the two running at once.
 */
app.timer('ingestPump', {
  schedule: '0 */2 * * * *',
  handler: async (_timer: Timer, context: InvocationContext): Promise<void> => {
    if (ingestQueueDriver() !== 'servicebus') {
      context.warn('ingest pump: INGEST_QUEUE_DRIVER is not servicebus — Postgres owns the drain');
      return;
    }
    if (braked()) {
      context.warn('ingest pump: disabled by INGEST_PUMP_ENABLED');
      return;
    }
    await runPump(backgroundPrisma, serviceBusQueue(), context);
  },
});
