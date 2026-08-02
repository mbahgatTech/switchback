/**
 * Publishes wake-up signals to Azure Service Bus. `ingest_jobs` stays the queue of record — a
 * message carries only a `dedupeKey`, so a message and a row can never disagree.
 */

import { createHmac } from 'node:crypto';

export type IngestQueueDriver = 'postgres' | 'servicebus';

export const DEFAULT_INGEST_QUEUE = 'ingest-jobs';

/** How long a minted SAS token is good for. Reused across the sends of one call, not cached. */
const TOKEN_TTL_S = 3600;

/**
 * Wall clock a publish gets. Every caller runs this after its response is on the wire, so the
 * only thing a longer wait buys is a serverless invocation held open for a broker that is down.
 */
const SEND_TIMEOUT_MS = 3_000;

/**
 * Messages per POST. Service Bus caps a batch at 256 KB and these are ~120 bytes, so this is
 * well inside it — it exists so a caller with a large key list cannot walk into that cap.
 */
const MAX_BATCH = 100;

/**
 * Which queue drives ingest, from `INGEST_QUEUE_DRIVER`. Anything but `servicebus` — unset,
 * blank, a typo — is the Postgres drain that has always shipped, so a broken value degrades to
 * the working path. `apps/web/src/env.ts` rejects the typo at startup rather than leaving it here.
 */
export function ingestQueueDriver(source: NodeJS.ProcessEnv = process.env): IngestQueueDriver {
  return source.INGEST_QUEUE_DRIVER?.trim() === 'servicebus' ? 'servicebus' : 'postgres';
}

interface SendTarget {
  /** `https://<namespace>.servicebus.windows.net` — the REST origin, not the `sb://` endpoint. */
  origin: string;
  queue: string;
  keyName: string;
  key: string;
}

export interface PublishResult {
  published: number;
  /** Signals that did not reach the broker. Their `ingest_jobs` rows are unaffected. */
  failed: number;
}

/**
 * Publish one signal per key, best effort.
 *
 * **It never throws and never rejects.** The row is written by `queueTiles` before anything
 * calls this, so a broker outage costs the wake-up and nothing else: the work is still queued,
 * still deduped, still priority-ordered, and the worker's own pump re-derives it from
 * `ingest_jobs` on its next tick. Failing the request instead would let a Service Bus incident
 * empty the map.
 */
export async function publishIngestSignals(
  dedupeKeys: readonly string[],
  source: NodeJS.ProcessEnv = process.env,
): Promise<PublishResult> {
  if (dedupeKeys.length === 0) return { published: 0, failed: 0 };

  const target = sendTarget(source);
  if (!target) {
    console.error('[ingest] INGEST_QUEUE_DRIVER=servicebus with no usable connection string');
    return { published: 0, failed: dedupeKeys.length };
  }

  const token = sasToken(`${target.origin}/${target.queue}`, target.keyName, target.key);
  let published = 0;
  let failed = 0;

  for (let i = 0; i < dedupeKeys.length; i += MAX_BATCH) {
    const batch = dedupeKeys.slice(i, i + MAX_BATCH);
    if (await sendBatch(target, token, batch)) published += batch.length;
    else failed += batch.length;
  }

  return { published, failed };
}

/**
 * One POST per batch. The content type is what makes it a batch: with `application/json` the
 * broker would take the whole array as the body of a single message.
 */
async function sendBatch(
  target: SendTarget,
  token: string,
  dedupeKeys: readonly string[],
): Promise<boolean> {
  const body = dedupeKeys.map((dedupeKey) => ({
    Body: JSON.stringify({ dedupeKey }),
    // `MessageId` is what the queue's duplicate detection collapses on, and `dedupeKey` is
    // already the name of the unit of work — see `enqueue`.
    BrokerProperties: { MessageId: dedupeKey },
    UserProperties: { kind: dedupeKey.slice(0, dedupeKey.indexOf(':')) },
  }));

  try {
    const response = await fetch(`${target.origin}/${target.queue}/messages`, {
      method: 'POST',
      headers: {
        Authorization: token,
        'Content-Type': 'application/vnd.microsoft.servicebus.json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (response.ok) return true;
    console.error(
      `[ingest] service bus refused ${dedupeKeys.length} signal(s): ${response.status}`,
    );
    return false;
  } catch (error) {
    console.error(`[ingest] service bus unreachable for ${dedupeKeys.length} signal(s)`, error);
    return false;
  }
}

/**
 * A Shared Access Signature over the queue URI. Hand-rolled against the REST API rather than
 * `@azure/service-bus`: a send is one POST, and the AMQP client is a cold start on the request
 * path behind the map. The worker, which also receives, uses the SDK.
 */
function sasToken(resourceUri: string, keyName: string, key: string, now = Date.now()): string {
  const encoded = encodeURIComponent(resourceUri);
  const expiry = Math.floor(now / 1000) + TOKEN_TTL_S;
  const signature = createHmac('sha256', key).update(`${encoded}\n${expiry}`).digest('base64');
  return `SharedAccessSignature sr=${encoded}&sig=${encodeURIComponent(signature)}&se=${expiry}&skn=${encodeURIComponent(keyName)}`;
}

/**
 * Read the target out of `SERVICE_BUS_SEND_CONNECTION_STRING`, or null if it is unusable.
 * `EntityPath` is honoured because a queue-scoped authorization rule — which is what the send
 * credential should be — puts the queue name there and nowhere else.
 */
function sendTarget(source: NodeJS.ProcessEnv): SendTarget | null {
  const raw = source.SERVICE_BUS_SEND_CONNECTION_STRING?.trim();
  if (!raw) return null;

  const fields = new Map<string, string>();
  for (const part of raw.split(';')) {
    // On the first `=` only: a SharedAccessKey is base64 and carries its own padding.
    const split = part.indexOf('=');
    if (split > 0)
      fields.set(part.slice(0, split).trim().toLowerCase(), part.slice(split + 1).trim());
  }

  const endpoint = fields.get('endpoint');
  const keyName = fields.get('sharedaccesskeyname');
  const key = fields.get('sharedaccesskey');
  if (!endpoint || !keyName || !key) return null;

  const queue =
    source.SERVICE_BUS_QUEUE?.trim() || fields.get('entitypath') || DEFAULT_INGEST_QUEUE;

  try {
    const url = new URL(endpoint);
    return { origin: `https://${url.host}`, queue, keyName, key };
  } catch {
    return null;
  }
}
