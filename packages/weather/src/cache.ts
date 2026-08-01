/**
 * A one-hour memo in front of the forecast. Open-Meteo's models publish hourly, so caching for
 * an hour costs nothing in accuracy and keeps a busy trail page inside the free tier.
 *
 * Two things beyond a plain `Map`: concurrent misses for one key share a single upstream call
 * (a page going busy is when every miss happens at once), and a rejected fetch clears its slot,
 * so an upstream blip does not become an hour of the same error for everyone.
 *
 * In-memory on purpose — on Vercel each instance keeps its own copy. A shared cache is a
 * drop-in later; everything here goes through `fetch`.
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

/** Generic in its value so busyness can memoise its observation buckets and daily outlook too. */
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
    // Re-insert so iteration order is least-recently-used first, which is what `evict` walks.
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
 * The cache key. Start time is floored to the hour because the forecast behind it resolves to
 * the hour. An unspecified start becomes `auto`, not the resolved default, which cannot be
 * computed before the response gives the trail's UTC offset — so an `auto` entry made just
 * before the 07:00 rollover can name yesterday's plan for at most the rest of its hour.
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
