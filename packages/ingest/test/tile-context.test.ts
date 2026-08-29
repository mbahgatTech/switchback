import { describe, expect, it } from 'vitest';
import { OverpassClient, OverpassDeadlineError, withDeadline } from '../src/overpass';
import type { OverpassElement, OverpassResponse } from '../src/overpass';
import { fetchTileContext, pickRegion } from '../src/tile-context';
import type { BBox } from '@switchback/core';

const QUADKEY = '023110211';
const BBOX: BBox = [-4.5, 56.7, -3.8, 57.0];

const HIGHLAND: OverpassElement = {
  type: 'area',
  id: 6,
  tags: { admin_level: '6', name: 'Highland' },
};
const BEN_NEVIS: OverpassElement = {
  type: 'node',
  id: 1,
  lat: 56.8,
  lon: -5.0,
  tags: { natural: 'peak', name: 'Ben Nevis' },
};

/** Which of the two lookups a query is, read off the shape each builder emits. */
function kindOf(ql: string): 'region' | 'features' {
  return ql.includes('is_in(') ? 'region' : 'features';
}

/** A promise the test settles by hand, so both lookups can be held in flight at once. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('fetchTileContext', () => {
  it('returns the region and the waypoints the tile asked for', async () => {
    const overpass = {
      query: (ql: string) =>
        Promise.resolve({ elements: kindOf(ql) === 'region' ? [HIGHLAND] : [BEN_NEVIS] }),
    };

    const context = await fetchTileContext(QUADKEY, BBOX, { overpass });

    expect(context.region).toEqual({ regionName: 'Highland', countryCode: null });
    expect(context.features).toEqual([BEN_NEVIS]);
  });

  it('sends both lookups before either has answered', async () => {
    // Neither lookup reads the other's answer, so a shape that waits for the first before
    // sending the second spends a whole Overpass round trip of the path to the first trail.
    const region = deferred<OverpassResponse>();
    const features = deferred<OverpassResponse>();
    const sent: string[] = [];
    const overpass = {
      query: (ql: string) => {
        const kind = kindOf(ql);
        sent.push(kind);
        return kind === 'region' ? region.promise : features.promise;
      },
    };

    const context = fetchTileContext(QUADKEY, BBOX, { overpass });
    expect(sent).toEqual(['region', 'features']);

    region.resolve({ elements: [HIGHLAND] });
    features.resolve({ elements: [BEN_NEVIS] });
    await expect(context).resolves.toEqual({
      region: { regionName: 'Highland', countryCode: null },
      features: [BEN_NEVIS],
    });
  });

  it('never takes a slot the shared client has not granted', async () => {
    /*
     * Overlapping the lookups is safe only while the client's semaphore decides how many run.
     * Pinned at `maxConcurrent: 1`, the setting where honouring the queue and ignoring it differ.
     * Both halves are counted as well as timed, because a lookup that opened its own client
     * would leave this one's queue looking impeccably well behaved and half its traffic unseen.
     */
    const served: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const client = new OverpassClient({
      url: 'https://overpass.test/api/interpreter',
      userAgent: 'Switchback/test (+https://switchback-three.vercel.app/attribution)',
      maxConcurrent: 1,
      fetchImpl: async (_input, init) => {
        const body = typeof init?.body === 'string' ? init.body : '';
        served.push(body.includes('is_in') ? 'region' : 'features');
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      },
    });

    await fetchTileContext(QUADKEY, BBOX, { overpass: client });

    expect([...served].sort()).toEqual(['features', 'region']);
    expect(peak).toBe(1);
    expect(client.inFlight).toBe(0);
  });

  it('sends no waypoint query at all when enrichment is off', async () => {
    const sent: string[] = [];
    const overpass = {
      query: (ql: string) => {
        sent.push(kindOf(ql));
        return Promise.resolve({ elements: [HIGHLAND] });
      },
    };

    const context = await fetchTileContext(QUADKEY, BBOX, { overpass, enrichWaypoints: false });

    expect(sent).toEqual(['region']);
    expect(context.features).toEqual([]);
  });

  it('keeps the waypoints when the region lookup fails in flight', async () => {
    // Sharing a window must not mean sharing a fate: both halves fail soft, independently.
    const region = deferred<OverpassResponse>();
    const features = deferred<OverpassResponse>();
    const logged: string[] = [];
    const overpass = {
      query: (ql: string) => (kindOf(ql) === 'region' ? region.promise : features.promise),
    };

    const context = fetchTileContext(QUADKEY, BBOX, {
      overpass,
      logger: (message) => logged.push(message),
    });
    region.reject(new Error('mirror said 504'));
    features.resolve({ elements: [BEN_NEVIS] });

    await expect(context).resolves.toEqual({
      region: { regionName: null, countryCode: null },
      features: [BEN_NEVIS],
    });
    expect(logged.join()).toContain('switchback-ingest-overpass-skipped');
  });

  it('keeps the region when the waypoint lookup fails in flight', async () => {
    const region = deferred<OverpassResponse>();
    const features = deferred<OverpassResponse>();
    const overpass = {
      query: (ql: string) => (kindOf(ql) === 'region' ? region.promise : features.promise),
    };

    const context = fetchTileContext(QUADKEY, BBOX, { overpass });
    features.reject(new Error('mirror said 429'));
    region.resolve({ elements: [HIGHLAND] });

    await expect(context).resolves.toEqual({
      region: { regionName: 'Highland', countryCode: null },
      features: [],
    });
  });

  it('gives the tile an empty context rather than throwing once the deadline has passed', async () => {
    /*
     * A budget that refuses these two is the good outcome — the tile still commits its trails,
     * without a region name and without waypoints — so the refusal has to arrive as data, and
     * be countable in the log rather than silent.
     */
    let queried = 0;
    const overpass = withDeadline(
      {
        query: () => {
          queried += 1;
          return Promise.resolve({ elements: [] });
        },
      },
      Date.now() - 1,
    );
    const logged: string[] = [];

    const context = await fetchTileContext(QUADKEY, BBOX, {
      overpass,
      logger: (message) => logged.push(message),
    });

    expect(queried).toBe(0);
    expect(context).toEqual({ region: { regionName: null, countryCode: null }, features: [] });
    expect(
      logged.filter((line) => line.includes('switchback-ingest-overpass-skipped')),
    ).toHaveLength(2);
  });

  it('survives a deadline that expires while both lookups are already in flight', async () => {
    const region = deferred<OverpassResponse>();
    const features = deferred<OverpassResponse>();
    const overpass = {
      query: (ql: string) => (kindOf(ql) === 'region' ? region.promise : features.promise),
    };

    const context = fetchTileContext(QUADKEY, BBOX, { overpass });
    region.reject(new OverpassDeadlineError(1_200));
    features.reject(new OverpassDeadlineError(1_200));

    await expect(context).resolves.toEqual({
      region: { regionName: null, countryCode: null },
      features: [],
    });
  });
});

describe('pickRegion', () => {
  const area = (level: string, tags: Record<string, string>): OverpassElement => ({
    type: 'area',
    id: Number(level),
    tags: { admin_level: level, ...tags },
  });

  it('prefers the most local administrative name', () => {
    // "Highland" tells a reader more about a trail card than "Scotland" or "United Kingdom".
    const region = pickRegion([
      area('2', { name: 'United Kingdom', 'ISO3166-1:alpha2': 'gb' }),
      area('4', { name: 'Scotland' }),
      area('6', { name: 'Highland' }),
    ]);
    expect(region.regionName).toBe('Highland');
    expect(region.countryCode).toBe('GB');
  });

  it('falls back up the hierarchy when the local level is missing', () => {
    const region = pickRegion([
      area('2', { name: 'France', 'ISO3166-1': 'fr' }),
      area('4', { name: 'Occitanie' }),
    ]);
    expect(region.regionName).toBe('Occitanie');
    expect(region.countryCode).toBe('FR');
  });

  it('never uses the country as a region name', () => {
    const region = pickRegion([area('2', { name: 'Norway', 'ISO3166-1:alpha2': 'NO' })]);
    expect(region.regionName).toBeNull();
    expect(region.countryCode).toBe('NO');
  });

  it('prefers the English name where one is tagged', () => {
    const region = pickRegion([area('6', { name: 'Sør-Trøndelag', 'name:en': 'South Trondelag' })]);
    expect(region.regionName).toBe('South Trondelag');
  });

  it('ignores elements without a usable admin level', () => {
    const region = pickRegion([
      { type: 'area', id: 1, tags: { name: 'Somewhere' } },
      { type: 'area', id: 2 },
      area('x', { name: 'Nonsense' }),
    ]);
    expect(region).toEqual({ regionName: null, countryCode: null });
  });

  it('rejects a country code that is not two letters', () => {
    const region = pickRegion([area('2', { name: 'X', 'ISO3166-1:alpha2': 'GBR' })]);
    expect(region.countryCode).toBeNull();
  });

  it('returns nulls for an empty response, because a region is optional', () => {
    expect(pickRegion([])).toEqual({ regionName: null, countryCode: null });
  });
});
