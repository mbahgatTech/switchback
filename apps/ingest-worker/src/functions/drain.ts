import { app } from '@azure/functions';
import type { InvocationContext } from '@azure/functions';
import { ingestQueueDriver } from '@switchback/ingest';
import { runIngestSignal } from '../drain';
import { parseIngestSignal } from '../message';
import { QUEUE_NAME, SERVICE_BUS_CONNECTION } from '../service-bus';

/**
 * One message, one job. Concurrency is `host.json`'s `maxConcurrentCalls: 1` against a scale
 * limit of one instance — see README.md, which traces that to the two Overpass requests the
 * shared `OverpassClient` allows.
 *
 * On `INGEST_QUEUE_DRIVER=postgres` the message is read and dropped rather than worked or
 * abandoned. Dropped, because after a rollback Vercel is draining `ingest_jobs` again and a
 * second drainer here is the fan-out the flag exists to prevent; completed rather than thrown,
 * because five redeliveries into the dead-letter queue would spend the one signal that queue is
 * meant to carry. The row is untouched, so Postgres still runs the work.
 */
app.serviceBusQueue('ingestDrain', {
  connection: SERVICE_BUS_CONNECTION,
  queueName: QUEUE_NAME,
  handler: async (message: unknown, context: InvocationContext): Promise<void> => {
    const signal = parseIngestSignal(message);
    if (ingestQueueDriver() !== 'servicebus') {
      context.warn(
        `ingest ${signal.dedupeKey}: INGEST_QUEUE_DRIVER is not servicebus — dropping the signal`,
      );
      return;
    }
    await runIngestSignal(signal, context, { workerId: `sb-${context.invocationId}` });
  },
});
