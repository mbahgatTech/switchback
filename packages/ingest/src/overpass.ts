/**
 * Overpass API client.
 *
 * Overpass is a free public service run on donated hardware, and the instances enforce
 * their own fair use by blocking clients that misbehave. That makes etiquette a
 * correctness requirement here rather than a courtesy: a client that hammers the API
 * gets the whole product blocked, not throttled. Five mechanisms, each doing one job:
 *
 * - **A serialized queue at `maxConcurrent` (default 2).** The single most important
 *   one. Overpass allots slots per client IP, and exceeding them earns a 429 that
 *   escalates to a ban. Twelve tiles from one viewport therefore run two at a time.
 * - **Backoff that honours the server.** `429` and `504` are Overpass explicitly saying
 *   "later"; we wait, with jitter, rather than retrying into the same wall. `Retry-After`
 *   wins over our own schedule when present.
 * - **Mirror failover.** `url` is a list, not a string. Overpass runs several independent
 *   public instances precisely because any one of them can be down, overloaded, or
 *   blocking your IP — and a block arrives as a TCP reset with no HTTP status, which no
 *   amount of retrying against the same host will get past. An attempt that fails for any
 *   reason other than our own bad query moves to the next instance.
 * - **A circuit breaker.** After `failureThreshold` consecutive failures the client stops
 *   calling out entirely for `openMs`, and callers fail soft to cached data. Because a
 *   failure is only recorded once every mirror has refused, the breaker now means "OSM is
 *   unreachable", not "one host is having an afternoon".
 * - **A descriptive User-Agent with a contact URL.** Their operators block anonymous
 *   traffic first. `OVERPASS_USER_AGENT` carries it and is validated, not defaulted —
 *   shipping `node-fetch` as a UA is how a project gets banned before anyone notices.
 *
 * The class holds no global state so tests can build one per case, but the app uses a
 * single shared instance (`defaultOverpass`) because a queue that isn't shared isn't a
 * queue.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { BBox, LngLat } from '@switchback/core';

/** An `is_in` result: an administrative area, returned by `buildRegionQuery`. */
export interface OverpassArea {
  type: 'area';
  id: number;
  tags?: Record<string, string>;
}

/** Overpass returns elements in a flat array with `type` discriminating the shape. */
export interface OverpassNode {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OverpassWay {
  type: 'way';
  id: number;
  /** Present when the query used `out geom`, which ours does — saves a second round trip. */
  geometry?: Array<{ lat: number; lon: number }>;
  /** Present when the query used `out center` — the feature query does, for area amenities. */
  center?: { lat: number; lon: number };
  nodes?: number[];
  tags?: Record<string, string>;
}

export interface OverpassRelationMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  /** `forward`, `backward`, `` for route members; `outer`/`inner` for multipolygons. */
  role: string;
  geometry?: Array<{ lat: number; lon: number }>;
}

export interface OverpassRelation {
  type: 'relation';
  id: number;
  members: OverpassRelationMember[];
  tags?: Record<string, string>;
}

export type OverpassElement = OverpassNode | OverpassWay | OverpassRelation | OverpassArea;

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string };
  elements: OverpassElement[];
  /**
   * Overpass's own postscript on a query that did not fully succeed. Present at HTTP 200
   * alongside a plausible-looking `elements` array — see `assertUsable`, which is the only
   * thing standing between a timed-out query and a tile cached empty for thirty days.
   */
  remark?: string;
}

export interface OverpassOptions {
  /**
   * One endpoint, or several tried in order. A single string is the same as a list of one.
   * Empty entries are dropped, so a half-filled `OVERPASS_URL` degrades to the defaults
   * rather than to a request against the empty string.
   */
  url?: string | readonly string[];
  userAgent?: string;
  /** Overpass allots slots per IP; two is the documented-safe concurrency for a public instance. */
  maxConcurrent?: number;
  maxAttempts?: number;
  /** First backoff step. Doubles per attempt, with jitter, capped at `maxBackoffMs`. */
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive failures that trip the breaker. */
  failureThreshold?: number;
  /** How long the breaker stays open before allowing one probe through. */
  openMs?: number;
  /** Per-request timeout. Overpass's own `[timeout:]` is separate and set in the query. */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected in tests so backoff is instant rather than actually waiting 30 s. */
  sleepImpl?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

/**
 * Public instances, tried in this order.
 *
 * Two rules govern what belongs on this list, and both were learned the expensive way.
 *
 * **A mirror must serve the planet.** Several instances on the OSM wiki carry a regional
 * extract and answer an out-of-area query with `200 OK` and an empty `elements` array —
 * indistinguishable from "there are genuinely no trails here", which is how a tile gets
 * marked empty and cached that way for thirty days. `overpass.osm.ch` fails exactly this
 * way outside Switzerland and is deliberately absent. Every entry below was checked
 * against three widely separated points — a Washington summit, a Welsh footpath, and the
 * Pacific Crest Trail's superroute relation — before being trusted.
 *
 * **A mirror must be a distinct host.** The previous list read as three names and was two:
 * `overpass.kumi.systems` and `overpass.private.coffee` both resolve to 193.219.97.30. A
 * rotation across aliases of one machine is not a rotation, it is the same outage three
 * times, and it is what left the ingest queue stalled with every tile reporting a bare
 * `fetch failed`.
 *
 * The list is ordered by measured reachability rather than by reputation. `overpass-api.de`
 * is the reference instance and the better-maintained one, but it publishes two A records
 * of which one has been persistently unreachable from some networks; resolvers that hand
 * out the dead address make it a coin flip per connection. It stays on the list — when it
 * answers it is excellent — but it is no longer the first thing tried, because the first
 * endpoint is the one that decides whether a cold tile feels instant or takes a retry.
 */
const DEFAULT_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
] as const;

/** Thrown for a response we should not retry — a syntax error in our own query, mostly. */
export class OverpassFatalError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OverpassFatalError';
  }
}

/** Thrown when the breaker is open. Callers treat this as "serve cache, queue for later". */
export class OverpassUnavailableError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(`Overpass circuit breaker open; retry in ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'OverpassUnavailableError';
  }
}

/**
 * A 429 or 504 is Overpass asking us to come back later. `Retry-After` is in seconds
 * when Overpass sends it at all; it usually does not, hence the fallback schedule.
 */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

/**
 * Overpass phrasings that mean "this answer is not the answer to your query".
 *
 * Matched against the `remark` field, which arrives at HTTP 200 next to an `elements`
 * array that looks perfectly well-formed and is empty or truncated. This is the most
 * dangerous failure mode the service has: a tile fetched during a busy minute comes back
 * with zero trails, gets committed as `ready`, and stays cached for thirty days. The map
 * then shows bare ground over a range full of trails and nothing anywhere reports an
 * error, because as far as every layer above is concerned the fetch succeeded.
 */
const REMARK_FAILURE = /error|timed out|too busy|out of memory|please try again/i;

/**
 * Hosts that mean "I never filled this in".
 *
 * `example.com` and friends are reserved by RFC 2606 precisely so that nobody can receive
 * mail at them, which makes a contact address there worse than none — it looks like a
 * contact and reaches nobody. Overpass's front end agrees and is blunter about it: a
 * request whose User-Agent contains one comes back `406 Not Acceptable`, from Apache,
 * before Overpass sees the query at all. Every tile fails, the error mentions content
 * negotiation, and nothing anywhere points at the User-Agent.
 *
 * This list is what turns that into a startup error naming the actual problem. It is
 * checked in the constructor rather than per request because a bad UA is never transient
 * and never worth one retry, let alone four.
 */
const PLACEHOLDER_HOSTS = ['example.com', 'example.org', 'example.net', 'localhost', 'yourdomain'];

/**
 * Reject a User-Agent a public instance will refuse, at the point where it can still be
 * fixed by editing `.env`.
 *
 * Overpass operators block traffic they cannot contact; the failure mode is the whole
 * product going dark with no signal about why. Two rules, both learned from a real 406:
 * there must be a contact URL, and it must not be a placeholder.
 */
function assertUsableUserAgent(userAgent: string): void {
  const hint =
    'e.g. OVERPASS_USER_AGENT="Switchback/0.1 (+https://switchback.app)". ' +
    'It must carry a URL or address that reaches a human — Overpass operators block clients they cannot contact.';

  if (!/https?:\/\/\S/.test(userAgent)) {
    throw new Error(`OVERPASS_USER_AGENT must include a contact URL. ${hint}`);
  }

  const placeholder = PLACEHOLDER_HOSTS.find((host) => userAgent.toLowerCase().includes(host));
  if (placeholder) {
    throw new Error(
      `OVERPASS_USER_AGENT contains the placeholder "${placeholder}", which overpass-api.de rejects ` +
        `with 406 Not Acceptable before running the query. Replace it with a real contact — ${hint}`,
    );
  }
}

export class OverpassClient {
  private readonly endpoints: readonly string[];
  private readonly userAgent: string;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<unknown>;
  private readonly now: () => number;

  /** Slots currently in flight, and everyone waiting for one. */
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  private consecutiveFailures = 0;
  private breakerOpenedAt: number | null = null;

  /**
   * Where the next request goes.
   *
   * Deliberately an instance field rather than a per-call local: once a mirror has proved
   * itself unreachable there is no reason for the next tile to rediscover that from
   * scratch. The cursor stays where the last success left it, so a dead primary costs one
   * failed attempt in total rather than one per tile.
   */
  private cursor = 0;

  constructor(options: OverpassOptions = {}) {
    const configured = (typeof options.url === 'string' ? [options.url] : (options.url ?? []))
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
    this.endpoints = configured.length > 0 ? configured : DEFAULT_ENDPOINTS;
    this.userAgent = options.userAgent ?? '';
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    /*
     * Two passes over the mirror list, not one.
     *
     * One attempt per mirror is enough to route around a host that is *down*, and that was
     * the case this number was first sized for. It is not enough for the case that actually
     * costs us: every public mirror is busy at the same minute — they serve the same
     * planet-wide traffic and get busy together — and a single rotation burns all three
     * inside a few seconds and gives up while the backoff schedule is still measured in
     * milliseconds. A second pass is the first one that sleeps, and a sleep is the only
     * thing that helps when the answer is "come back later".
     *
     * This is sized by the Pacific Crest Trail. A route job spends half an hour fetching
     * twenty-nine sections and then throws all of it away if any one request runs out of
     * attempts, so the cheapest possible request failing transiently is not a small loss.
     * An explicit `maxAttempts` still wins — a caller asking for one attempt means one.
     */
    this.maxAttempts = options.maxAttempts ?? Math.max(6, this.endpoints.length * 2);
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openMs = options.openMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 190_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => sleep(ms));
    this.now = options.now ?? (() => Date.now());

    assertUsableUserAgent(this.userAgent);
  }

  /** Requests in flight plus requests queued. Exposed for the rate-limit test. */
  get inFlight(): number {
    return this.active;
  }

  get queueDepth(): number {
    return this.waiting.length;
  }

  get breakerState(): 'closed' | 'open' {
    return this.breakerOpenedAt === null ? 'closed' : 'open';
  }

  /** The instances this client will try, in order. Exposed for diagnostics and tests. */
  get mirrors(): readonly string[] {
    return this.endpoints;
  }

  /**
   * Run one Overpass QL query. Resolves with the parsed response, or throws
   * `OverpassUnavailableError` when the breaker is open — which is the signal to serve
   * whatever is cached rather than to fail the user's request.
   */
  async query(ql: string): Promise<OverpassResponse> {
    this.assertBreakerClosed();
    await this.acquire();
    try {
      return await this.attempt(ql);
    } finally {
      this.release();
    }
  }

  private assertBreakerClosed(): void {
    if (this.breakerOpenedAt === null) return;
    const elapsed = this.now() - this.breakerOpenedAt;
    if (elapsed < this.openMs) {
      throw new OverpassUnavailableError(this.openMs - elapsed);
    }
    // Half-open: let exactly one request through. If it succeeds the breaker closes; if
    // it fails, `recordFailure` re-opens it for another full window.
    this.breakerOpenedAt = null;
  }

  private async attempt(ql: string): Promise<OverpassResponse> {
    let lastError: unknown;
    // Which mirrors this call has already burned. Rotating onto a fresh one is free —
    // it is a different machine and owes us nothing — so the backoff sleep is charged
    // only once the rotation wraps back onto a host we have already annoyed.
    const tried = new Set<string>();

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const endpoint = this.endpoints[this.cursor % this.endpoints.length] ?? DEFAULT_ENDPOINTS[0];
      tried.add(endpoint);

      // Set from the response before `retry` runs, so a server that named its own delay
      // gets to keep naming it.
      let retryAfter: string | null = null;
      const retry = async (): Promise<void> => {
        this.cursor = (this.cursor + 1) % this.endpoints.length;
        const next = this.endpoints[this.cursor] ?? endpoint;
        if (tried.has(next)) await this.sleepImpl(this.backoffMs(attempt, retryAfter));
      };

      try {
        const response = await this.send(ql, endpoint);

        if (response.ok) {
          // Read as text, not `.json()`. A 200 from Overpass is not a promise of JSON: a
          // busy dispatcher answers with an XHTML error page and the correct status code,
          // and `.json()` would surface that as "Unexpected token '<'" — a parse error
          // that reads like our bug and gets recorded as the tile's `lastError`.
          const body = assertUsable(await response.text(), endpoint);
          this.recordSuccess();
          return body;
        }

        if (!RETRYABLE_STATUS.has(response.status)) {
          // A 400 is almost always our own query being wrong, and retrying a broken
          // query four times is exactly the behaviour that gets a client blocked. Every
          // mirror runs the same Overpass, so failing over would only spread the blame.
          const text = await safeText(response);
          this.recordFailure();
          throw new OverpassFatalError(
            `Overpass ${response.status} from ${endpoint}: ${explain(response.status)}${text.slice(0, 300)}`,
            response.status,
          );
        }

        lastError = new Error(`Overpass ${response.status} from ${endpoint}`);
        retryAfter = response.headers.get('retry-after');
        if (attempt < this.maxAttempts) await retry();
      } catch (error) {
        if (error instanceof OverpassFatalError) throw error;
        // A transport error is the case mirrors exist for: an IP-level block arrives as a
        // reset with no status at all, and no amount of waiting makes this host answer.
        lastError = error instanceof Error ? new Error(`${endpoint}: ${error.message}`) : error;
        if (attempt < this.maxAttempts) await retry();
      }
    }

    this.recordFailure();
    throw lastError instanceof Error ? lastError : new Error('Overpass request failed');
  }

  private async send(ql: string, endpoint: string): Promise<Response> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      return await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
        body: new URLSearchParams({ data: ql }).toString(),
        signal: controller.signal,
      });
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /**
   * Exponential with full jitter. The jitter is not decoration: without it, twelve tiles
   * queued at once fail at once and retry in perfect lockstep, which is a thundering herd
   * aimed at a service that just told us it was overloaded.
   */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const serverAsked = retryAfter === null ? NaN : Number(retryAfter) * 1000;
    if (Number.isFinite(serverAsked) && serverAsked > 0) {
      return Math.min(serverAsked, this.maxBackoffMs);
    }
    const ceiling = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs);
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.breakerOpenedAt = null;
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.breakerOpenedAt = this.now();
      this.consecutiveFailures = 0;
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.active += 1;
  }

  private release(): void {
    this.active -= 1;
    const next = this.waiting.shift();
    if (next) next();
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Turn a 200 response body into a response we are willing to believe.
 *
 * Overpass signals most of its failures inside a successful HTTP exchange, in two shapes:
 *
 * 1. **An XHTML error page.** `runtime error: … Dispatcher_Client::request_read_and_idx::
 *    timeout. The server is probably too busy` arrives as `200 OK` with `<?xml …` as the
 *    body. Observed against `overpass-api.de` while building this, not hypothesised.
 * 2. **JSON carrying a `remark`.** `{"elements":[],"remark":"runtime error: Query timed
 *    out in \"query\" at line 3 after 179 seconds."}` — valid JSON, plausible shape, no
 *    data.
 *
 * The second is why this throws rather than returning the parsed body with a warning. A
 * partial answer is indistinguishable from a complete one downstream: `assembleTrails`
 * assembles nothing, `processTile` records zero trails and marks the tile `ready`, and the
 * result is thirty days of cached emptiness over real terrain with nothing anywhere
 * reporting an error. Treating it as a retryable failure is the only handling that cannot
 * silently lose ground.
 *
 * A plain `Error` deliberately, not `OverpassFatalError` — `attempt` retries these and
 * rotates mirrors, which is the right response to a server that is merely busy.
 */
function assertUsable(text: string, endpoint: string): OverpassResponse {
  if (text.trimStart().slice(0, 1) !== '{') {
    // The `<strong>Error</strong>: …` line, when this is Overpass's own error page.
    const detail = /error<\/strong>\s*:?\s*([^<]{0,200})/i.exec(text)?.[1]?.trim();
    throw new Error(
      `Overpass returned a non-JSON body from ${endpoint}${detail ? `: ${detail}` : ''}`,
    );
  }

  let body: OverpassResponse;
  try {
    body = JSON.parse(text) as OverpassResponse;
  } catch {
    throw new Error(`Overpass returned unparseable JSON from ${endpoint}`);
  }

  if (body.remark && REMARK_FAILURE.test(body.remark)) {
    throw new Error(`Overpass reported "${body.remark.slice(0, 200)}" from ${endpoint}`);
  }
  return body;
}

/**
 * A one-line cause for the statuses whose body explains nothing.
 *
 * A 406 arrives as an Apache content-negotiation page, which is a fair description of the
 * mechanism and a useless description of the problem: the request was refused by the front
 * end over the User-Agent, and the query never ran. The constructor catches the common
 * case, but a mirror can have its own rules, so the hint is repeated where the operator
 * will actually be reading — `ingest_tiles.lastError`.
 */
function explain(status: number): string {
  if (status === 406) {
    return 'the mirror refused this User-Agent before running the query — check OVERPASS_USER_AGENT. ';
  }
  if (status === 400) {
    return 'malformed Overpass QL. ';
  }
  return '';
}

/**
 * Overpass QL for one tile.
 *
 * Two element classes, deliberately:
 *
 * 1. **Route relations** (`route=hiking|foot|hiking|running`) — the curated thing. A
 *    relation is somebody's assertion that these ways form one named trail, which is
 *    exactly the object we want and cannot derive reliably ourselves.
 * 2. **Named standalone ways** on path-like highways. Most of the world has no relation
 *    coverage, and a named `highway=path` is the next best signal that a way is a trail
 *    rather than an unnamed connector. The name filter is what keeps this from returning
 *    every garden path in a city.
 *
 * `out body geom` returns member coordinates inline, so assembly needs no second round trip
 * for node positions — one request per tile rather than two.
 *
 * **The verbosity is load-bearing and easy to get wrong.** `out` takes a verbosity level and
 * a geometry mode, and `tags` is a *verbosity*, not an addition: it means "ids and tags,
 * nothing else", which silently drops the `members` array from every relation. `out geom
 * tags` therefore reads as "geometry and tags" and behaves as "tags only" — relations come
 * back looking well-formed, with a name and a route tag and zero members, and the assembler
 * skips every one of them for having nothing to assemble. The failure is invisible: named
 * standalone ways still arrive, so tiles commit trails and look healthy while the curated
 * route relations — the whole first half of this query — quietly produce nothing. `body` is
 * the verbosity that keeps members; `geom` then hangs coordinates off them.
 *
 * The guards matter as much as the filters. `[timeout:180]` bounds the server's work so
 * a pathological tile fails cleanly instead of holding a slot for ten minutes, and
 * `[maxsize:]` caps memory so Overpass rejects the query up front rather than dying
 * partway through.
 */
export function buildTileQuery(
  bbox: BBox,
  options: { timeoutS?: number; maxSizeBytes?: number } = {},
): string {
  const [w, s, e, n] = bbox;
  const timeout = options.timeoutS ?? 180;
  const maxSize = options.maxSizeBytes ?? 536_870_912;
  // Overpass bbox order is (south, west, north, east) — the transposition of GeoJSON's,
  // and the single easiest thing to get silently wrong in this file.
  const box = `${s},${w},${n},${e}`;

  return `[out:json][timeout:${timeout}][maxsize:${maxSize}];
(
  relation["route"~"^(hiking|foot|walking|running)$"](${box});
  way["highway"~"^(path|footway|track|bridleway|steps|cycleway)$"]["name"](${box});
);
out body geom;`;
}

/**
 * Which route relations *contain* the ones we just assembled.
 *
 * A bbox query cannot reach a superroute, and this is not a tuning problem — it is how
 * Overpass defines the filter. `relation(bbox)` selects relations with a node or way
 * member inside the box, and it does not recurse into member relations. A superroute's
 * members are relations, so the Pacific Crest Trail — 4,270 km, crossing hundreds of our
 * tiles — is a member of none of them, and no amount of panning will ever surface it.
 * What a tile *does* see is a section: "PCT - California Section I", 111 km, which is
 * exactly the kind of answer that looks plausible enough to ship.
 *
 * `rel(br)` is the inverse: given relations, give me the relations they belong to. One
 * cheap query per tile turns "here are 24 routes" into "…and three of them are pieces of
 * something longer". `out tags` is right here and only here — we want ids and names to
 * decide what is worth fetching, and deliberately not the member lists, which for a
 * superroute is the expensive part.
 */
export function buildParentRouteQuery(
  ids: readonly number[],
  options: { timeoutS?: number } = {},
): string {
  const timeout = options.timeoutS ?? 90;
  return `[out:json][timeout:${timeout}];
relation(id:${ids.join(',')});
relation(br);
out tags;`;
}

/**
 * Full geometry for named relations, fetched by id rather than by area.
 *
 * The counterpart to `buildTileQuery` for work that is not tile-shaped. Selecting by id
 * means the response is bounded by the route rather than by a box, which is the only way
 * to get a whole long-distance trail in one piece.
 *
 * `maxsize` is raised well above the tile query's, because a batch of route sections is
 * legitimately hundreds of megabytes of node coordinates in Overpass's working memory and
 * the tile ceiling would reject it as if it were a runaway. The *timeout* is deliberately
 * not raised to match: it stays inside the client's own abort window, because a server
 * granted ten minutes on a query we hang up on after three spends the remaining seven
 * generating a response nobody will read. Bounding the response size is the caller's job —
 * see `ROUTE_BATCH_SIZE` — not this timeout's.
 *
 * `out body geom` for the same reason as the tile query: `tags` is a verbosity that drops
 * the `members` array, and a relation with no members assembles to nothing.
 */
export function buildRouteQuery(
  ids: readonly number[],
  options: { timeoutS?: number; maxSizeBytes?: number } = {},
): string {
  const timeout = options.timeoutS ?? 180;
  const maxSize = options.maxSizeBytes ?? 1_073_741_824;
  return `[out:json][timeout:${timeout}][maxsize:${maxSize}];
relation(id:${ids.join(',')});
out body geom;`;
}

/**
 * A relation's member list without any geometry.
 *
 * Half of the escape hatch for a section that no mirror will serve whole. `out body` is the
 * same verbosity as the query above — so `members` is present with its refs and roles — but
 * without `geom` there are no coordinates, and the response for even the largest PCT
 * section is a few hundred kilobytes that comes back in under a second.
 *
 * On its own this is useless: a member with no geometry assembles to nothing. It is only
 * ever paired with `buildWayGeometryQuery`, which fetches the coordinates the caller then
 * splices back in.
 */
export function buildRelationSkeletonQuery(
  ids: readonly number[],
  options: { timeoutS?: number } = {},
): string {
  const timeout = options.timeoutS ?? 180;
  return `[out:json][timeout:${timeout}];
relation(id:${ids.join(',')});
out body;`;
}

/**
 * Geometry for ways, fetched by id.
 *
 * The other half. `out geom` on a list of way ids returns each way with its inline node
 * coordinates and nothing else — no tags, no relation context — which is exactly the part
 * of a route response that is expensive, and now it can be asked for in batches the caller
 * chooses rather than in one lump the relation's size dictates.
 *
 * This is what turns "the server cannot serve this relation" into "the server can serve
 * this relation in six requests". The recursion in `fetchRelations` halves until the unit
 * is a single relation; below that, the unit is its ways, and this is how they are asked for.
 */
export function buildWayGeometryQuery(
  ids: readonly number[],
  options: { timeoutS?: number } = {},
): string {
  const timeout = options.timeoutS ?? 180;
  return `[out:json][timeout:${timeout}];
way(id:${ids.join(',')});
out geom;`;
}

/**
 * Which country and region a point falls in.
 *
 * Run once per tile rather than once per trail. A z9 tile is roughly 78 km across, so
 * every trail in it shares a region to a good approximation — and the alternative, a
 * reverse-geocode per trail, would be forty Nominatim requests against a service with a
 * one-per-second policy. One `is_in` query is both more accurate about administrative
 * boundaries and about two orders of magnitude cheaper.
 *
 * Admin levels 2–6 covers country through county with the same query; the caller picks
 * the most useful level present, because level 4 means "state" in the US and "region" in
 * France but is absent entirely in some countries.
 */
export function buildRegionQuery(at: LngLat, options: { timeoutS?: number } = {}): string {
  const [lng, lat] = at;
  const timeout = options.timeoutS ?? 60;
  return `[out:json][timeout:${timeout}];
is_in(${lat},${lng})->.here;
area.here["boundary"="administrative"]["admin_level"~"^(2|4|5|6)$"];
out tags;`;
}

/**
 * Waypoint and amenity query for an assembled trail's buffer.
 *
 * Kept separate from the tile query on purpose. The tile query is the expensive one and
 * runs against a 78 km box; this one runs against a trail's bbox and only after assembly
 * has decided the trail is worth keeping, so we never pay for waypoints around a way we
 * are about to discard.
 */
export function buildFeatureQuery(bbox: BBox, options: { timeoutS?: number } = {}): string {
  const [w, s, e, n] = bbox;
  const box = `${s},${w},${n},${e}`;
  const timeout = options.timeoutS ?? 90;

  return `[out:json][timeout:${timeout}];
(
  node["natural"~"^(peak|saddle|spring|water|cave_entrance)$"](${box});
  node["tourism"="viewpoint"](${box});
  node["waterway"="waterfall"](${box});
  node["amenity"~"^(parking|toilets|shelter|drinking_water)$"](${box});
  way["amenity"="parking"](${box});
  node["tourism"~"^(camp_site|alpine_hut|wilderness_hut)$"](${box});
  node["barrier"~"^(gate|stile)$"](${box});
  node["ford"="yes"](${box});
  node["information"="guidepost"](${box});
);
out center tags;`;
}
