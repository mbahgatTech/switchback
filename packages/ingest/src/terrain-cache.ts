/**
 * Second tier for terrarium tiles: shared between processes and outliving them, behind
 * `TerrainSource`'s per-process LRU. Terrarium tiles are immutable, so a stored tile is never
 * stale — this tier has a population problem, not an invalidation one.
 *
 * Every failure answers `unavailable`, which the caller reads as "go to origin". A cache that is
 * down must cost an ingest nothing but its lookup timeout.
 */

import { requestBudgetMs } from './deadline';
import { directoryTerrainStore } from './terrain-cache-dir';
import { r2TerrainStore } from './terrain-cache-r2';

/** What a store found. A store reports one of these or throws; it never reports its own health. */
export type StoredTerrain =
  | { readonly kind: 'tile'; readonly body: Buffer }
  | { readonly kind: 'absent' }
  | { readonly kind: 'miss' };

/**
 * What the tier answers. `absent` is a tile the origin does not have — ocean, or outside the
 * DEM — and is as much an answer as a tile. `unavailable` is the cache itself failing, and the
 * two must never be confused: reading an outage as ocean would publish a sea-level profile.
 */
export type CachedTerrain = StoredTerrain | { readonly kind: 'unavailable' };

export interface TerrainCacheStore {
  /** Which store this is — surfaced so a benchmark and an operator can tell them apart. */
  readonly kind: 'r2' | 'directory';
  read(z: number, x: number, y: number, signal: AbortSignal): Promise<StoredTerrain>;
  /** `null` records that the origin has no tile here. */
  write(z: number, x: number, y: number, body: Buffer | null, signal: AbortSignal): Promise<void>;
}

/**
 * Ceiling on one lookup. A miss pays this before the origin fetch even starts, so it is budgeted
 * against the fetch it replaces rather than against the invocation: a 64 KB GET from an object
 * store that needs longer than this was never going to beat AWS's own CDN.
 */
const DEFAULT_LOOKUP_TIMEOUT_MS = 1_500;

/**
 * Consecutive failures before the tier is skipped outright. A z9 tile's terrain is 256 lookups;
 * an outage retried on every one of them costs more wall clock than the fetches it was meant to
 * save, which is the one way a cache can make ingest slower than having none.
 */
const DEFAULT_FAILURE_LIMIT = 3;

/** How long the tier stays skipped. A passing outage should not cost a whole drain of misses. */
const DEFAULT_RETRY_AFTER_MS = 60_000;

/**
 * Ceiling on one write. Far looser than the lookup, and deliberately: nobody is waiting on a
 * write, so its only job is to stop a stalled socket leaking a promise for the life of the
 * process. Sharing the lookup's budget measured as 7 of 256 tiles silently not stored on a cold
 * pass — the load the cache exists for is exactly the load that made its writes slow.
 */
const DEFAULT_WRITE_TIMEOUT_MS = 30_000;

export interface TerrainCacheOptions {
  lookupTimeoutMs?: number;
  writeTimeoutMs?: number;
  failureLimit?: number;
  retryAfterMs?: number;
  nowImpl?: () => number;
}

/**
 * Policy over a store: one timeout, one breaker, and no exception ever reaching the caller.
 * Separate from the stores so that "what a cache outage costs" is decided in one place and is
 * the same whichever store is configured.
 */
export class TerrainCache {
  private readonly store: TerrainCacheStore;
  private readonly lookupTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly failureLimit: number;
  private readonly retryAfterMs: number;
  private readonly nowImpl: () => number;

  private consecutiveFailures = 0;
  /** When the breaker lets a lookup through again. Zero while it is closed. */
  private skipUntil = 0;

  constructor(store: TerrainCacheStore, options: TerrainCacheOptions = {}) {
    this.store = store;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS;
    this.writeTimeoutMs = options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.failureLimit = Math.max(1, options.failureLimit ?? DEFAULT_FAILURE_LIMIT);
    this.retryAfterMs = options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS;
    this.nowImpl = options.nowImpl ?? Date.now;
  }

  get kind(): string {
    return this.store.kind;
  }

  /**
   * One tile from the shared tier. Never throws, never rejects: an unreachable cache is a miss
   * with a name, not a failure the pipeline has to handle.
   */
  async read(z: number, x: number, y: number, deadlineAt?: number): Promise<CachedTerrain> {
    if (this.nowImpl() < this.skipUntil) return { kind: 'unavailable' };
    try {
      const budget = requestBudgetMs(this.lookupTimeoutMs, deadlineAt, this.nowImpl());
      const found = await this.store.read(z, x, y, AbortSignal.timeout(budget));
      this.consecutiveFailures = 0;
      this.skipUntil = 0;
      return found;
    } catch {
      this.recordFailure();
      return { kind: 'unavailable' };
    }
  }

  /**
   * Record a tile, or `null` for one the origin does not have. Never throws. Failures do not
   * arm the breaker: a bucket that rejects writes but serves reads is still worth reading.
   */
  async write(z: number, x: number, y: number, body: Buffer | null): Promise<void> {
    try {
      await this.store.write(z, x, y, body, AbortSignal.timeout(this.writeTimeoutMs));
    } catch {
      // A cache write is not part of anyone's answer.
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureLimit) {
      this.skipUntil = this.nowImpl() + this.retryAfterMs;
      this.consecutiveFailures = 0;
    }
  }
}

/**
 * The tier this process gets, or `null` for none — which is the deployed default and leaves
 * `TerrainSource` behaving exactly as it does today. R2 wins over a directory when both are
 * configured, so a stray `TERRAIN_CACHE_DIR` cannot quietly take a deployment off the shared tier.
 */
export function terrainCacheFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: TerrainCacheOptions = {},
): TerrainCache | null {
  const store = terrainStoreFromEnv(env);
  return store ? new TerrainCache(store, options) : null;
}

function terrainStoreFromEnv(env: Record<string, string | undefined>): TerrainCacheStore | null {
  const accountId = env.TERRAIN_CACHE_R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.TERRAIN_CACHE_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.TERRAIN_CACHE_R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.TERRAIN_CACHE_R2_BUCKET?.trim();

  if (accountId && accessKeyId && secretAccessKey && bucket) {
    return r2TerrainStore({ accountId, accessKeyId, secretAccessKey, bucket });
  }

  const dir = env.TERRAIN_CACHE_DIR?.trim();
  return dir ? directoryTerrainStore(dir) : null;
}
