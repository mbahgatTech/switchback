/**
 * The Service Bus side of the pump: an identity-based connection to the same namespace and
 * queue the trigger binds to, so there is one place to configure either.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import type { ServiceBusMessage, ServiceBusSender } from '@azure/service-bus';
import type { SignalQueue } from './pump';

/**
 * The app-setting prefix the queue trigger's `connection` names. The host reads
 * `<prefix>__fullyQualifiedNamespace` for an identity-based connection; this module reads the
 * same setting so a namespace move cannot leave the two halves pointing at different brokers.
 */
export const SERVICE_BUS_CONNECTION = 'ServiceBusConnection';

export const QUEUE_NAME = process.env.SERVICE_BUS_QUEUE ?? 'ingest-jobs';

const ARM_SCOPE = 'https://management.azure.com/.default';

/** Matches the `Microsoft.ServiceBus/namespaces/queues` version `ingest.bicep` deploys. */
const QUEUE_API_VERSION = '2024-01-01';

function namespace(): string {
  const value = process.env[`${SERVICE_BUS_CONNECTION}__fullyQualifiedNamespace`];
  if (!value) {
    throw new Error(`${SERVICE_BUS_CONNECTION}__fullyQualifiedNamespace is not set`);
  }
  return value;
}

function queueResourceId(): string {
  const value = process.env.SERVICE_BUS_QUEUE_RESOURCE_ID;
  if (!value) throw new Error('SERVICE_BUS_QUEUE_RESOURCE_ID is not set');
  return value;
}

let credential: DefaultAzureCredential | null = null;
let sender: ServiceBusSender | null = null;

/** Caches its tokens internally, which is most of why it is a singleton rather than per call. */
function getCredential(): DefaultAzureCredential {
  credential ??= new DefaultAzureCredential();
  return credential;
}

/**
 * Cached across invocations, because the host reuses the process and an AMQP link costs a
 * round trip to open. Lazy for the reason `getOverpass` is: constructing at import time turns
 * a missing setting into a host that will not start.
 */
function getSender(): ServiceBusSender {
  sender ??= new ServiceBusClient(namespace(), getCredential()).createSender(QUEUE_NAME);
  return sender;
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

/**
 * Queue depth from ARM rather than from `ServiceBusAdministrationClient`.
 *
 * Load-bearing for least privilege, not a style choice: the administration client talks the
 * data-plane management protocol, which only **Azure Service Bus Data Owner** carries — and at
 * queue scope that role is a wildcard over `Microsoft.ServiceBus`, so it would also let this
 * worker rewrite or delete the queue it is draining. The narrower `queues/read` control-plane
 * action is already in **Data Sender** and **Data Receiver**, and `countDetails` on the ARM
 * representation of the queue answers the same question, so those two roles are the whole grant.
 */
async function activeMessageCount(): Promise<number> {
  const token = await getCredential().getToken(ARM_SCOPE);
  if (!token) throw new Error('no ARM token for the worker identity');

  const response = await fetch(
    `https://management.azure.com${queueResourceId()}?api-version=${QUEUE_API_VERSION}`,
    { headers: { Authorization: `Bearer ${token.token}` } },
  );
  if (!response.ok) {
    throw new Error(`ARM refused the queue read: ${response.status}`);
  }

  const body = (await response.json()) as {
    properties?: { countDetails?: { activeMessageCount?: number } };
  };
  const count = body.properties?.countDetails?.activeMessageCount;
  if (typeof count !== 'number') throw new Error('ARM returned no activeMessageCount');
  return count;
}

export function serviceBusQueue(): SignalQueue {
  return {
    activeCount: activeMessageCount,
    async publish(dedupeKeys: readonly string[]): Promise<void> {
      await getSender().sendMessages(dedupeKeys.map(toMessage));
    },
  };
}
