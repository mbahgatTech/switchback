/**
 * A one-hour memo in front of the forecast.
 *
 * The weather strip renders on every trail page view, so a trail on the front page would
 * otherwise spend one upstream call per visitor for data that does not change between them.
 * Open-Meteo's free tier is 10,000 calls a day and its models publish hourly; caching for an
 * hour costs nothing in accuracy and is the difference between this feature fitting in the
 * free tier and not.
 *
 * Two things this does beyond a plain `Map`:
 *
 * - **Single flight.** Ten concurrent requests for a cold trail share one upstream call.
 *   Without this the cache is useless in exactly the case it exists for — a page going busy
 *   is when every miss happens at once.
 * - **Failures are not cached.** A rejected fetch clears its slot, so an upstream blip does
 *   not become an hour of the same error for everyone.
 *
 * Deliberately in-memory. On Vercel each instance keeps its own copy, which means a modest
 * multiplier on cold calls rather than a shared cache — the right trade against introducing
 * a KV store for data that is worthless in sixty minutes. A shared cache is a drop-in later:
 * everything here goes through `fetch`.
 */

import type { AlongRouteForecast } from '@switchback/core';
import type { AlongRouteInput } from './along-route';
import { HOUR_S } from './time';

export const FORECAST_TTL_MS = 60 * 60 * 1000;

export interface ForecastCacheOptions {
  ttlMs?: number;
  /** Bounded so a crawler hiking every trail cannot grow this without limit. */
  maxEntries?: number;
  /** Epoch milliseconds. Injected in tests. */
  now?: () => number;
}

interface Entry<T> {
  value: T;
  expiresAtMs: number;
}

/**
 * Generic in its value so busyness can reuse it.
 *
 * The busyness forecast is a pure computation and needs no cache of its own — but it reads
 * a week of observation buckets and a daily outlook to produce one, and those are exactly
 * as worth memoising as a weather call. Defaulting the parameter keeps every existing
 * `new ForecastCache()` meaning what it meant.
 */
export class ForecastCache<T = AlongRouteForecast> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inFlight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: ForecastCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? FORECAST_TTL_MS;
    this.maxEntries = Math.max(1, options.maxEntries ?? 500);
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    // Re-insert so iteration order is least-recently-used first, which is what `evict` hikes.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAtMs: this.now() + this.ttlMs });
    this.evict();
  }

  async fetch(key: string, produce: () => Promise<T>): Promise<T> {
    const hit = this.get(key);
    if (hit) return hit;

    const pending = this.inFlight.get(key);
    if (pending) return pending;

    const promise = produce()
      .then((value) => {
        this.set(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * The cache key.
 *
 * Start time is floored to the hour because the forecast behind it resolves to the hour:
 * 07:14 and 07:52 read the same model values, so keying on the minute would be a guaranteed
 * miss for an identical answer.
 *
 * An unspecified start becomes `auto` rather than the resolved default, since the default
 * cannot be computed before the response tells us the trail's UTC offset. That default rolls
 * over at 07:00 local, so an `auto` entry made just before the rollover can name yesterday's
 * plan for at most the rest of its hour. Bounded, and the alternative is not caching the
 * common case at all.
 */
export function forecastCacheKey(input: AlongRouteInput): string {
  const startS = input.startAt ? Math.floor(Date.parse(input.startAt) / 1000) : null;
  const startKey =
    startS === null || !Number.isFinite(startS)
      ? 'auto'
      : String(Math.floor(startS / HOUR_S) * HOUR_S);

  return [
    input.trailId,
    startKey,
    (input.paceFactor ?? 1).toFixed(2),
    input.includeReturn === false ? 'one-way' : 'return',
    input.sampleCount ?? 'default',
    input.unitSystem ?? 'metric',
  ].join('|');
}
