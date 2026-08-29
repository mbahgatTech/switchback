/**
 * Terrarium tiles in a Cloudflare R2 bucket — the deployed half of the shared tier. Chosen over
 * Postgres and Azure Blob for a reason recorded in `infra/azure/README.md`: it is the only store
 * both the Functions worker and Vercel reach over plain HTTPS, and its egress is free in both
 * directions.
 *
 * The signing is `@switchback/core`'s, shared with the photograph bucket and held to AWS's
 * published vectors there. What belongs to this module is the key layout, the credential, and
 * reading a 404 as "not stored yet" rather than as a failure.
 */

import { presignQueryV4, uriEncode } from '@switchback/core';
import { NO_TILE_BYTES, storedFromBody } from './terrain-cache';
import type { StoredTerrain, TerrainCacheStore } from './terrain-cache';

export interface R2TerrainConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** Key prefix inside the bucket, so terrain can share one with something else later. */
  prefix?: string;
  fetchImpl?: typeof fetch;
  /** Injected so a signature can be asserted exactly rather than only by shape. */
  nowImpl?: () => Date;
}

/** Long enough for one request, short enough that a URL in a stack trace is already dead. */
const SIGNATURE_TTL_S = 60;

/**
 * Ceiling on a body this store will read. A terrarium tile is ~50 KB; a megabyte is already an
 * answer to a different question. Without it a bucket serving something unexpected — an error
 * document, a misplaced upload — is read whole into an invocation with a 1.5 s lookup budget.
 */
const MAX_TILE_BYTES = 1_048_576;

export function r2TerrainStore(config: R2TerrainConfig): TerrainCacheStore {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const prefix = (config.prefix ?? 'terrarium').replace(/^\/+|\/+$/gu, '');

  const url = async (method: string, z: number, x: number, y: number): Promise<string> => {
    const host = `${config.accountId}.r2.cloudflarestorage.com`;
    // Path-style: virtual-hosted style needs the bucket in the hostname, which R2 supports only
    // on custom domains.
    const key = `${prefix}/${z}/${x}/${y}.png`;
    const signed = await presignQueryV4(config, {
      method,
      host,
      canonicalUri: `/${uriEncode(config.bucket, false)}/${uriEncode(key, false)}`,
      headers: { host },
      expiresInS: SIGNATURE_TTL_S,
      ...(config.nowImpl ? { now: config.nowImpl() } : {}),
    });
    return signed.url;
  };

  return {
    kind: 'r2',

    async read(z, x, y, signal): Promise<StoredTerrain> {
      const response = await fetchImpl(await url('GET', z, x, y), { signal });
      if (response.status === 404) return { kind: 'miss' };
      if (!response.ok) throw new Error(`terrain cache GET ${z}/${x}/${y}: ${response.status}`);

      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_TILE_BYTES) {
        throw new Error(`terrain cache GET ${z}/${x}/${y}: ${declared} bytes is not a tile`);
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_TILE_BYTES) {
        throw new Error(`terrain cache GET ${z}/${x}/${y}: ${body.length} bytes is not a tile`);
      }
      return storedFromBody(body);
    },

    async write(z, x, y, body, signal) {
      const response = await fetchImpl(await url('PUT', z, x, y), {
        method: 'PUT',
        body: body ? new Uint8Array(body) : NO_TILE_BYTES,
        signal,
      });
      if (!response.ok) throw new Error(`terrain cache PUT ${z}/${x}/${y}: ${response.status}`);
    },
  };
}
