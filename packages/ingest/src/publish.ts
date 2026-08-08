/**
 * Publishes wake-up signals to Azure Service Bus. `ingest_jobs` stays the queue of record — a
 * message carries only a `dedupeKey`, so a message and a row can never disagree.
 */

export const DEFAULT_INGEST_QUEUE = 'ingest-jobs';

/**
 * Where Vercel puts the deployment's OIDC token on a function request. It is a header and not
 * an environment variable on purpose — the token is per-invocation — so a caller that reads
 * `process.env` finds nothing and publishes nowhere.
 */
export const VERCEL_OIDC_HEADER = 'x-vercel-oidc-token';

/** Service Bus' resource for an Entra access token. Not a URL that is ever fetched. */
const SERVICE_BUS_SCOPE = 'https://servicebus.azure.net/.default';

/**
 * Wall clock a publish gets, per HTTP call. Every caller runs this after its response is on the
 * wire, so the only thing a longer wait buys is a serverless invocation held open for a broker
 * that is down. Two calls can happen on a cold lambda — the token exchange, then the send.
 */
const CALL_TIMEOUT_MS = 3_000;

/** Renew this long before the access token actually expires. */
const TOKEN_SKEW_MS = 120_000;

/**
 * Messages per POST. Service Bus caps a batch at 256 KB and these are ~120 bytes, so this is
 * well inside it — it exists so a caller with a large key list cannot walk into that cap.
 */
const MAX_BATCH = 100;

interface SendTarget {
  /** `<namespace>.servicebus.windows.net`, the REST host — not the `sb://` endpoint. */
  host: string;
  queue: string;
  tenantId: string;
  clientId: string;
}

export interface PublishOptions {
  /**
   * The Vercel OIDC token for this request, which is the only credential in this path. It
   * arrives as the `x-vercel-oidc-token` header and is never in `process.env` on a deployed
   * function, so every caller has to read it off its own request and pass it here.
   */
  oidcToken?: string | null;
  env?: NodeJS.ProcessEnv;
}

export interface PublishResult {
  published: number;
  /** Signals that did not reach the broker. Their `ingest_jobs` rows are unaffected. */
  failed: number;
}

/**
 * The literal an operator greps for when a wake-up did not reach the broker.
 *
 * Enqueue has one path now, so a publish that fails is the only moment at which a tile somebody
 * is looking at depends on the pump's two-minute tick rather than on a doorbell. Nothing else
 * says so: `publishIngestSignals` cannot throw without emptying the map on a broker incident, and
 * a returned count reaches only a caller that is already inside `waitUntil`. Greppable in Vercel's
 * runtime logs; there is no Azure-side emitter and no alert.
 */
export const PUBLISH_FAILED_MARKER = 'switchback-ingest-publish-failed';

/**
 * Publish one signal per key, best effort.
 *
 * **It never throws and never rejects.** The row is written by `queueTiles` before anything
 * calls this, so a broker outage — or a token exchange the identity provider refuses — costs
 * the wake-up and nothing else: the work is still queued, still deduped, still priority-ordered,
 * and `runPump` re-derives it from `ingest_jobs` on its next two-minute tick. Failing the request
 * instead would let a Service Bus incident empty the map.
 *
 * That recovery is why a lost signal is latency rather than loss. `PUBLISH_FAILED_MARKER` makes the
 * failure greppable in Vercel's runtime logs, which is where it lands and the only place it lands:
 * Vercel writes to no Application Insights, so no rule in `infra/azure/ingest.bicep` can read it and
 * none tries. Durability does not depend on anyone seeing it — `ingest_jobs` is the queue of record
 * and this is a doorbell.
 */
export async function publishIngestSignals(
  dedupeKeys: readonly string[],
  options: PublishOptions = {},
): Promise<PublishResult> {
  if (dedupeKeys.length === 0) return { published: 0, failed: 0 };

  const target = sendTarget(options.env ?? process.env);
  if (!target) {
    console.error(`${PUBLISH_FAILED_MARKER} no usable publisher identity for this deployment`);
    return { published: 0, failed: dedupeKeys.length };
  }

  const token = await accessToken(target, options.oidcToken);
  if (!token) return { published: 0, failed: dedupeKeys.length };

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
    const response = await fetch(`https://${target.host}/${target.queue}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/vnd.microsoft.servicebus.json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    if (response.ok) return true;
    /*
     * A 401 here means the access token was accepted as a token and refused as an
     * authorisation — the role assignment, not the exchange. Dropping the cache would just
     * mint an identical token, so it is kept and the operator gets the status code.
     */
    console.error(
      `${PUBLISH_FAILED_MARKER} service bus refused ${dedupeKeys.length} signal(s): ${response.status}`,
    );
    return false;
  } catch (error) {
    console.error(
      `${PUBLISH_FAILED_MARKER} service bus unreachable for ${dedupeKeys.length} signal(s)`,
      error,
    );
    return false;
  }
}

interface CachedToken {
  value: string;
  expiresAt: number;
  /** Which identity minted it, so a reconfigured lambda cannot serve a stale audience. */
  key: string;
}

let cached: CachedToken | null = null;

/** Exposed for tests; production has no reason to forget a token early. */
export function resetPublisherToken(): void {
  cached = null;
}

/**
 * Trade the deployment's Vercel OIDC token for an Entra access token, and keep it.
 *
 * This is the whole of the publisher's credential story: nothing long-lived exists on this path to
 * leak. Vercel signs a token per deployment, Entra trusts it through a federated identity
 * credential on the publisher's managed identity, and what comes back is good for about an hour.
 *
 * The cache is module state, so a warm lambda pays the exchange once rather than once a
 * request; a cold one pays a single extra round trip before the send. `TOKEN_SKEW_MS` is what
 * stops a token that passes the check here expiring mid-flight at the broker.
 */
async function accessToken(target: SendTarget, oidcToken?: string | null): Promise<string | null> {
  const assertion = oidcToken?.trim();
  if (!assertion) {
    console.error(`${PUBLISH_FAILED_MARKER} no Vercel OIDC token on this request to exchange`);
    return null;
  }

  const key = `${target.tenantId}:${target.clientId}`;
  const now = Date.now();
  if (cached && cached.key === key && cached.expiresAt - TOKEN_SKEW_MS > now) return cached.value;

  const form = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: target.clientId,
    scope: SERVICE_BUS_SCOPE,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });

  try {
    const response = await fetch(
      `https://login.microsoftonline.com/${target.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      },
    );

    if (!response.ok) {
      // The body carries an `error_description` naming the mismatched claim, and also echoes
      // the assertion's trace ids. Only the status is logged: the rest is a bearer token's
      // error envelope and this runs where anyone with log access can read it.
      console.error(
        `${PUBLISH_FAILED_MARKER} entra refused the OIDC assertion: ${response.status}`,
      );
      return null;
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      console.error(`${PUBLISH_FAILED_MARKER} entra returned no access_token`);
      return null;
    }

    cached = {
      value: payload.access_token,
      expiresAt: now + (payload.expires_in ?? 3600) * 1000,
      key,
    };
    return cached.value;
  } catch (error) {
    console.error(
      `${PUBLISH_FAILED_MARKER} could not reach entra to exchange the OIDC token`,
      error,
    );
    return null;
  }
}

/**
 * Where and as whom to publish, or null if the deployment is not configured for it. All four
 * values are public identifiers — a namespace host, a queue name, a tenant and a client id —
 * which is the point of this path: there is no secret to misplace.
 */
function sendTarget(source: NodeJS.ProcessEnv): SendTarget | null {
  const host = source.SERVICE_BUS_NAMESPACE?.trim();
  const tenantId = source.AZURE_TENANT_ID?.trim();
  const clientId = source.AZURE_CLIENT_ID?.trim();
  if (!host || !tenantId || !clientId) return null;

  return {
    host,
    queue: source.SERVICE_BUS_QUEUE?.trim() || DEFAULT_INGEST_QUEUE,
    tenantId,
    clientId,
  };
}
