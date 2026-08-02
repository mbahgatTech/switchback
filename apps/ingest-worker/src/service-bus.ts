/**
 * The Service Bus side of the pump: an identity-based connection to the same namespace and
 * queue the trigger binds to, so there is one place to configure either.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusAdministrationClient, ServiceBusClient } from '@azure/service-bus';
import type { ServiceBusMessage, ServiceBusSender } from '@azure/service-bus';
import type { SignalQueue } from './pump';

/**
 * The app-setting prefix the queue trigger's `connection` names. The host reads
 * `<prefix>__fullyQualifiedNamespace` for an identity-based connection; this module reads the
 * same setting so a namespace move cannot leave the two halves pointing at different brokers.
 */
export const SERVICE_BUS_CONNECTION = 'ServiceBusConnection';

export const QUEUE_NAME = process.env.SERVICE_BUS_QUEUE ?? 'ingest-jobs';

function namespace(): string {
  const value = process.env[`${SERVICE_BUS_CONNECTION}__fullyQualifiedNamespace`];
  if (!value) {
    throw new Error(`${SERVICE_BUS_CONNECTION}__fullyQualifiedNamespace is not set`);
  }
  return value;
}

let sender: ServiceBusSender | null = null;
let admin: ServiceBusAdministrationClient | null = null;

/**
 * Cached across invocations, because the host reuses the process and an AMQP link costs a
 * round trip to open. Lazy for the reason `getOverpass` is: constructing at import time turns
 * a missing setting into a host that will not start.
 */
function getSender(): ServiceBusSender {
  sender ??= new ServiceBusClient(namespace(), new DefaultAzureCredential()).createSender(
    QUEUE_NAME,
  );
  return sender;
}

function getAdmin(): ServiceBusAdministrationClient {
  admin ??= new ServiceBusAdministrationClient(namespace(), new DefaultAzureCredential());
  return admin;
}

/**
 * `messageId` is the `dedupeKey`, which is what makes the queue's duplicate detection collapse
 * the pump's re-publishes at the broker: a row stays `queued` until a worker claims it, so
 * every tick before that would otherwise name it again. It is an optimisation, not the fence —
 * a duplicate that slips past the detection window costs one claim returning no rows.
 */
function toMessage(dedupeKey: string): ServiceBusMessage {
  return {
    body: { dedupeKey },
    messageId: dedupeKey,
    contentType: 'application/json',
    // The job kind, off the front of the key, so the broker's own metrics can tell tile work
    // from enrichment without opening a body or querying Postgres.
    applicationProperties: { kind: dedupeKey.split(':')[0] ?? 'unknown' },
  };
}

export function serviceBusQueue(): SignalQueue {
  return {
    async activeCount(): Promise<number> {
      const properties = await getAdmin().getQueueRuntimeProperties(QUEUE_NAME);
      return properties.activeMessageCount;
    },
    async publish(dedupeKeys: readonly string[]): Promise<void> {
      await getSender().sendMessages(dedupeKeys.map(toMessage));
    },
  };
}
