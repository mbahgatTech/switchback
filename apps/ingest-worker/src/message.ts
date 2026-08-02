/**
 * The wire format between the web app, the pump and this worker. A message names a unit of
 * work; `ingest_jobs` holds what the work is.
 */

/** A wake-up signal for one `ingest_jobs` row, identified by its `dedupeKey`. */
export interface IngestSignal {
  dedupeKey: string;
}

/**
 * Read a signal off a Service Bus message body.
 *
 * The host hands back a parsed object when the message carried `application/json` and a raw
 * string otherwise, and a publisher that sets neither is not a hypothetical — so both shapes
 * are accepted rather than trusting the content type. Anything else throws, which dead-letters
 * the message after `maxDeliveryCount`: a body this cannot read will not become readable on a
 * redelivery, and losing it quietly would leave a job queued with nothing ever waking it.
 */
export function parseIngestSignal(body: unknown): IngestSignal {
  const value = typeof body === 'string' ? tryParse(body) : body;

  if (typeof value !== 'object' || value === null) {
    throw new Error('ingest signal is not an object');
  }

  const { dedupeKey } = value as Record<string, unknown>;
  if (typeof dedupeKey !== 'string' || dedupeKey.length === 0) {
    throw new Error('ingest signal has no "dedupeKey"');
  }

  return { dedupeKey };
}

function tryParse(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error('ingest signal is not JSON');
  }
}
