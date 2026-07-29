import type { AlongRouteForecast } from '@switchback/core';
import { describe, expect, it } from 'vitest';
import { ForecastCache, forecastCacheKey } from '../src/cache';

function forecast(trailId = 'trail-1'): AlongRouteForecast {
  return {
    trailId,
    startAt: '2026-07-21T07:00:00+01:00',
    timezone: 'Europe/London',
    paceFactor: 1,
    samples: [],
    flags: [],
    sunriseAt: null,
    sunsetAt: null,
    fetchedAt: '2026-07-20T09:00:00.000Z',
    model: null,
  };
}

function clock(startMs = 0) {
  let ms = startMs;
  return {
    now: () => ms,
    advance: (byMs: number) => {
      ms += byMs;
    },
  };
}

describe('ForecastCache', () => {
  it('returns a stored forecast within the TTL and forgets it after', () => {
    const time = clock();
    const cache = new ForecastCache({ ttlMs: 1000, now: time.now });

    cache.set('k', forecast());
    expect(cache.get('k')).not.toBeNull();

    time.advance(999);
    expect(cache.get('k')).not.toBeNull();

    time.advance(1);
    expect(cache.get('k')).toBeNull();
    expect(cache.size).toBe(0);
  });

  it('collapses concurrent misses into one upstream call', async () => {
    // The case the cache exists for: a trail going busy means every miss arrives at once.
    const cache = new ForecastCache();
    let calls = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const produce = async () => {
      calls++;
      await gate;
      return forecast();
    };

    const all = Promise.all([
      cache.fetch('k', produce),
      cache.fetch('k', produce),
      cache.fetch('k', produce),
    ]);
    release!();
    const results = await all;

    expect(calls).toBe(1);
    expect(results[0]).toBe(results[1]);
    expect(results[1]).toBe(results[2]);
  });

  it('serves later calls from the store without producing again', async () => {
    const cache = new ForecastCache();
    let calls = 0;
    const produce = async () => {
      calls++;
      return forecast();
    };

    await cache.fetch('k', produce);
    await cache.fetch('k', produce);
    expect(calls).toBe(1);
  });

  it('does not cache a failure', async () => {
    // An upstream blip must not become an hour of the same error for everybody.
    const cache = new ForecastCache();
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls === 1) throw new Error('upstream is down');
      return forecast();
    };

    await expect(cache.fetch('k', flaky)).rejects.toThrow('upstream is down');
    await expect(cache.fetch('k', flaky)).resolves.toBeDefined();
    expect(calls).toBe(2);
  });

  it('evicts least-recently-used entries once full', () => {
    const cache = new ForecastCache({ maxEntries: 2 });
    cache.set('a', forecast('a'));
    cache.set('b', forecast('b'));
    // Touching 'a' makes 'b' the oldest.
    expect(cache.get('a')).not.toBeNull();
    cache.set('c', forecast('c'));

    expect(cache.size).toBe(2);
    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('c')).not.toBeNull();
  });

  it('clears', () => {
    const cache = new ForecastCache();
    cache.set('a', forecast());
    cache.clear();
    expect(cache.size).toBe(0);
  });
});

describe('forecastCacheKey', () => {
  // The profile is empty and the length is zero because neither is part of the key: both are
  // properties of the trail, and `trailId` already stands for them. What varies below is only
  // what a *reader* can change about the same trail.
  const base = { trailId: 't1', profile: [], routeType: 'loop', lengthM: 0 } as const;

  it('is stable within an hour of start time', () => {
    const a = forecastCacheKey({ ...base, startAt: '2026-07-21T07:14:00+01:00' });
    const b = forecastCacheKey({ ...base, startAt: '2026-07-21T07:52:00+01:00' });
    expect(a).toBe(b);
  });

  it('separates different hours', () => {
    const a = forecastCacheKey({ ...base, startAt: '2026-07-21T07:00:00+01:00' });
    const b = forecastCacheKey({ ...base, startAt: '2026-07-21T08:00:00+01:00' });
    expect(a).not.toBe(b);
  });

  it('treats the same instant written two ways as one key', () => {
    const a = forecastCacheKey({ ...base, startAt: '2026-07-21T07:00:00+01:00' });
    const b = forecastCacheKey({ ...base, startAt: '2026-07-21T06:00:00Z' });
    expect(a).toBe(b);
  });

  it('separates every input that changes the answer', () => {
    const key = forecastCacheKey({ ...base });
    expect(forecastCacheKey({ ...base, trailId: 't2' })).not.toBe(key);
    expect(forecastCacheKey({ ...base, paceFactor: 1.5 })).not.toBe(key);
    expect(forecastCacheKey({ ...base, includeReturn: false })).not.toBe(key);
    expect(forecastCacheKey({ ...base, sampleCount: 12 })).not.toBe(key);
    expect(forecastCacheKey({ ...base, unitSystem: 'imperial' })).not.toBe(key);
  });

  it('marks an unspecified start rather than resolving it', () => {
    expect(forecastCacheKey({ ...base })).toContain('auto');
    expect(forecastCacheKey({ ...base, startAt: 'nonsense' })).toContain('auto');
  });
});
