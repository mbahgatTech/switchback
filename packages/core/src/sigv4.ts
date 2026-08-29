/**
 * SigV4 query-string ("presigned URL") authentication, against R2's S3 API.
 *
 * Here rather than in either caller because both `@switchback/api` and `@switchback/ingest` sign
 * requests to R2, `api` already depends on `ingest`, and a bug in canonicalisation is one bug in
 * one algorithm — the unreserved set, the canonical request's field order, the signing-key chain.
 * `packages/api/test/storage.test.ts` runs this against AWS's published vectors.
 *
 * What is *not* here: buckets, credentials sources, key layouts, signature lifetimes, and which
 * headers a caller chooses to sign. Those are decisions, and they differ.
 */

/** R2 signs against `auto`; its buckets carry a location hint rather than a region. */
const DEFAULT_REGION = 'auto';
const DEFAULT_SERVICE = 's3';

export const SIGV4_ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * Signed without hashing the body. A presigned PUT's signature has to exist before the client
 * has read the file, so there is nothing to hash.
 */
export const SIGV4_UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

const encoder = new TextEncoder();

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SigV4QueryRequest {
  method: string;
  host: string;
  /** Percent-encoded already: the key layout belongs to the caller, not to the signer. */
  canonicalUri: string;
  /** Headers to sign. Must carry `host`; anything beyond it is the caller's security decision. */
  headers: Record<string, string>;
  /** Query parameters folded into the signature alongside the `X-Amz-*` set. */
  query?: Record<string, string>;
  expiresInS: number;
  now?: Date;
  region?: string;
  service?: string;
}

export interface SignedQueryUrl {
  url: string;
  /** The `SignedHeaders` value, which a caller must reproduce exactly on the wire. */
  signedHeaders: string;
}

/** Sign a request as a URL. The returned URL is complete: query, signature and all. */
export async function presignQueryV4(
  credentials: SigV4Credentials,
  request: SigV4QueryRequest,
): Promise<SignedQueryUrl> {
  const region = request.region ?? DEFAULT_REGION;
  const service = request.service ?? DEFAULT_SERVICE;
  const stamp = amzDate(request.now ?? new Date());
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;

  const names = Object.keys(request.headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names
    .map((name) => `${name}:${request.headers[name]?.trim() ?? ''}\n`)
    .join('');

  const query: Record<string, string> = {
    ...request.query,
    'X-Amz-Algorithm': SIGV4_ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(request.expiresInS),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name] ?? '')}`)
    .join('&');

  const canonicalRequest = [
    request.method,
    request.canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    SIGV4_UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [SIGV4_ALGORITHM, stamp, scope, await sha256Hex(canonicalRequest)].join(
    '\n',
  );

  // Annotated rather than inferred: `TextEncoder.encode` is typed as backed by a plain
  // `ArrayBuffer` while `crypto.subtle.sign` returns the wider `ArrayBufferLike`.
  let signing: Uint8Array = encoder.encode(`AWS4${credentials.secretAccessKey}`);
  for (const part of [dateStamp, region, service, 'aws4_request']) {
    signing = await hmac(signing, part);
  }
  const signature = toHex(await hmac(signing, stringToSign));

  return {
    url: `https://${request.host}${request.canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    signedHeaders,
  };
}

/**
 * AWS's percent-encoding, which is *not* `encodeURIComponent`. The unreserved set is exactly
 * `A-Za-z0-9-_.~`, encoded with uppercase hex; `encodeURIComponent` leaves `!*'()` alone, and
 * those four are why a hand-rolled signer works until it meets a key with an apostrophe.
 */
export function uriEncode(value: string, encodeSlash = true): string {
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

/** `20260727T113045Z` — SigV4's timestamp format, which is ISO-8601 with the punctuation gone. */
export function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/gu, '').split('.')[0]}Z`;
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export async function hmac(key: Uint8Array, data: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key as unknown as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data)));
}

export async function sha256Hex(data: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(data))));
}
