/**
 * Geocoder tests.
 *
 * Two things here are worth protecting with tests rather than comments. The first is the
 * request interval: Nominatim's rate limit is a term of use, and a regression that lets
 * two lookups leave at once is not a slow test, it is a blocked application. The second is
 * the point-bbox widening — a summit's bounding box is metres across, and fitting a map to
 * it literally is the difference between "here is Vesper Peak and its approaches" and a
 * blank grey square at maximum zoom.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NominatimClient } from '../src/geocode';

const AGENT = 'switchback-test/0.1 (https://example.test)';

/** One Nominatim `jsonv2` row, shaped as the real service returns it. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    osm_type: 'node',
    osm_id: 358_802_147,
    lat: '48.0175',
    lon: '-121.4914',
    name: 'Vesper Peak',
    display_name: 'Vesper Peak, Snohomish County, Washington, United States',
    category: 'natural',
    type: 'peak',
    boundingbox: ['47.9975', '48.0375', '-121.5114', '-121.4714'],
    ...overrides,
  };
}

function respondWith(payload: unknown): typeof fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
}

describe('NominatimClient', () => {
  beforeEach(() => {
    delete process.env.NOMINATIM_URL;
  });

  it('refuses to start without an identifying User-Agent', () => {
    expect(() => new NominatimClient({ userAgent: 'switchback' })).toThrow(/contact URL/);
    expect(() => new NominatimClient({ userAgent: AGENT })).not.toThrow();
    expect(() => new NominatimClient({ userAgent: 'trails@example.test' })).not.toThrow();
  });

  it('splits the display name into name and context', async () => {
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl: respondWith([row()]) });
    const [place] = await client.search('vesper peak');

    expect(place).toBeDefined();
    expect(place?.name).toBe('Vesper Peak');
    expect(place?.context).toBe('Snohomish County, Washington, United States');
    expect(place?.kind).toBe('peak');
    expect(place?.id).toBe('node/358802147');
    expect(place?.lat).toBeCloseTo(48.0175, 4);
    expect(place?.lng).toBeCloseTo(-121.4914, 4);
  });

  it('falls back to the leading segment when a result carries no name', async () => {
    const fetchImpl = respondWith([row({ name: undefined })]);
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl });
    const [place] = await client.search('vesper peak');

    expect(place?.name).toBe('Vesper Peak');
    expect(place?.context).toBe('Snohomish County, Washington, United States');
  });

  it('widens a point-sized bbox to something a map can frame', async () => {
    // What Nominatim actually returns for a summit node: a box a few metres across.
    const fetchImpl = respondWith([
      row({ boundingbox: ['48.0174', '48.0176', '-121.4915', '-121.4913'] }),
    ]);
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl });
    const [place] = await client.search('vesper peak');

    const [w, s, e, n] = place?.bbox ?? [0, 0, 0, 0];
    // Not an exact equality: the padding is a subtraction of two doubles around −121°,
    // which lands a few parts in 10^14 under the nominal span. The assertion is about the
    // map being framed, not about float arithmetic.
    expect(e - w).toBeGreaterThan(0.0149);
    expect(n - s).toBeGreaterThan(0.0149);
    // Still centred on the summit, not shifted by the padding.
    expect((w + e) / 2).toBeCloseTo(-121.4914, 3);
    expect((s + n) / 2).toBeCloseTo(48.0175, 3);
  });

  it('leaves a genuinely large bbox alone', async () => {
    const fetchImpl = respondWith([
      row({ type: 'national_park', boundingbox: ['37.4947', '38.1868', '-119.8862', '-119.1983'] }),
    ]);
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl });
    const [place] = await client.search('yosemite');

    expect(place?.bbox).toEqual([-119.8862, 37.4947, -119.1983, 38.1868]);
  });

  it('does not call out for a query too short to mean anything', async () => {
    const fetchImpl = respondWith([row()]);
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl });

    expect(await client.search('v')).toEqual([]);
    expect(await client.search('   ')).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('serves a repeat query from cache without a second request', async () => {
    const fetchImpl = respondWith([row()]);
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl, sleepImpl: async () => {} });

    await client.search('vesper peak');
    await client.search('Vesper Peak'); // same place, different capitalisation

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps at least a second between requests', async () => {
    const slept: number[] = [];
    let clock = 0;
    const fetchImpl = respondWith([row()]);
    const client = new NominatimClient({
      userAgent: AGENT,
      fetchImpl,
      now: () => clock,
      sleepImpl: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });

    // Three distinct queries fired at once — the shape a typeahead produces.
    await Promise.all([client.search('alpha'), client.search('bravo'), client.search('charlie')]);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    // The first goes immediately; each subsequent one waits out the interval.
    expect(slept).toEqual([1_100, 1_100]);
  });

  it('does not wedge the queue when one lookup fails', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new Error('socket hang up');
      return new Response(JSON.stringify([row()]), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl, sleepImpl: async () => {} });

    await expect(client.search('alpha')).rejects.toThrow(/socket hang up/);
    const [place] = await client.search('bravo');
    expect(place?.name).toBe('Vesper Peak');
  });

  it('reports an upstream error rather than pretending there are no results', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch;
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl, sleepImpl: async () => {} });

    await expect(client.search('vesper peak')).rejects.toThrow(/Nominatim 429/);
  });

  it('biases toward the current view without bounding results to it', async () => {
    const fetchImpl = respondWith([row()]);
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl });
    await client.search('bear lake', { near: [-122, 47, -121, 48] });

    // The client passes a `URL`, not a string. Narrowed rather than stringified, so the
    // assertion reads parsed parameters and a change of argument type fails loudly here
    // instead of quietly asserting against "[object Object]".
    const requested = vi.mocked(fetchImpl).mock.calls[0]?.[0];
    expect(requested).toBeInstanceOf(URL);
    const url = requested as URL;
    expect(url.searchParams.get('viewbox')).toBe('-122,47,-121,48');
    expect(url.searchParams.get('bounded')).toBeNull();
    expect(url.searchParams.get('format')).toBe('jsonv2');
  });

  it('drops a zero-area viewbox instead of biasing toward a point', async () => {
    // How this arises in practice: the caller coarsens the map viewport to whole degrees for
    // a stable cache key, and any viewport narrower than a degree — most of them — rounds
    // both corners onto the same integer. Nominatim takes the point seriously and returns
    // nothing, so the gazetteer appears to stop knowing places the moment the map reports
    // where it is looking.
    const fetchImpl = respondWith([row()]);
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl });
    await client.search('vesper peak', { near: [-4, 53, -4, 53] });

    const requested = vi.mocked(fetchImpl).mock.calls[0]?.[0];
    expect(requested).toBeInstanceOf(URL);
    expect((requested as URL).searchParams.get('viewbox')).toBeNull();
  });

  it('sends the identifying User-Agent on every request', async () => {
    const fetchImpl = respondWith([row()]);
    const client = new NominatimClient({ userAgent: AGENT, fetchImpl });
    await client.search('vesper peak');

    const init = vi.mocked(fetchImpl).mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe(AGENT);
  });
});
