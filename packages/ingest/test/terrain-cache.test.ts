import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TerrainSource, elevateLine } from '../src/elevate';
import { TerrainCache, terrainCacheFromEnv } from '../src/terrain-cache';
import type { StoredTerrain, TerrainCacheStore } from '../src/terrain-cache';
import { directoryTerrainStore } from '../src/terrain-cache-dir';
import { r2TerrainStore } from '../src/terrain-cache-r2';
import { IngestDeadlineError } from '../src/deadline';
import { flatTile, pngResponse } from './fixtures/terrarium';

const TILE = flatTile(1000, 8);

interface ScriptedStore extends TerrainCacheStore {
  readonly writes: Array<Buffer | null>;
  reads: number;
}

/** A store whose answers are scripted, so a case states what the cache does and nothing else. */
function scriptedStore(script: {
  read?: (signal: AbortSignal) => Promise<StoredTerrain>;
  write?: (signal: AbortSignal) => Promise<void>;
}): ScriptedStore {
  const store: ScriptedStore = {
    kind: 'directory',
    writes: [],
    reads: 0,
    async read(_z, _x, _y, signal) {
      store.reads += 1;
      return script.read ? script.read(signal) : { kind: 'miss' };
    },
    async write(_z, _x, _y, body, signal) {
      if (script.write) await script.write(signal);
      store.writes.push(body);
    },
  };
  return store;
}

/** A source whose origin requests are counted, so a hit is proved by the absence of one. */
function sourceOver(
  cache: TerrainCache | undefined,
  origin: () => Response,
): TerrainSource & { originRequests: () => number } {
  let requests = 0;
  const source = new TerrainSource({
    urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
    cache,
    sleepImpl: async () => {},
    fetchImpl: (async () => {
      requests += 1;
      return origin();
    }) as unknown as typeof fetch,
  });
  return Object.assign(source, { originRequests: () => requests });
}

/** A store that answers only when its signal aborts, which is what a stalled bucket looks like. */
function stalledStore(): ScriptedStore {
  return scriptedStore({
    read: (signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason as Error));
      }),
  });
}

describe('the shared terrain tier', () => {
  it('serves a stored tile without touching the origin', async () => {
    const store = scriptedStore({ read: async () => ({ kind: 'tile', body: TILE }) });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    const tile = await source.tile(13, 4000, 2600);

    expect(tile).not.toBeNull();
    expect(source.originRequests()).toBe(0);
    expect(source.sharedCacheStats).toEqual({ hits: 1, misses: 0, unavailable: 0 });
  });

  it('falls through to the origin on a miss, and stores what it fetched', async () => {
    const store = scriptedStore({});
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    const tile = await source.tile(13, 4000, 2600);
    await source.flushWrites();

    expect(tile).not.toBeNull();
    expect(source.originRequests()).toBe(1);
    // The origin's own bytes, so a warm read decodes to exactly what a cold one did.
    expect(store.writes).toEqual([TILE]);
    expect(source.sharedCacheStats).toEqual({ hits: 0, misses: 1, unavailable: 0 });
  });

  it('makes one shared lookup for forty callers of one tile', async () => {
    // The tier sits inside the in-flight deduplication rather than in front of it: forty trails
    // wanting one tile is one lookup, exactly as it is one origin request.
    const store = scriptedStore({ read: async () => ({ kind: 'tile', body: TILE }) });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await Promise.all(Array.from({ length: 40 }, () => source.tile(13, 4000, 2600)));

    expect(store.reads).toBe(1);
  });

  it('serves the origin when the cache is unavailable', async () => {
    const store = scriptedStore({ read: () => Promise.reject(new Error('bucket unreachable')) });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await expect(source.tile(13, 4000, 2600)).resolves.not.toBeNull();
    expect(source.originRequests()).toBe(1);
  });

  it('stores a tile the origin does not have, and reads it back as no tile there', async () => {
    const store = scriptedStore({});
    const cold = sourceOver(new TerrainCache(store), () => new Response('', { status: 404 }));

    await expect(cold.tile(13, 1, 1)).resolves.toBeNull();
    await cold.flushWrites();
    expect(store.writes).toEqual([null]);

    const warm = sourceOver(
      new TerrainCache(scriptedStore({ read: async () => ({ kind: 'absent' }) })),
      () => pngResponse(TILE),
    );
    await expect(warm.tile(13, 1, 1)).resolves.toBeNull();
    expect(warm.originRequests()).toBe(0);
    expect(warm.sharedCacheStats).toEqual({ hits: 1, misses: 0, unavailable: 0 });
  });

  it('does not read an unavailable cache as no tile there', async () => {
    // Both answers are `null` at the caller if they are confused, and confusing them publishes
    // an outage as a sea-level profile.
    const store = scriptedStore({ read: () => Promise.reject(new Error('down')) });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await expect(source.tile(13, 1, 1)).resolves.not.toBeNull();
    expect(source.sharedCacheStats).toEqual({ hits: 0, misses: 0, unavailable: 1 });
  });

  it('re-fetches a stored object that will not decode', async () => {
    const store = scriptedStore({
      read: async () => ({ kind: 'tile', body: Buffer.from('not a png') }),
    });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await expect(source.tile(13, 1, 1)).resolves.not.toBeNull();
    expect(source.originRequests()).toBe(1);
  });

  it('swallows a write that fails', async () => {
    const store = scriptedStore({ write: () => Promise.reject(new Error('403')) });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await expect(source.tile(13, 1, 1)).resolves.not.toBeNull();
    await expect(source.flushWrites()).resolves.toBeUndefined();
  });
});

describe('the lookup timeout', () => {
  it('bounds a store that never answers, and the tile still arrives from the origin', async () => {
    const store = stalledStore();
    const source = sourceOver(new TerrainCache(store, { lookupTimeoutMs: 30 }), () =>
      pngResponse(TILE),
    );

    const started = Date.now();
    await expect(source.tile(13, 1, 1)).resolves.not.toBeNull();

    expect(source.originRequests()).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('is clamped by a deadline nearer than itself', async () => {
    // Five seconds of lookup budget against 40 ms of clock left: without the clamp this test
    // takes five seconds, which is the cost a stalled cache would charge a dying invocation.
    const cache = new TerrainCache(stalledStore(), { lookupTimeoutMs: 5_000 });

    const started = Date.now();
    expect((await cache.read(13, 1, 1, Date.now() + 40)).kind).toBe('unavailable');

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('does not bind a write, which nobody is waiting on', async () => {
    // Sharing the lookup's budget measured as 7 of 256 tiles silently not stored on a cold pass:
    // the load that makes a write slow is the load the cache exists for.
    const store = scriptedStore({
      write: (signal) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 60);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(signal.reason as Error);
          });
        }),
    });

    await new TerrainCache(store, { lookupTimeoutMs: 5, writeTimeoutMs: 5_000 }).write(
      13,
      1,
      1,
      TILE,
    );

    expect(store.writes).toEqual([TILE]);
  });
});

describe('the breaker', () => {
  it('stops consulting a store that keeps failing, and reopens after the cool-down', async () => {
    // 256 lookups at the timeout each is how a cache outage costs more than the fetches it saves.
    let now = 1_000;
    const store = scriptedStore({ read: () => Promise.reject(new Error('down')) });
    const cache = new TerrainCache(store, {
      failureLimit: 2,
      retryAfterMs: 5_000,
      nowImpl: () => now,
    });

    for (let i = 0; i < 6; i++) expect((await cache.read(13, i, 0)).kind).toBe('unavailable');
    expect(store.reads).toBe(2);

    now += 5_001;
    expect((await cache.read(13, 9, 0)).kind).toBe('unavailable');
    expect(store.reads).toBe(3);
  });

  it('forgets earlier failures once a lookup succeeds', async () => {
    let now = 1_000;
    let failing = true;
    const store = scriptedStore({
      read: async () => {
        if (failing) throw new Error('down');
        return { kind: 'tile', body: TILE };
      },
    });
    const cache = new TerrainCache(store, { failureLimit: 3, nowImpl: () => now });

    await cache.read(13, 1, 0);
    await cache.read(13, 2, 0);
    failing = false;
    expect((await cache.read(13, 3, 0)).kind).toBe('tile');

    // Two stale failures must not carry over and trip the breaker on the next single one.
    failing = true;
    await cache.read(13, 4, 0);
    failing = false;
    expect((await cache.read(13, 5, 0)).kind).toBe('tile');
  });
});

describe('the directory store', () => {
  let root: string;
  const anySignal = () => AbortSignal.timeout(5_000);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sb-terrain-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('round-trips a tile', async () => {
    const store = directoryTerrainStore(root);
    await store.write(13, 4000, 2600, TILE, anySignal());

    const found = await store.read(13, 4000, 2600, anySignal());

    expect(found.kind).toBe('tile');
    expect(found.kind === 'tile' && found.body.equals(TILE)).toBe(true);
  });

  it('reports a file that is not there as a miss', async () => {
    expect((await directoryTerrainStore(root).read(13, 1, 1, anySignal())).kind).toBe('miss');
  });

  it('round-trips no tile there as a zero-length object', async () => {
    const store = directoryTerrainStore(root);
    await store.write(13, 1, 1, null, anySignal());

    expect((await store.read(13, 1, 1, anySignal())).kind).toBe('absent');
    expect((await readFile(join(root, '13', '1', '1.png'))).length).toBe(0);
  });

  it('leaves no staging file behind, so a reader never sees half a PNG', async () => {
    const store = directoryTerrainStore(root);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        // A rename losing a race is a write that did not happen, which the policy layer swallows.
        store.write(13, 5, 5, TILE, anySignal()).catch(() => undefined),
      ),
    );

    expect(await readdir(join(root, '13', '5'))).toEqual(['5.png']);
  });

  it('refuses a coordinate that is not a whole number rather than building a path from it', async () => {
    await expect(directoryTerrainStore(root).read(13, 1.5, 1, anySignal())).rejects.toThrow(
      /coordinate/u,
    );
  });

  it('reads an unreadable path as unavailable rather than as a miss', async () => {
    // A miss is a lie the caller acts on; only a genuinely absent file is one.
    await mkdir(join(root, '13', '7', '7.png'), { recursive: true });
    const store = directoryTerrainStore(root);

    await expect(store.read(13, 7, 7, anySignal())).rejects.toThrow();
    expect((await new TerrainCache(store).read(13, 7, 7)).kind).toBe('unavailable');
  });
});

describe('the R2 store', () => {
  const config = {
    accountId: 'acct',
    accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    bucket: 'terrain',
  };
  const anySignal = () => AbortSignal.timeout(5_000);

  it('signs a GET at the path-style object address', async () => {
    let seen = '';
    const store = r2TerrainStore({
      ...config,
      fetchImpl: (async (url: string) => {
        seen = url;
        return pngResponse(TILE);
      }) as unknown as typeof fetch,
    });

    expect((await store.read(13, 4000, 2600, anySignal())).kind).toBe('tile');
    expect(seen.split('?')[0]).toBe(
      'https://acct.r2.cloudflarestorage.com/terrain/terrarium/13/4000/2600.png',
    );
    expect(seen).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(seen).toContain('X-Amz-SignedHeaders=host');
    expect(seen).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/u);
  });

  it('reads a 404 as a miss and any other failure as a throw', async () => {
    const at = (status: number) =>
      r2TerrainStore({
        ...config,
        fetchImpl: (async () => new Response('', { status })) as unknown as typeof fetch,
      });

    expect((await at(404).read(13, 1, 1, anySignal())).kind).toBe('miss');
    await expect(at(503).read(13, 1, 1, anySignal())).rejects.toThrow(/503/u);
  });

  it('reads a zero-length object as no tile there', async () => {
    const store = r2TerrainStore({
      ...config,
      fetchImpl: (async () =>
        new Response(new Uint8Array(0), { status: 200 })) as unknown as typeof fetch,
    });

    expect((await store.read(13, 1, 1, anySignal())).kind).toBe('absent');
  });

  it('PUTs the bytes it was given', async () => {
    let method = '';
    let sent: Uint8Array<ArrayBufferLike> = new Uint8Array(1);
    const store = r2TerrainStore({
      ...config,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        method = init.method ?? 'GET';
        sent = init.body as Uint8Array;
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await store.write(13, 1, 1, TILE, anySignal());

    expect(method).toBe('PUT');
    expect(Buffer.from(sent)).toEqual(TILE);
  });

  it('PUTs zero bytes for a tile the origin does not have', async () => {
    let sent: Uint8Array<ArrayBufferLike> = new Uint8Array(1);
    const store = r2TerrainStore({
      ...config,
      fetchImpl: (async (_url: string, init: RequestInit) => {
        sent = init.body as Uint8Array;
        return new Response('', { status: 200 });
      }) as unknown as typeof fetch,
    });

    await store.write(13, 1, 1, null, anySignal());

    expect(sent.length).toBe(0);
  });
});

describe('terrainCacheFromEnv', () => {
  const r2Env = {
    TERRAIN_CACHE_R2_ACCOUNT_ID: 'acct',
    TERRAIN_CACHE_R2_ACCESS_KEY_ID: 'key',
    TERRAIN_CACHE_R2_SECRET_ACCESS_KEY: 'secret',
    TERRAIN_CACHE_R2_BUCKET: 'terrain',
  };

  it('builds the R2 store when all four variables are set', () => {
    expect(terrainCacheFromEnv(r2Env)?.kind).toBe('r2');
  });

  it('builds nothing when unconfigured, which leaves the origin as the only source', () => {
    expect(terrainCacheFromEnv({})).toBeNull();
    // Three of four is a misconfiguration, and no cache at all is the safe reading of one.
    expect(terrainCacheFromEnv({ ...r2Env, TERRAIN_CACHE_R2_BUCKET: '' })).toBeNull();
  });

  it('builds a directory store from TERRAIN_CACHE_DIR', () => {
    expect(terrainCacheFromEnv({ TERRAIN_CACHE_DIR: '/tmp/terrain' })?.kind).toBe('directory');
  });

  it('prefers R2, so a stray directory cannot take a deployment off the shared tier', () => {
    expect(terrainCacheFromEnv({ ...r2Env, TERRAIN_CACHE_DIR: '/tmp/terrain' })?.kind).toBe('r2');
  });
});

describe('the deadline, against the shared tier', () => {
  it('is not spent on a shared lookup once it has passed', async () => {
    const store = scriptedStore({ read: async () => ({ kind: 'tile', body: TILE }) });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await expect(source.tile(13, 1, 1, Date.now() - 1)).rejects.toBeInstanceOf(IngestDeadlineError);
    // A network round trip is a network round trip, whichever host answers it.
    expect(store.reads).toBe(0);
    expect(source.originRequests()).toBe(0);
  });

  it('still answers from the in-process cache once it has passed', async () => {
    const store = scriptedStore({ read: async () => ({ kind: 'tile', body: TILE }) });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await source.tile(13, 1, 1);
    // Free, and refusing it would fail a trail over terrain already in hand.
    await expect(source.tile(13, 1, 1, Date.now() - 1)).resolves.not.toBeNull();
    expect(store.reads).toBe(1);
  });
});

describe('elevateLine over a warm tier', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'sb-terrain-warm-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('builds the same profile with no origin at all', async () => {
    const coords: Array<[number, number]> = [
      [-4.0, 56.8],
      [-4.0, 56.801],
    ];
    const origin = flatTile(1000, 64);

    const cold = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      cache: new TerrainCache(directoryTerrainStore(root)),
      fetchImpl: (async () => pngResponse(origin)) as unknown as typeof fetch,
    });
    const first = await elevateLine(coords, cold, { spacingM: 25 });
    await cold.flushWrites();

    const warm = new TerrainSource({
      urlTemplate: 'https://terrain.test/{z}/{x}/{y}.png',
      cache: new TerrainCache(directoryTerrainStore(root)),
      fetchImpl: (() => {
        throw new Error('the origin must not be reached on a warm run');
      }) as unknown as typeof fetch,
    });
    const second = await elevateLine(coords, warm, { spacingM: 25 });

    expect(second.gapCount).toBe(0);
    expect(second.points).toEqual(first.points);
    expect(warm.sharedCacheStats.misses).toBe(0);
  });
});
