import { app } from '@azure/functions';
import type { InvocationContext } from '@azure/functions';
import { runIngestSignal } from '../drain';
import { parseIngestSignal } from '../message';
import { QUEUE_NAME, SERVICE_BUS_CONNECTION } from '../service-bus';

/**
 * One message, one job. Concurrency is `host.json`'s `maxConcurrentCalls: 1` against a scale
 * limit of one instance — see README.md, which traces that to the two Overpass requests the
 * shared `OverpassClient` allows.
 */
app.serviceBusQueue('ingestDrain', {
  connection: SERVICE_BUS_CONNECTION,
  queueName: QUEUE_NAME,
  handler: async (message: unknown, context: InvocationContext): Promise<void> => {
    const signal = parseIngestSignal(message);
    await runIngestSignal(signal, context, { workerId: `sb-${context.invocationId}` });
  },
});
