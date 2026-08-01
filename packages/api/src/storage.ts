/**
 * Where photograph bytes go. Two drivers behind one interface, chosen at startup by whether R2
 * is configured: R2 in production (the browser uploads directly with a presigned URL — see
 * `docs/architecture.md`), and a local filesystem in development that mimics the presigned-PUT
 * contract exactly, so the client code has no branch in it.
 *
 * **SigV4 is implemented here rather than pulled in.** `@aws-sdk/client-s3` plus the presigner
 * is ~1.5 MB of bundle to produce one string, and its credential-provider chain will go looking
 * for EC2 instance metadata. The algorithm is public, fixed, and has published test vectors.
 */
import { PHOTO_CONTENT_TYPES, type PhotoContentType } from '@switchback/core';

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Public origin the objects are served from — a custom domain or the r2.dev subdomain. */
  publicUrl: string;
}

/**
 * R2 signs against `auto`, not a real region. Its buckets have a location hint rather than a
 * region, and anything else produces a signature mismatch with no useful message.
 */
const R2_REGION = 'auto';
const R2_SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/**
 * Presigned PUTs are signed without hashing the body — the signature has to exist before the
 * browser has read the file.
 */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function readR2Config(): R2Config | null {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  const publicUrl = process.env.R2_PUBLIC_URL?.trim();

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicUrl) return null;
  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    publicUrl: publicUrl.replace(/\/+$/, ''),
  };
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

export interface ObjectStat {
  size: number;
  contentType: string | null;
}

export interface ObjectEntry {
  key: string;
  size: number;
  /** When the object was last written. The sweeper's only defence against a race. */
  lastModified: Date;
}

export interface StorageDriver {
  /** Which driver this is — surfaced by `health.config` so the client can explain itself. */
  readonly kind: 'r2' | 'local';
  /** A URL the client may `PUT` exactly one object to, expiring after `expiresInS`. */
  presignPut(key: string, contentType: string, expiresInS: number): Promise<SignedRequest>;
  /** Size and type of a stored object, or null if it is not there. */
  stat(key: string): Promise<ObjectStat | null>;
  /** Remove an object. Idempotent — deleting something absent is a success. */
  remove(key: string): Promise<void>;
  /**
   * Objects under a prefix, capped at `limit`. Only the orphan sweeper calls this. Order is the
   * store's own listing order — neither store can sort by age without reading everything — so
   * the sweeper filters on `lastModified` itself. When the cap is reached the caller is told,
   * rather than handed a short list that looks complete.
   */
  list(prefix: string, limit: number): Promise<ObjectEntry[]>;
  /** Where the world reads it from. Stored in `Photo.url`. */
  publicUrl(key: string): string;
}

const encoder = new TextEncoder();

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

/**
 * Sign a request as a URL — SigV4 "query string" authentication. Exported for the test suite,
 * which runs it against AWS's published `aws4_request` vectors.
 */
export async function presignV4(
  config: R2Config,
  method: string,
  key: string,
  options: {
    contentType?: string;
    expiresInS: number;
    now?: Date;
    /** Extra query parameters to fold into the signature — `list-type=2` and friends. */
    query?: Record<string, string>;
  },
): Promise<SignedRequest> {
  const host = `${config.accountId}.r2.cloudflarestorage.com`;
  const stamp = amzDate(options.now ?? new Date());
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/${R2_REGION}/${R2_SERVICE}/aws4_request`;

  // Path-style, `/<bucket>/<key>`: virtual-hosted style needs the bucket in the hostname, which
  // R2 supports only on custom domains. An empty key addresses the bucket itself, which is how
  // a listing is requested — and it must be `/<bucket>` without the trailing slash, because S3
  // reads that slash as a request for an object named the empty string inside a folder.
  const canonicalUri = key
    ? `/${uriEncode(config.bucket, false)}/${uriEncode(key, false)}`
    : `/${uriEncode(config.bucket, false)}`;

  // Signing `content-type` is a security decision, not a formality: without it the ticket
  // authorises *any* content type at that key, so a leaked URL could park `text/html` in a
  // bucket served from our own domain — stored XSS with a CDN in front of it.
  const headers: Record<string, string> = { host };
  if (options.contentType) headers['content-type'] = options.contentType;

  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]?.trim() ?? ''}\n`).join('');

  const query: Record<string, string> = {
    ...options.query,
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${config.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(options.expiresInS),
    'X-Amz-SignedHeaders': signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name] ?? '')}`)
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, stamp, scope, await sha256Hex(canonicalRequest)].join('\n');

  // Annotated rather than inferred: `TextEncoder.encode` is typed as backed by a plain
  // `ArrayBuffer` while `crypto.subtle.sign` returns the wider `ArrayBufferLike`.
  let signing: Uint8Array = encoder.encode(`AWS4${config.secretAccessKey}`);
  for (const part of [dateStamp, R2_REGION, R2_SERVICE, 'aws4_request']) {
    signing = await hmac(signing, part);
  }
  const signature = toHex(await hmac(signing, stringToSign));

  return {
    url: `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`,
    headers: options.contentType ? { 'Content-Type': options.contentType } : {},
  };
}

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

/**
 * The five XML entities, reversed. S3 escapes keys in a listing, so `photos/u/a&b.jpg` comes
 * back as `a&amp;b.jpg` and a naive parser would ask the store to delete a key that does not
 * exist. Our own keys cannot contain any of these; this keeps that true of the *parser*.
 */
function xmlDecode(value: string): string {
  return value
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&amp;/gu, '&');
}

function tagText(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'u').exec(xml);
  return match?.[1] === undefined ? null : xmlDecode(match[1]);
}

/**
 * Parse `ListObjectsV2` without an XML library — the shape is fixed by the S3 API and is one
 * repeating element with three fields we read. Exported for the test suite: everything this
 * returns becomes a delete candidate, so a mis-parse is not a display bug.
 */
export function parseListing(xml: string): { entries: ObjectEntry[]; nextToken: string | null } {
  const entries: ObjectEntry[] = [];
  for (const block of xml.match(/<Contents>[\s\S]*?<\/Contents>/gu) ?? []) {
    const key = tagText(block, 'Key');
    const modified = tagText(block, 'LastModified');
    if (!key || !modified) continue;
    const at = new Date(modified);
    entries.push({ key, size: Number(tagText(block, 'Size') ?? 0), lastModified: at });
  }
  const truncated = tagText(xml, 'IsTruncated') === 'true';
  return { entries, nextToken: truncated ? tagText(xml, 'NextContinuationToken') : null };
}

/** S3 will not return more than this in one page whatever we ask for. */
const LIST_PAGE = 1000;

function r2Driver(config: R2Config): StorageDriver {
  /** Server-side calls sign the same way the client's does; we just make the request ourselves. */
  const signed = (method: string, key: string) =>
    presignV4(config, method, key, { expiresInS: 60 });

  return {
    kind: 'r2',

    presignPut: (key, contentType, expiresInS) =>
      presignV4(config, 'PUT', key, { contentType, expiresInS }),

    async stat(key) {
      const { url } = await signed('HEAD', key);
      const response = await fetch(url, { method: 'HEAD' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`R2 HEAD ${key} failed: ${response.status}`);
      const length = response.headers.get('content-length');
      return {
        size: length === null ? 0 : Number(length),
        contentType: response.headers.get('content-type'),
      };
    },

    async remove(key) {
      const { url } = await signed('DELETE', key);
      const response = await fetch(url, { method: 'DELETE' });
      // S3 deletes are idempotent and answer 204 for an object that was never there. Anything
      // else is a real failure, and swallowing it would leave orphaned bytes we still pay for.
      if (!response.ok && response.status !== 404) {
        throw new Error(`R2 DELETE ${key} failed: ${response.status}`);
      }
    },

    async list(prefix, limit) {
      const out: ObjectEntry[] = [];
      let token: string | null = null;
      do {
        const query: Record<string, string> = {
          'list-type': '2',
          prefix,
          'max-keys': String(Math.min(LIST_PAGE, limit - out.length)),
        };
        if (token) query['continuation-token'] = token;
        const { url } = await presignV4(config, 'GET', '', { expiresInS: 60, query });
        const response = await fetch(url);
        if (!response.ok) throw new Error(`R2 LIST ${prefix} failed: ${response.status}`);
        const page = parseListing(await response.text());
        out.push(...page.entries);
        token = page.nextToken;
      } while (token && out.length < limit);
      return out.slice(0, limit);
    },

    publicUrl: (key) => `${config.publicUrl}/${key.split('/').map(encodeURIComponent).join('/')}`,
  };
}

// ---------------------------------------------------------------------------
// Local development
// ---------------------------------------------------------------------------

/**
 * Where the local driver writes. Gitignored; safe to delete at any time.
 *
 * **A literal rather than an environment override, deliberately.** Turbopack traces this module
 * to decide which files `/api/uploads` needs deployed alongside it, and a `path.resolve` whose
 * argument it cannot bound reads as "this could open anything under the repository" — so it
 * traces the entire project into that one serverless bundle, against a 250 MB ceiling. A literal
 * segment resolved against the working directory is the shape the tracer can scope.
 */
export const LOCAL_UPLOAD_DIR = '.uploads';

/** The route that stands in for a bucket. Must match `apps/web/app/api/uploads/[...key]`. */
export const LOCAL_UPLOAD_PATH = '/api/uploads';

/**
 * Keys are built by us from a user id and a random id, so they cannot contain anything exotic —
 * but this is what turns "cannot" into "does not", and the only thing standing between a signed
 * URL and `../../../../etc/passwd`.
 */
export function isSafeKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,200}$/u.test(key) && !key.includes('..');
}

function localSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set and at least 32 characters');
  }
  return encoder.encode(secret);
}

/**
 * The local driver's stand-in for a signature: the same promise SigV4 makes — this method, this
 * key, this content type, until this moment. Signed with `AUTH_SECRET`, because a development
 * upload endpoint that accepts unsigned writes is a directory anyone on your network can fill.
 */
export async function localUploadSignature(
  method: string,
  key: string,
  contentType: string,
  expiresAtMs: number,
): Promise<string> {
  return toHex(await hmac(localSecret(), `${method}\n${key}\n${contentType}\n${expiresAtMs}`));
}

/** Constant-time compare, so a signature cannot be discovered one byte at a time. */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Resolve a key to a path inside the upload directory, or throw. Belt and braces over
 * `isSafeKey`: the resolved path is checked to be *under* the root, catching anything the
 * pattern missed on a platform whose separator rules differ.
 */
export async function localPathFor(key: string): Promise<string> {
  const path = await import('node:path');
  if (!isSafeKey(key)) throw new Error('unsafe object key');
  const root = path.resolve(LOCAL_UPLOAD_DIR);
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error('object key escapes the upload directory');
  }
  return resolved;
}

function localDriver(): StorageDriver {
  return {
    kind: 'local',

    async presignPut(key, contentType, expiresInS) {
      const expiresAt = Date.now() + expiresInS * 1000;
      const signature = await localUploadSignature('PUT', key, contentType, expiresAt);
      const query = new URLSearchParams({
        ct: contentType,
        exp: String(expiresAt),
        sig: signature,
      });
      return {
        // Root-relative on purpose: an absolute `http://localhost:3000` would be baked into
        // whatever the client does with it. `new URL(url, origin)` resolves it where needed.
        url: `${LOCAL_UPLOAD_PATH}/${key}?${query.toString()}`,
        method: 'PUT',
        headers: { 'Content-Type': contentType },
      } as SignedRequest;
    },

    async stat(key) {
      const fs = await import('node:fs/promises');
      try {
        const stats = await fs.stat(await localPathFor(key));
        return { size: stats.size, contentType: null };
      } catch {
        return null;
      }
    },

    async remove(key) {
      const fs = await import('node:fs/promises');
      await fs.rm(await localPathFor(key), { force: true });
    },

    async list(prefix, limit) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const root = path.resolve(LOCAL_UPLOAD_DIR);
      const out: ObjectEntry[] = [];

      const walk = async (dir: string): Promise<void> => {
        if (out.length >= limit) return;
        let items;
        try {
          items = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          // No upload directory yet is the normal state of a fresh checkout, not a failure.
          return;
        }
        for (const item of items) {
          if (out.length >= limit) return;
          const full = path.join(dir, item.name);
          if (item.isDirectory()) {
            await walk(full);
            continue;
          }
          // Back to a key: relative to the root, always forward slashes, because that is what
          // the database stored and what the R2 driver would have returned.
          const key = path.relative(root, full).split(path.sep).join('/');
          if (!key.startsWith(prefix)) continue;
          const stats = await fs.stat(full);
          out.push({ key, size: stats.size, lastModified: stats.mtime });
        }
      };

      await walk(root);
      return out;
    },

    publicUrl: (key) => `${LOCAL_UPLOAD_PATH}/${key}`,
  };
}

let cached: StorageDriver | null = null;

/**
 * The driver for this process. Memoised, and chosen by configuration rather than by `NODE_ENV`:
 * pointing a dev server at a real bucket by filling in four variables should work, and a
 * production deploy that forgot them should fail loudly at the first upload rather than write
 * to a serverless filesystem that evaporates.
 */
export function storage(): StorageDriver {
  if (cached) return cached;
  const config = readR2Config();
  cached = config ? r2Driver(config) : localDriver();
  return cached;
}

/** Test seam — lets a suite install a fake without a bucket or a filesystem. */
export function setStorageDriver(driver: StorageDriver | null): void {
  cached = driver;
}

export interface PhotoKeys {
  full: string;
  thumb: string;
}

/**
 * Where a user's photograph lives. The user id is in the path, which is what makes `commit`
 * verifiable without a pending-uploads table: the key is derived from the *authenticated*
 * caller, so an object under `photos/alice/…` was put there by a ticket issued to Alice.
 * `_t` rather than a parallel `thumbs/` tree so the two renditions sort together in a listing.
 */
export function photoKeys(
  userId: string,
  uploadId: string,
  contentType: PhotoContentType,
): PhotoKeys {
  const extension = PHOTO_CONTENT_TYPES[contentType];
  return {
    full: `photos/${userId}/${uploadId}.${extension}`,
    // Thumbnails are always JPEG: every browser can encode one from a canvas, and at 480 px the
    // format difference is a few kilobytes against the certainty of it working everywhere.
    thumb: `photos/${userId}/${uploadId}_t.jpg`,
  };
}
