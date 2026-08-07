import { describe, expect, it } from 'vitest';
import {
  OVERPASS_STRAIN_MARKER,
  OverpassClient,
  OverpassFatalError,
  OverpassUnavailableError,
  buildFeatureQuery,
  buildRegionQuery,
  buildTileQuery,
} from '../src/overpass';
import type { OverpassOptions } from '../src/overpass';

const UA = 'Switchback/0.1 (+https://switchback.test; test@switchback.test)';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response('busy', { status: code, headers });
}

describe('OverpassClient construction', () => {
  it('refuses a User-Agent with no contact URL', () => {
    // The whole product goes dark if an instance blocks us, and an anonymous UA is the
    // first thing operators block. Failing at construction is the only place this is
    // cheap to notice.
    expect(() => new OverpassClient({ userAgent: 'node-fetch' })).toThrow(/contact URL/);
    expect(() => new OverpassClient({})).toThrow(/contact URL/);
    expect(() => new OverpassClient({ userAgent: UA })).not.toThrow();
  });

  it('refuses a contact address that does not reach us', () => {
    // Not hypothetical. `contact@example.com` shipped in .env and overpass-api.de answered
    // every single tile with `406 Not Acceptable` — an Apache content-negotiation page that
    // says nothing about the User-Agent. This check is what turns that into a startup
    // error naming the actual cause.
    expect(
      () => new OverpassClient({ userAgent: 'Switchback/0.1 (+https://example.com)' }),
    ).toThrow(/names "example\.com"/);
    expect(
      () =>
        new OverpassClient({
          userAgent: 'Switchback/0.1 (+https://switchback.test; a@example.org)',
        }),
    ).toThrow(/does not reach this project/);
    expect(
      () => new OverpassClient({ userAgent: 'Switchback/0.1 (+http://localhost:3000)' }),
    ).toThrow(/does not reach this project/);
  });

  it('refuses switchback.app, which is somebody else and was deployed once', () => {
    // The value that reached the Function App and every Overpass request it made. It passes
    // every shape rule — real-looking host, no placeholder, a URL — and resolves to an
    // unrelated third party, so an operator who followed it reached a stranger. The only way
    // a constructor can catch this class is by name.
    expect(
      () => new OverpassClient({ userAgent: 'Switchback/0.1 (+https://switchback.app)' }),
    ).toThrow(/names "switchback\.app"/);
    expect(
      () =>
        new OverpassClient({
          userAgent: 'Switchback/0.1 (+https://switchback-three.vercel.app/attribution)',
        }),
    ).not.toThrow();
  });

  it('explains a 406 where the operator will read it', () => {
    // `ingest_tiles.lastError` is the only place this surfaces, so the hint has to be in
    // the message rather than only in the docs.
    const client = new OverpassClient({
      userAgent: UA,
      maxAttempts: 1,
      fetchImpl: () =>
        Promise.resolve(new Response('<html>Not Acceptable</html>', { status: 406 })),
    });
    return expect(client.query('out count;')).rejects.toThrow(/OVERPASS_USER_AGENT/);
  });
});

describe('OverpassClient rate limiting', () => {
  it('never exceeds maxConcurrent, however many callers pile in', async () => {
    // The plan's rate-limit gate: 50 concurrent cold-tile requests, ≤2 concurrent calls.
    let inFlight = 0;
    let peak = 0;

    const client = new OverpassClient({
      userAgent: UA,
      maxConcurrent: 2,
      fetchImpl: (async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return ok({ elements: [] });
      }) as unknown as typeof fetch,
    });

    await Promise.all(Array.from({ length: 50 }, () => client.query('[out:json];')));

    expect(peak).toBe(2);
    expect(client.inFlight).toBe(0);
    expect(client.queueDepth).toBe(0);
  });
});

describe('OverpassClient backoff', () => {
  // Pinned to a single mirror throughout. Backoff and failover are two answers to the same
  // question — "that did not work, now what" — and a client with three mirrors reaches for
  // the second one before it ever reaches for the clock. These cases are about the clock.
  const ONLY = 'https://overpass.test/api/interpreter';

  it('retries a 429 and honours Retry-After over its own schedule', async () => {
    const sleeps: number[] = [];
    let calls = 0;

    const client = new OverpassClient({
      url: ONLY,
      userAgent: UA,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: (async () => {
        calls += 1;
        return calls === 1 ? status(429, { 'retry-after': '7' }) : ok({ elements: [] });
      }) as unknown as typeof fetch,
    });

    await client.query('[out:json];');

    expect(calls).toBe(2);
    expect(sleeps).toEqual([7000]);
  });

  it('jitters its own backoff rather than retrying in lockstep', async () => {
    const sleeps: number[] = [];
    const client = new OverpassClient({
      url: ONLY,
      userAgent: UA,
      baseBackoffMs: 1000,
      maxAttempts: 4,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: (async () => status(504)) as unknown as typeof fetch,
    });

    await expect(client.query('[out:json];')).rejects.toThrow();

    // Full jitter: each wait lands in [ceiling/2, ceiling] for that attempt.
    expect(sleeps).toHaveLength(3);
    expect(sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(sleeps[0]).toBeLessThanOrEqual(1000);
    expect(sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(sleeps[1]).toBeLessThanOrEqual(2000);
  });

  it('does not retry a 400 — a broken query stays broken', async () => {
    let calls = 0;
    const client = new OverpassClient({
      url: ONLY,
      userAgent: UA,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return status(400);
      }) as unknown as typeof fetch,
    });

    await expect(client.query('nonsense')).rejects.toBeInstanceOf(OverpassFatalError);
    expect(calls).toBe(1);
  });

  it('stops retrying once maxTotalMs is spent, whatever maxAttempts says', async () => {
    // Why the option exists: on the defaults one query can spend ~24 minutes across six
    // attempts, and the Functions Consumption host kills the invocation at ten. The attempt
    // count is the wrong unit — wall clock is the one the host measures in.
    let now = 0;
    let calls = 0;

    const client = new OverpassClient({
      url: ONLY,
      userAgent: UA,
      maxAttempts: 6,
      requestTimeoutMs: 60_000,
      maxTotalMs: 150_000,
      now: () => now,
      // Both a request and a backoff advance the clock the caller is being charged for.
      sleepImpl: async (ms) => {
        now += ms;
      },
      fetchImpl: (async () => {
        calls += 1;
        now += 60_000;
        return status(504);
      }) as unknown as typeof fetch,
    });

    await expect(client.query('[out:json];')).rejects.toThrow();

    // Three requests would already be 180 s. It gives up inside the budget instead.
    expect(calls).toBeLessThanOrEqual(3);
    expect(now).toBeLessThanOrEqual(210_000);
  });

  it('leaves the budget unset by default, so nothing else changes shape', async () => {
    let calls = 0;
    const client = new OverpassClient({
      url: ONLY,
      userAgent: UA,
      maxAttempts: 4,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        calls += 1;
        return status(504);
      }) as unknown as typeof fetch,
    });

    await expect(client.query('[out:json];')).rejects.toThrow();
    expect(calls).toBe(4);
  });

  it('holds the abort open across the body, not only to the first byte', async () => {
    // `fetch` resolves at the headers. Clearing the timeout there leaves the download with no
    // ceiling and no live signal, and `buildRouteQuery` permits `[maxsize:1073741824]` — so a
    // mirror answering instantly and then dribbling is unbounded wall clock on a host that
    // kills the process at ten minutes. A regression here does not fail this assertion, it
    // hangs: nothing would ever abort the read.
    let abortedMidBody = false;

    const client = new OverpassClient({
      url: ONLY,
      userAgent: UA,
      maxAttempts: 1,
      requestTimeoutMs: 50,
      sleepImpl: async () => {},
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const signal = init.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              // A plausible beginning, and then nothing — as a stalled transfer looks.
              controller.enqueue(new TextEncoder().encode('{"elements":['));
              signal?.addEventListener('abort', () => {
                abortedMidBody = true;
                controller.error(new DOMException('aborted', 'AbortError'));
              });
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as unknown as typeof fetch,
    });

    await expect(client.query('[out:json];')).rejects.toThrow();
    expect(abortedMidBody).toBe(true);
  }, 5_000);
});

describe('OverpassClient mirror failover', () => {
  const MIRRORS = ['https://a.test/api', 'https://b.test/api', 'https://c.test/api'];

  /** A fetch stub that records the endpoint of every call and answers per-host. */
  function recording(answer: (url: string) => Response | Promise<Response>): {
    fetchImpl: typeof fetch;
    calls: string[];
  } {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return answer(url);
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('moves to the next mirror when one refuses the connection', async () => {
    // The case this exists for. An IP-level block from a public instance arrives as a TCP
    // reset — no status, no body, nothing a retry against the same host will get past.
    const { fetchImpl, calls } = recording((url) => {
      if (url.startsWith('https://a.')) throw new TypeError('fetch failed');
      return ok({ elements: [{ type: 'node', id: 1 }] });
    });

    const client = new OverpassClient({ url: MIRRORS, userAgent: UA, fetchImpl });
    const body = await client.query('[out:json];');

    expect(body.elements).toHaveLength(1);
    expect(calls).toEqual(['https://a.test/api', 'https://b.test/api']);
  });

  it('does not sleep on the way to a mirror it has not tried', async () => {
    // A different machine owes us nothing. Waiting before asking it costs the user the
    // latency of a service that was never the one having trouble.
    const sleeps: number[] = [];
    const { fetchImpl } = recording((url) =>
      url.startsWith('https://c.') ? ok({ elements: [] }) : status(504),
    );

    const client = new OverpassClient({
      url: MIRRORS,
      userAgent: UA,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl,
    });

    await client.query('[out:json];');
    expect(sleeps).toEqual([]);
  });

  it('starts backing off once the rotation wraps onto a host it has already annoyed', async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = recording(() => status(504));

    const client = new OverpassClient({
      url: MIRRORS,
      userAgent: UA,
      maxAttempts: 5,
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl,
    });

    await expect(client.query('[out:json];')).rejects.toThrow();

    // Five attempts across three mirrors: two free rotations, then a wait before each
    // repeat visit. The last attempt has nothing after it to wait for.
    expect(calls).toHaveLength(5);
    expect(sleeps).toHaveLength(2);
  });

  it('stays on the mirror that worked instead of retrying the dead one every time', async () => {
    // The cursor is client state, not per-call state. Otherwise a dead primary costs one
    // wasted round trip per tile, forever.
    const { fetchImpl, calls } = recording((url) => {
      if (url.startsWith('https://a.')) throw new TypeError('fetch failed');
      return ok({ elements: [] });
    });

    const client = new OverpassClient({ url: MIRRORS, userAgent: UA, fetchImpl });
    await client.query('[out:json];');
    await client.query('[out:json];');
    await client.query('[out:json];');

    expect(calls.filter((url) => url.startsWith('https://a.'))).toHaveLength(1);
    expect(calls.filter((url) => url.startsWith('https://b.'))).toHaveLength(3);
  });

  it('names the mirror in the error, so the next person does not have to guess', async () => {
    const { fetchImpl } = recording(() => {
      throw new TypeError('fetch failed');
    });
    const client = new OverpassClient({
      url: ['https://a.test/api'],
      userAgent: UA,
      maxAttempts: 1,
      fetchImpl,
    });

    await expect(client.query('[out:json];')).rejects.toThrow(/a\.test/);
  });

  it('does not shop a broken query around every mirror in turn', async () => {
    // Every instance runs the same Overpass. A 400 is ours, and asking three services to
    // reject it is three services with a reason to remember us.
    const { fetchImpl, calls } = recording(() => status(400));
    const client = new OverpassClient({ url: MIRRORS, userAgent: UA, fetchImpl });

    await expect(client.query('nonsense')).rejects.toBeInstanceOf(OverpassFatalError);
    expect(calls).toHaveLength(1);
  });

  it('falls back to the built-in mirrors when the variable is blank', () => {
    const mirrors = new OverpassClient({ url: [], userAgent: UA }).mirrors;
    expect(mirrors.length).toBeGreaterThan(1);
    // Distinct *hosts*, not distinct URLs. The list once read as three mirrors and was two
    // machines — `overpass.kumi.systems` and `overpass.private.coffee` share an IP — which
    // is the same outage three times over rather than a rotation.
    const hosts = new Set(mirrors.map((url) => new URL(url).host));
    expect(hosts.size).toBe(mirrors.length);
    // A single string is still a list of one — nothing that set OVERPASS_URL needs to change.
    expect(new OverpassClient({ url: 'https://one.test/api', userAgent: UA }).mirrors).toEqual([
      'https://one.test/api',
    ]);
  });
});

describe('OverpassClient circuit breaker', () => {
  it('opens after repeated failure and half-opens after the window', async () => {
    let clock = 1_000_000;
    const client = new OverpassClient({
      userAgent: UA,
      maxAttempts: 1,
      failureThreshold: 2,
      openMs: 60_000,
      sleepImpl: async () => {},
      now: () => clock,
      fetchImpl: (async () => status(503)) as unknown as typeof fetch,
    });

    await expect(client.query('[out:json];')).rejects.toThrow();
    expect(client.breakerState).toBe('closed');
    await expect(client.query('[out:json];')).rejects.toThrow();
    expect(client.breakerState).toBe('open');

    // While open, callers fail fast with the "serve cache" signal — no request is made.
    await expect(client.query('[out:json];')).rejects.toBeInstanceOf(OverpassUnavailableError);

    clock += 61_000;
    // Half-open: the probe is allowed out, and its failure re-opens the breaker.
    await expect(client.query('[out:json];')).rejects.not.toBeInstanceOf(OverpassUnavailableError);
  });
});

/**
 * Etiquette is a correctness requirement here — the failure mode is an IP block that takes the
 * product down — and this client made no `console` call at all, so a retried 429, a mirror
 * failover and a breaker moving left no record on either drainer. What is asserted is the marker
 * and that each event produces a line, not the wording after it.
 */
describe('OverpassClient strain reporting', () => {
  const ONLY = 'https://overpass.test/api/interpreter';

  function reporting(fetchImpl: typeof fetch, overrides: Partial<OverpassOptions> = {}) {
    const lines: string[] = [];
    const client = new OverpassClient({
      url: ONLY,
      userAgent: UA,
      sleepImpl: async () => {},
      logImpl: (line) => lines.push(line),
      fetchImpl,
      ...overrides,
    });
    return { client, strain: () => lines.filter((line) => line.includes(OVERPASS_STRAIN_MARKER)) };
  }

  it('reports a rate limit that the retry then absorbs', async () => {
    let calls = 0;
    const { client, strain } = reporting(async () => {
      calls += 1;
      return calls === 1 ? status(429, { 'retry-after': '3' }) : ok({ elements: [] });
    });

    await client.query('[out:json];');

    // The event a successful retry hides: nothing reaches `ingest_jobs.lastError`, so without
    // this line the only record of a mirror refusing is that nothing appeared to go wrong.
    expect(strain()).toHaveLength(1);
    expect(strain()[0]).toContain('status=429');
    expect(strain()[0]).toContain('retryAfter=3');
  });

  it('reports a transport failure, which carries no status to read', async () => {
    let calls = 0;
    const { client, strain } = reporting(async () => {
      calls += 1;
      if (calls === 1) throw new Error('ECONNRESET');
      return ok({ elements: [] });
    });

    await client.query('[out:json];');

    expect(strain()).toHaveLength(1);
    expect(strain()[0]).toContain('transport');
    expect(strain()[0]).toContain('ECONNRESET');
  });

  it('reports the breaker opening, half-opening and closing', async () => {
    let refuse = true;
    const { client, strain } = reporting(
      async () => (refuse ? status(503) : ok({ elements: [] })),
      { failureThreshold: 1, maxAttempts: 1, openMs: 0 },
    );

    await expect(client.query('[out:json];')).rejects.toThrow();
    expect(client.breakerState).toBe('open');
    expect(strain().some((line) => line.includes('breaker=open'))).toBe(true);

    refuse = false;
    await client.query('[out:json];');

    expect(client.breakerState).toBe('closed');
    expect(strain().some((line) => line.includes('breaker=half-open'))).toBe(true);
    expect(strain().some((line) => line.includes('breaker=closed'))).toBe(true);
  });

  /*
   * A probe that fails re-opens the breaker at once rather than spending `failureThreshold` more
   * requests against a service that has just refused one — which is the etiquette rule the breaker
   * exists to keep, and what the half-open path has always claimed to do.
   */
  it('re-opens on a failed probe rather than counting up to the threshold again', async () => {
    const { client } = reporting(async () => status(503), {
      failureThreshold: 3,
      maxAttempts: 1,
      openMs: 0,
    });

    for (let i = 0; i < 3; i += 1) await expect(client.query('[out:json];')).rejects.toThrow();
    expect(client.breakerState).toBe('open');

    // The probe. Without the re-open it would take two more refusals to shut again.
    await expect(client.query('[out:json];')).rejects.toThrow();
    expect(client.breakerState).toBe('open');
  });
});

describe('query builders', () => {
  it('emits Overpass bbox order, not GeoJSON order', () => {
    // [west, south, east, north] in, (south, west, north, east) out. Getting this wrong
    // returns trails from the wrong continent, silently.
    const ql = buildTileQuery([-5.5, 56.7, -4.9, 56.9]);
    expect(ql).toContain('(56.7,-5.5,56.9,-4.9)');
  });

  it('asks for both route relations and named path ways', () => {
    const ql = buildTileQuery([0, 0, 1, 1]);
    expect(ql).toMatch(/relation\["route"~/);
    expect(ql).toMatch(/way\["highway"~.*\]\["name"\]/);
  });

  it('uses a verbosity that keeps relation members', () => {
    // Regression, and an expensive one. `out` takes a verbosity *and* a geometry mode, and
    // `tags` is a verbosity meaning "ids and tags, nothing else" — it drops the `members`
    // array. `out geom tags` therefore reads as "geometry and tags" and delivers relations
    // with zero members, so every route relation is skipped as having nothing to assemble
    // while named standalone ways keep arriving and the tile looks healthy. Symptom in the
    // product: the Pacific Crest Trail stored as a single 61 km member way.
    const ql = buildTileQuery([0, 0, 1, 1]);
    expect(ql).toContain('out body geom;');
    expect(ql).not.toMatch(/out\s+(geom\s+)?tags\s*;/);
  });

  it('guards the server with timeout and maxsize', () => {
    const ql = buildTileQuery([0, 0, 1, 1]);
    expect(ql).toContain('[timeout:180]');
    expect(ql).toContain('[maxsize:536870912]');
  });

  it('asks for centres on the feature query, since amenities can be areas', () => {
    expect(buildFeatureQuery([0, 0, 1, 1])).toContain('out center tags;');
  });

  it('fetches the destination features the display name is derived from', () => {
    const ql = buildFeatureQuery([0, 0, 1, 1]);
    expect(ql).toContain('peak|hill|saddle');
    expect(ql).toContain('node["mountain_pass"="yes"]');
    // Named only: an unnamed icefield can name no hike, and glaciers are large queries.
    expect(ql).toContain('way["natural"="glacier"]["name"]');
  });

  it('builds an is_in region query in lat,lng order', () => {
    expect(buildRegionQuery([-4.5, 56.8])).toContain('is_in(56.8,-4.5)');
  });
});
