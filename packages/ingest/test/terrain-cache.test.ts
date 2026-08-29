import { createHash, createHmac } from 'node:crypto';
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

const TILE = flatTile(1000);

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
    expect(source.sharedCacheStats).toEqual({ hits: 1, misses: 0, unavailable: 0, corrupt: 0 });
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
    expect(source.sharedCacheStats).toEqual({ hits: 0, misses: 1, unavailable: 0, corrupt: 0 });
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
    expect(warm.sharedCacheStats).toEqual({ hits: 1, misses: 0, unavailable: 0, corrupt: 0 });
  });

  it('does not read an unavailable cache as no tile there', async () => {
    // Both answers are `null` at the caller if they are confused, and confusing them publishes
    // an outage as a sea-level profile.
    const store = scriptedStore({ read: () => Promise.reject(new Error('down')) });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await expect(source.tile(13, 1, 1)).resolves.not.toBeNull();
    expect(source.sharedCacheStats).toEqual({ hits: 0, misses: 0, unavailable: 1, corrupt: 0 });
  });

  it('re-fetches a stored object that will not decode', async () => {
    const store = scriptedStore({
      read: async () => ({ kind: 'tile', body: Buffer.from('not a png') }),
    });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await expect(source.tile(13, 1, 1)).resolves.not.toBeNull();
    expect(source.originRequests()).toBe(1);
    // Counted apart from a miss: a miss is a key nobody has written, and this is one somebody
    // wrote wrongly. Only the second is worth waking an operator for.
    expect(source.sharedCacheStats).toEqual({ hits: 0, misses: 0, unavailable: 0, corrupt: 1 });
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
    const now = 1_000;
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

  it('keys x and y apart, so two tiles never become one', async () => {
    // Every other case here is a symmetric round-trip, which a transposed path satisfies
    // perfectly. `decodeTerrarium` stamps z/x/y from its arguments and never checks them against
    // the body, so a mis-keyed entry decodes cleanly into plausible, wrong elevations.
    const store = directoryTerrainStore(root);
    const other = flatTile(2000);
    await store.write(13, 4000, 2600, TILE, anySignal());
    await store.write(13, 2600, 4000, other, anySignal());

    const at4000 = await store.read(13, 4000, 2600, anySignal());
    const at2600 = await store.read(13, 2600, 4000, anySignal());

    expect(at4000.kind === 'tile' && at4000.body.equals(TILE)).toBe(true);
    expect(at2600.kind === 'tile' && at2600.body.equals(other)).toBe(true);
    expect(await readFile(join(root, '13', '4000', '2600.png'))).toEqual(TILE);
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
        fetchImpl: async () => new Response('', { status }),
      });

    expect((await at(404).read(13, 1, 1, anySignal())).kind).toBe('miss');
    await expect(at(503).read(13, 1, 1, anySignal())).rejects.toThrow(/503/u);
  });

  it('reads a zero-length object as no tile there', async () => {
    const store = r2TerrainStore({
      ...config,
      fetchImpl: async () => new Response(new Uint8Array(0), { status: 200 }),
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
    const origin = flatTile(1000);

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

describe('what reaches the store', () => {
  // Zero bytes is the marker for "the origin has no tile here", and nothing deletes, expires or
  // versions a key. So an empty body stored by mistake is not a stale entry that heals on the
  // next pass — it is a real tile turned into ocean, permanently, for every process that reads
  // the bucket afterwards. Non-empty garbage self-heals: it fails to decode and is re-fetched.
  it('does not store an origin 403, which says nothing about terrain', async () => {
    const store = scriptedStore({});
    const source = sourceOver(new TerrainCache(store), () => new Response('', { status: 403 }));

    await expect(source.tile(13, 4000, 2600)).resolves.toBeNull();
    await source.flushWrites();

    expect(store.writes).toEqual([]);
  });

  it('still stores an origin 404, which does', async () => {
    const store = scriptedStore({});
    const source = sourceOver(new TerrainCache(store), () => new Response('', { status: 404 }));

    await expect(source.tile(13, 4000, 2600)).resolves.toBeNull();
    await source.flushWrites();

    expect(store.writes).toEqual([null]);
  });

  it('does not store an empty 200, whose body is truthy and is not a tile', async () => {
    const store = scriptedStore({});
    const source = sourceOver(new TerrainCache(store), () => pngResponse(Buffer.alloc(0)));

    await expect(source.tile(13, 4000, 2600)).rejects.toThrow();
    await source.flushWrites();

    expect(store.writes).toEqual([]);
  });

  it('does not store a well-formed PNG that is not a tile', async () => {
    // `PNG.sync.read` succeeding says the bytes are a PNG, not that they are terrain, and
    // `decodeTerrarium` stamps z/x/y from its arguments rather than reading them. A 1x1 PNG
    // decodes into a tile whose every sample `elevationAtPixel` clamps to pixel (0,0) — one bad
    // invocation in the LRU, but that elevation for the whole estate once it is stored.
    const store = scriptedStore({});
    const source = sourceOver(new TerrainCache(store), () => pngResponse(flatTile(1000, 1)));

    await expect(source.tile(13, 4000, 2600)).rejects.toThrow(/1x1 is not a 256px/u);
    await source.flushWrites();

    expect(store.writes).toEqual([]);
  });

  it('re-fetches a stored tile of the wrong size rather than serving it', async () => {
    // The guard runs on the read side too, so a key poisoned before it existed heals itself:
    // counted corrupt, fetched from the origin, and overwritten with what the origin sent.
    const store = scriptedStore({
      read: async () => ({ kind: 'tile', body: flatTile(1000, 1) }),
    });
    const source = sourceOver(new TerrainCache(store), () => pngResponse(TILE));

    await expect(source.tile(13, 4000, 2600)).resolves.not.toBeNull();
    await source.flushWrites();

    expect(source.originRequests()).toBe(1);
    expect(source.sharedCacheStats.corrupt).toBe(1);
    expect(store.writes).toEqual([TILE]);
  });

  it('retries a body that would not decode, and stores the attempt that did', async () => {
    // Decoding happens inside the fetch attempt, not after the retry ladder. A truncated body is
    // transient and retrying it is the right answer — moving the decode after the loop would
    // turn one bad read into a failed tile, and would hand the store bytes nobody had checked.
    const store = scriptedStore({});
    let attempt = 0;
    const source = sourceOver(new TerrainCache(store), () => {
      attempt += 1;
      return attempt === 1 ? pngResponse(Buffer.from('truncated')) : pngResponse(TILE);
    });

    await expect(source.tile(13, 4000, 2600)).resolves.not.toBeNull();
    await source.flushWrites();

    expect(source.originRequests()).toBe(2);
    expect(store.writes).toEqual([TILE]);
  });

  it('issues no write at all when the token cannot write', async () => {
    // A read-only surface — Vercel reads the cache the worker fills — would otherwise send one
    // doomed PUT per miss, swallowed with nothing logged and nothing counted.
    const store = scriptedStore({});
    const source = sourceOver(new TerrainCache(store, { readOnly: true }), () => pngResponse(TILE));

    await expect(source.tile(13, 4000, 2600)).resolves.not.toBeNull();
    await source.flushWrites();

    expect(store.writes).toEqual([]);
  });

  it('says so once when writes are failing, rather than swallowing them in silence', async () => {
    const lines: string[] = [];
    const cache = new TerrainCache(
      scriptedStore({ write: () => Promise.reject(new Error('403')) }),
      {
        logImpl: (line) => lines.push(line),
      },
    );

    await cache.write(13, 1, 1, TILE);
    await cache.write(13, 2, 2, TILE);

    expect(lines).toEqual([
      expect.stringContaining('[ingest] terrain-cache directory writes failing'),
    ]);
  });

  it('does not store bytes that will not decode', async () => {
    const store = scriptedStore({});
    const source = sourceOver(new TerrainCache(store), () => pngResponse(Buffer.from('nope')));

    await expect(source.tile(13, 4000, 2600)).rejects.toThrow();
    await source.flushWrites();

    expect(store.writes).toEqual([]);
  });

  it('refuses an empty body at the policy layer too, whatever the caller believes', async () => {
    const store = scriptedStore({});
    const lines: string[] = [];

    await new TerrainCache(store, { logImpl: (line) => lines.push(line) }).write(
      13,
      4000,
      2600,
      Buffer.alloc(0),
    );

    expect(store.writes).toEqual([]);
    expect(lines).toEqual([expect.stringContaining('empty body for 13/4000/2600')]);
  });
});

describe('the stores and their abort signal', () => {
  // The timeout cases above drive hand-written doubles, which prove the double honours a signal.
  // These prove the shipped stores forward it — a store that dropped it would hang here on
  // undici's ~300 s default, which is the worst case the whole tier exists to avoid.
  const hangsUnlessAborted = (async (_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error));
    })) as unknown as typeof fetch;

  const r2Config = {
    accountId: 'acct',
    accessKeyId: 'key',
    secretAccessKey: 'secret',
    bucket: 'terrain',
  };

  it('R2 aborts a read that outruns the signal', async () => {
    const store = r2TerrainStore({ ...r2Config, fetchImpl: hangsUnlessAborted });

    await expect(store.read(13, 1, 2, AbortSignal.timeout(40))).rejects.toThrow();
  });

  it('R2 aborts a write that outruns the signal', async () => {
    const store = r2TerrainStore({ ...r2Config, fetchImpl: hangsUnlessAborted });

    await expect(store.write(13, 1, 2, TILE, AbortSignal.timeout(40))).rejects.toThrow();
  });

  it('the directory store refuses a read on an already-aborted signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sb-terrain-abort-'));
    try {
      const store = directoryTerrainStore(root);
      await store.write(13, 1, 2, TILE, AbortSignal.timeout(5_000));

      await expect(store.read(13, 1, 2, AbortSignal.abort())).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('the directory store refuses a write on an already-aborted signal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sb-terrain-abort-'));
    try {
      const store = directoryTerrainStore(root);

      await expect(store.write(13, 1, 2, TILE, AbortSignal.abort())).rejects.toThrow();
      expect((await store.read(13, 1, 2, AbortSignal.timeout(5_000))).kind).toBe('miss');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('the shared lookup, under fan-out', () => {
  it('bounds how many lookups are in flight, whatever the caller asks for', async () => {
    // `tilesFor` fans out over up to 256 tiles at once. Unbounded, that is 256 sockets to one
    // host, and `AbortSignal.timeout` runs from creation — so the queued ones would spend their
    // budget waiting and abort spuriously, arming the breaker on the cold-start burst.
    let inFlight = 0;
    let peak = 0;
    const store: TerrainCacheStore = {
      kind: 'directory',
      async read() {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return { kind: 'miss' };
      },
      async write() {},
    };
    const cache = new TerrainCache(store, { maxConcurrent: 4 });

    await Promise.all(Array.from({ length: 40 }, (_, i) => cache.read(13, i, 0)));

    expect(peak).toBe(4);
  });

  it('does not arm the breaker on a lookup the deadline cut short', async () => {
    // The abort lands in the same catch as a real failure, and `getTerrain()` memoises at module
    // scope in a worker that outlives one message — so a deadline artefact would otherwise skip
    // the tier for a minute of somebody else's invocation.
    const store = stalledStore();
    const cache = new TerrainCache(store, { lookupTimeoutMs: 5_000, failureLimit: 2 });

    for (let i = 0; i < 4; i++) {
      expect((await cache.read(13, i, 0, Date.now() + 30)).kind).toBe('unavailable');
    }

    // Four clamped aborts, and the store was still consulted every time.
    expect(store.reads).toBe(4);
  });

  it('says so once, when it stops consulting a failing store', async () => {
    const lines: string[] = [];
    const cache = new TerrainCache(
      scriptedStore({ read: () => Promise.reject(new Error('down')) }),
      {
        failureLimit: 2,
        logImpl: (line) => lines.push(line),
      },
    );

    for (let i = 0; i < 5; i++) await cache.read(13, i, 0);

    expect(lines).toEqual([
      expect.stringContaining('[ingest] terrain-cache directory lookups failing'),
    ]);
  });
});

describe('the R2 signature', () => {
  /**
   * SigV4 recomputed from the specification with `node:crypto`, so the assertion below is an
   * independent answer rather than the implementation agreeing with itself. The algorithm itself
   * is held to AWS's published vectors in `packages/api/test/storage.test.ts`; what this checks
   * is that the terrain store feeds it the right canonical request.
   */
  function expectedSignature(options: {
    secretAccessKey: string;
    accessKeyId: string;
    host: string;
    canonicalUri: string;
    method: string;
    stamp: string;
  }): string {
    const dateStamp = options.stamp.slice(0, 8);
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const query = [
      `X-Amz-Algorithm=AWS4-HMAC-SHA256`,
      `X-Amz-Credential=${encodeURIComponent(`${options.accessKeyId}/${scope}`)}`,
      `X-Amz-Date=${options.stamp}`,
      `X-Amz-Expires=60`,
      `X-Amz-SignedHeaders=host`,
    ].join('&');

    const canonicalRequest = [
      options.method,
      options.canonicalUri,
      query,
      `host:${options.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      options.stamp,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    let key = createHmac('sha256', `AWS4${options.secretAccessKey}`).update(dateStamp).digest();
    for (const part of ['auto', 's3', 'aws4_request']) {
      key = createHmac('sha256', key).update(part).digest();
    }
    return createHmac('sha256', key).update(stringToSign).digest('hex');
  }

  it('signs the canonical request the specification asks for, byte for byte', async () => {
    const at = new Date('2026-08-29T09:15:30.000Z');
    let seen = '';
    const store = r2TerrainStore({
      accountId: 'acct',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      bucket: 'terrain',
      nowImpl: () => at,
      fetchImpl: (async (url: string) => {
        seen = url;
        return pngResponse(TILE);
      }) as unknown as typeof fetch,
    });

    await store.read(13, 4000, 2600, AbortSignal.timeout(5_000));

    const signature = expectedSignature({
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      host: 'acct.r2.cloudflarestorage.com',
      canonicalUri: '/terrain/terrarium/13/4000/2600.png',
      method: 'GET',
      stamp: '20260829T091530Z',
    });
    expect(seen).toContain(`X-Amz-Signature=${signature}`);
  });

  it('signs GET and PUT differently, so a read ticket cannot write', async () => {
    const at = new Date('2026-08-29T09:15:30.000Z');
    const seen: string[] = [];
    const store = r2TerrainStore({
      accountId: 'acct',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'terrain',
      nowImpl: () => at,
      fetchImpl: (async (url: string) => {
        seen.push(url);
        return pngResponse(TILE);
      }) as unknown as typeof fetch,
    });

    await store.read(13, 1, 2, AbortSignal.timeout(5_000));
    await store.write(13, 1, 2, TILE, AbortSignal.timeout(5_000));

    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('refuses a body far too large to be a tile', async () => {
    const store = r2TerrainStore({
      accountId: 'acct',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      bucket: 'terrain',
      fetchImpl: async () =>
        new Response(new Uint8Array(8), {
          status: 200,
          headers: { 'content-length': String(64 * 1024 * 1024) },
        }),
    });

    await expect(store.read(13, 1, 2, AbortSignal.timeout(5_000))).rejects.toThrow(/not a tile/u);
  });
});
