import { app } from '@azure/functions';
import type { InvocationContext } from '@azure/functions';
import { runIngestSignal } from '../drain';
import { parseIngestSignal } from '../message';
import { QUEUE_NAME, SERVICE_BUS_CONNECTION } from '../service-bus';

/**
 * One message, one job. This trigger is the only thing in the estate that ingests a tile.
 *
 * Concurrency is `host.json`'s `maxConcurrentCalls: 1` against a scale limit of one instance, and
 * `drainSlotGate` behind both — see `runIngestSignal`, which explains why the platform bound alone
 * was not enough. `deliveryCount` is on the context because a redelivery is evidence about the
 * previous one, and `runIngestSignal` uses it.
 */
app.serviceBusQueue('ingestDrain', {
  connection: SERVICE_BUS_CONNECTION,
  queueName: QUEUE_NAME,
  handler: async (message: unknown, context: InvocationContext): Promise<void> => {
    const signal = parseIngestSignal(message);
    await runIngestSignal(signal, context, {
      workerId: `sb-${context.invocationId}`,
      deliveryCount: deliveryCount(context),
    });
  },
});

/**
 * How many times the broker has handed this message out, or 1 when the host did not say.
 *
 * The Node worker surfaces broker metadata as loosely typed `triggerMetadata`, so this reads it
 * defensively: a missing count must read as a first delivery, because the alternative — treating
 * an unknown delivery as a retry — would let a first attempt take over a lease that a live
 * invocation is holding.
 */
function deliveryCount(context: InvocationContext): number {
  const raw = (context.triggerMetadata as { deliveryCount?: unknown } | undefined)?.deliveryCount;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : 1;
}
