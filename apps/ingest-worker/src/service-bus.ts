/**
 * The Service Bus side of the pump: an identity-based connection to the same namespace and
 * queue the trigger binds to, so there is one place to configure either.
 */

import { DefaultAzureCredential } from '@azure/identity';
import { ServiceBusClient } from '@azure/service-bus';
import type {
  ServiceBusMessage,
  ServiceBusReceivedMessage,
  ServiceBusReceiver,
  ServiceBusSender,
} from '@azure/service-bus';
import type { DeadLetter, DeadLetterQueue } from './dead-letter';
import { INGEST_JOB_KINDS } from '@switchback/ingest';
import { parseIngestSignal } from './message';
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
let client: ServiceBusClient | null = null;
let sender: ServiceBusSender | null = null;
let deadLetterReceiver: ServiceBusReceiver | null = null;

/** Caches its tokens internally, which is most of why it is a singleton rather than per call. */
function getCredential(): DefaultAzureCredential {
  credential ??= new DefaultAzureCredential();
  return credential;
}

/** One connection under both links. Lazy for the reason `getCredential` is cached: see below. */
function getClient(): ServiceBusClient {
  client ??= new ServiceBusClient(namespace(), getCredential());
  return client;
}

/**
 * Cached across invocations, because the host reuses the process and an AMQP link costs a
 * round trip to open. Lazy for the reason `getOverpass` is: constructing at import time turns
 * a missing setting into a host that will not start.
 */
function getSender(): ServiceBusSender {
  sender ??= getClient().createSender(QUEUE_NAME);
  return sender;
}

/**
 * The dead-letter sub-queue, read in peek-lock so a message this process fails to evaluate comes
 * back rather than disappearing. Needs no grant beyond the **Data Receiver** the trigger already
 * holds: `$deadletterqueue` is part of the queue entity, not a second one.
 */
function getDeadLetterReceiver(): ServiceBusReceiver {
  deadLetterReceiver ??= getClient().createReceiver(QUEUE_NAME, { subQueueType: 'deadLetter' });
  return deadLetterReceiver;
}

/**
 * How long a receive waits for the dead-letter queue to answer.
 *
 * **Not zero, and the wall clock it costs is the cheaper half of that trade.** A zero wait returns
 * only what the link has already buffered, and this receiver is created lazily inside the first
 * call — so the link has issued no credit yet and a cold one can answer empty with a queue that is
 * not. A warm host recovers on the next tick; a host recycling between ticks would never drain the
 * queue at all, which is the failure this whole function exists to prevent. Five seconds a tick is
 * an hour of the pump's wall clock a day spent confirming an empty queue, and the pump makes no
 * Overpass request, so that hour costs nothing anybody is waiting on.
 */
const DEAD_LETTER_WAIT_MS = 5_000;

export function deadLetterQueue(): DeadLetterQueue {
  return {
    async receive(max: number): Promise<DeadLetter[]> {
      const receiver = getDeadLetterReceiver();
      let messages;
      try {
        messages = await receiver.receiveMessages(max, { maxWaitTimeInMs: DEAD_LETTER_WAIT_MS });
      } catch (error) {
        // A link that has faulted stays faulted, and this one is cached for the life of the
        // process — so without dropping it here a single transport error silences the drain until
        // the host recycles. The next tick opens a fresh one.
        deadLetterReceiver = null;
        throw error;
      }
      return messages.map((message) => ({
        dedupeKey: readDedupeKey(message),
        reason: message.deadLetterReason ?? null,
        complete: () => receiver.completeMessage(message),
      }));
    },
  };
}

/**
 * The job a message names, from its body or — failing that — from `messageId`.
 *
 * **`messageId` is the `dedupeKey`**: `toMessage` sets them equal so the broker's duplicate
 * detection collapses the pump's re-publishes. That makes it a second, independent copy of the
 * identity, and it survives exactly the case the body does not — a body-shape change across a
 * deploy, which would otherwise turn every message already in the queue into an unidentifiable
 * one the reconciler completes and deletes.
 *
 * The fallback is checked for the shape this estate writes rather than taken as-is. `messageId` is
 * a broker field any publisher can set to anything, and an id from somewhere else would otherwise
 * be looked up, found missing, and filed as a job already finished — reporting a foreign message
 * as work this queue had completed. Null only when neither carries a usable key: a fact about the
 * message rather than an error to raise, and the reconciler reports it as unreadable.
 */
function readDedupeKey(message: ServiceBusReceivedMessage): string | null {
  try {
    return parseIngestSignal(message.body).dedupeKey;
  } catch {
    const { messageId } = message;
    if (typeof messageId !== 'string') return null;
    const kind = messageId.slice(0, messageId.indexOf(':'));
    return INGEST_JOB_KINDS.some((known) => known === kind) ? messageId : null;
  }
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
