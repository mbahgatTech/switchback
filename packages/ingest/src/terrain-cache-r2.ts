/**
 * Terrarium tiles in a Cloudflare R2 bucket — the deployed half of the shared tier. Chosen over
 * Postgres and Azure Blob for a reason recorded in `.plans/WO-shared-terrain-cache-v1.md`: it is
 * the only store both the Functions worker and Vercel reach over plain HTTPS, and its egress is
 * free in both directions.
 *
 * **SigV4 is here rather than imported.** `packages/api/src/storage.ts` has a presigner, but
 * `@switchback/api` depends on `@switchback/ingest`, so importing it back is a cycle. This is the
 * two verbs a cache issues and nothing else; the shared home is `@switchback/core`.
 */

import type { StoredTerrain, TerrainCacheStore } from './terrain-cache';

export interface R2TerrainConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Key prefix inside the bucket, so terrain can share one with something else later. */
  prefix?: string;
  fetchImpl?: typeof fetch;
}

/** R2 signs against `auto`; its buckets have a location hint rather than a region. */
const REGION = 'auto';
const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/** Signed without hashing the body, the same choice `packages/api/src/storage.ts` documents. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** Long enough for one request, short enough that a URL in a stack trace is already dead. */
const SIGNATURE_TTL_S = 60;

const NO_TILE = new Uint8Array(0);

const encoder = new TextEncoder();

export function r2TerrainStore(config: R2TerrainConfig): TerrainCacheStore {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const prefix = (config.prefix ?? 'terrarium').replace(/^\/+|\/+$/gu, '');

  const url = (method: string, z: number, x: number, y: number): Promise<string> =>
    presign(config, method, `${prefix}/${z}/${x}/${y}.png`);

  return {
    kind: 'r2',

    async read(z, x, y, signal): Promise<StoredTerrain> {
      const response = await fetchImpl(await url('GET', z, x, y), { signal });
      if (response.status === 404) return { kind: 'miss' };
      if (!response.ok) throw new Error(`terrain cache GET ${z}/${x}/${y}: ${response.status}`);
      const body = Buffer.from(await response.arrayBuffer());
      // Zero bytes is the marker for a tile the origin does not have — see `terrain-cache-dir.ts`.
      return body.length === 0 ? { kind: 'absent' } : { kind: 'tile', body };
    },

    async write(z, x, y, body, signal) {
      const response = await fetchImpl(await url('PUT', z, x, y), {
        method: 'PUT',
        body: body ? new Uint8Array(body) : NO_TILE,
        signal,
      });
      if (!response.ok) throw new Error(`terrain cache PUT ${z}/${x}/${y}: ${response.status}`);
    },
  };
}

/**
 * SigV4 query-string authentication for one object. Only `host` is signed: the content-type that
 * `storage.ts` folds in exists to stop a leaked browser ticket parking `text/html` in a public
 * bucket, and this URL is built, used and discarded inside one function call.
 */
async function presign(
  config: R2TerrainConfig,
  method: string,
  key: string,
  now = new Date(),
): Promise<string> {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const stamp = `${now.toISOString().replace(/[-:]/gu, '').split('.')[0]}Z`;
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;

  // Path-style: virtual-hosted style needs the bucket in the hostname, which R2 supports only
  // on custom domains.
  const canonicalUri = `/${uriEncode(config.bucket, false)}/${uriEncode(key, false)}`;

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(SIGNATURE_TTL_S),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name] ?? '')}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, stamp, scope, await sha256Hex(canonicalRequest)].join('\n');

  let signing: Uint8Array = encoder.encode(`AWS4${config.secretAccessKey}`);
  for (const part of [dateStamp, REGION, SERVICE, 'aws4_request']) {
    signing = await hmac(signing, part);
  }

  const signature = toHex(await hmac(signing, stringToSign));
  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * AWS's percent-encoding, which is not `encodeURIComponent` — the unreserved set is exactly
 * `A-Za-z0-9-_.~` and the hex is uppercase.
 */
function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const char of value) {
    if (/[A-Za-z0-9\-_.~]/u.test(char)) {
      out += char;
    } else if (char === '/' && !encodeSlash) {
      out += char;
    } else {
      for (const byte of encoder.encode(char)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)));
}

async function sha256Hex(data: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(data))));
}
