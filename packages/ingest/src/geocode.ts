/**
 * Place-name search: a name resolves to a location, the location drives the map, and the map
 * drives ingest — which is how someone reaches ground we have never fetched.
 *
 * **Nominatim's usage policy is a hard constraint.** One machine serves the whole OSM
 * ecosystem: absolute maximum one request per second, a User-Agent that identifies the
 * application, no bulk geocoding, cache what you get. All four are enforced below rather than
 * documented. `NOMINATIM_URL` is the only thing that changes when you self-host.
 */

import type { BBox } from '@switchback/core';

/** One search result: somewhere a person could mean. */
export interface GeocodedPlace {
  /** `node/12345` — stable, and distinct from any trail id. */
  id: string;
  /** The name alone: "Vesper Peak". */
  name: string;
  /** Everything after the name: "Snohomish County, Washington, United States". */
  context: string;
  lng: number;
  lat: number;
  /**
   * What the map should show to frame it. Nominatim gives a real extent for areas and a
   * point-sized box for nodes — see `MIN_FRAME_DEG`, which makes the point case viewable.
   */
  bbox: BBox;
  /** OSM's own classification: `peak`, `national_park`, `city`, `water`. */
  kind: string;
}

export interface GeocodeOptions {
  url?: string;
  userAgent?: string;
  /** Bias results toward here without excluding anywhere else. */
  near?: BBox;
  limit?: number;
  signal?: AbortSignal;
}

const DEFAULT_URL = 'https://nominatim.openstreetmap.org/search';

/**
 * The floor on request spacing. The policy says one per second; the headroom keeps clock skew
 * and a slow hop from making that 1.02 per second as measured at their end.
 */
const MIN_INTERVAL_MS = 1_100;

/** How long a resolved place stays good. Mountains do not move. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Entries kept before the oldest are dropped. Small: this is a typo cache, not a corpus. */
const CACHE_MAX = 500;

/**
 * The smallest span a result's bbox may have, in degrees — about 1.6 km. A summit is a node
 * whose Nominatim box is metres across, and fitting the map to that literally is a camera at
 * z22 pointed at a rock. This puts the peak in a view that shows the approaches.
 */
const MIN_FRAME_DEG = 0.015;

interface CacheEntry {
  at: number;
  places: GeocodedPlace[];
}

interface NominatimResult {
  osm_type?: string;
  osm_id?: number;
  name?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  type?: string;
  category?: string;
  boundingbox?: [string, string, string, string];
}

export class NominatimClient {
  private readonly url: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly cache = new Map<string, CacheEntry>();

  /** The tail of the request chain. Every call awaits it, then becomes it. */
  private queue: Promise<void> = Promise.resolve();
  /** When the last request left. `-Infinity` so the first lookup is immediate by construction. */
  private lastRequestAt = Number.NEGATIVE_INFINITY;

  constructor(
    options: {
      url?: string;
      userAgent?: string;
      fetchImpl?: typeof fetch;
      now?: () => number;
      /** Injectable so a test can assert the interval without waiting it out. */
      sleepImpl?: (ms: number) => Promise<void>;
    } = {},
  ) {
    this.url = options.url || process.env.NOMINATIM_URL || DEFAULT_URL;
    this.userAgent = options.userAgent ?? process.env.OVERPASS_USER_AGENT ?? '';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleepImpl =
      options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

    // An anonymous User-Agent is what gets an application blocked, and the block arrives as
    // empty results rather than as an error. Failing here is the only cheap place to notice.
    if (!/https?:\/\/|@/.test(this.userAgent)) {
      throw new Error(
        'NominatimClient: OVERPASS_USER_AGENT must include a contact URL or email — ' +
          'Nominatim blocks unidentified clients and the block looks like "no results".',
      );
    }
  }

  async search(query: string, options: GeocodeOptions = {}): Promise<GeocodedPlace[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    const limit = Math.min(Math.max(options.limit ?? 5, 1), 10);
    const key = `${q.toLowerCase()}|${limit}|${options.near?.map((v) => v.toFixed(1)).join(',') ?? ''}`;

    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_TTL_MS) return hit.places;

    const places = await this.enqueue(() => this.fetchSearch(q, limit, options));

    this.cache.set(key, { at: this.now(), places });
    if (this.cache.size > CACHE_MAX) {
      // Insertion-ordered, so the first key is the oldest. Not an LRU, deliberately — a cache
      // this small does not repay the bookkeeping.
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return places;
  }

  /**
   * Run `task` after everything already queued, and never sooner than `MIN_INTERVAL_MS` after
   * the previous request left. Serialised rather than rate-bucketed because the policy is
   * about the interval: two requests 50 ms apart then two seconds of quiet averages one per
   * second and still violates the rule.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const wait = this.lastRequestAt + MIN_INTERVAL_MS - this.now();
      if (wait > 0) await this.sleepImpl(wait);
      this.lastRequestAt = this.now();
      return task();
    });
    // The chain must survive a rejected task, or one failed lookup wedges every later one.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async fetchSearch(
    q: string,
    limit: number,
    options: GeocodeOptions,
  ): Promise<GeocodedPlace[]> {
    const url = new URL(this.url);
    url.searchParams.set('q', q);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', String(limit));
    url.searchParams.set('addressdetails', '0');
    if (options.near) {
      const [w, s, e, n] = options.near;
      // A zero-area box is dropped rather than sent: Nominatim biases toward a region of no
      // area and answers with an empty list, which is indistinguishable from "no such place".
      // Callers derive this box from a viewport and coarsen it for caching, which is exactly
      // the arithmetic that produces a point.
      if (e > w && n > s) {
        // `viewbox` without `bounded=1` is a preference, not a filter: someone looking at
        // Wales who types a Washington summit still finds it, just second.
        url.searchParams.set('viewbox', `${w},${s},${e},${n}`);
      }
    }

    const response = await this.fetchImpl(url, {
      headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
      ...(options.signal ? { signal: options.signal } : {}),
    });

    if (!response.ok) {
      throw new Error(`Nominatim ${response.status} from ${url.origin}`);
    }

    const body: unknown = await response.json();
    if (!Array.isArray(body)) return [];
    return body
      .map((entry) => toPlace(entry as NominatimResult))
      .filter((place): place is GeocodedPlace => place !== null);
  }
}

function toPlace(result: NominatimResult): GeocodedPlace | null {
  const lat = Number(result.lat);
  const lng = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const display = result.display_name ?? '';
  // Nominatim's `name` is absent on some results, and `display_name` always leads with it.
  const name = result.name || display.split(',')[0]?.trim() || '';
  if (!name) return null;
  const context = display.startsWith(name)
    ? display.slice(name.length).replace(/^,\s*/, '')
    : display;

  return {
    id: `${result.osm_type ?? 'place'}/${result.osm_id ?? `${lat},${lng}`}`,
    name,
    context,
    lng,
    lat,
    bbox: frameOf(result.boundingbox, lng, lat),
    kind: result.type ?? result.category ?? 'place',
  };
}

/** Nominatim's `[south, north, west, east]` of strings → our `[w, s, e, n]`, widened to view. */
function frameOf(
  raw: [string, string, string, string] | undefined,
  lng: number,
  lat: number,
): BBox {
  const parsed = raw?.map(Number);
  const [s, n, w, e] =
    parsed && parsed.length === 4 && parsed.every(Number.isFinite)
      ? (parsed as [number, number, number, number])
      : [lat, lat, lng, lng];

  const padLng = Math.max(0, (MIN_FRAME_DEG - (e - w)) / 2);
  const padLat = Math.max(0, (MIN_FRAME_DEG - (n - s)) / 2);
  return [w - padLng, s - padLat, e + padLng, n + padLat];
}

let client: NominatimClient | null = null;

/** The process-wide client. One queue, or the one-per-second rule means nothing. */
export function getGeocoder(): NominatimClient {
  if (!client) client = new NominatimClient();
  return client;
}

/** Test seam, matching `resetIngestSingletons`. */
export function resetGeocoder(): void {
  client = null;
}
