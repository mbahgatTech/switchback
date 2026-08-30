/**
 * Overpass API client. Instances are donated hardware that block clients who misbehave, so
 * the etiquette below is a correctness requirement, not a courtesy:
 *
 * - A serialized queue at `maxConcurrent` (default 2) — slots are allotted per client IP.
 * - Backoff with jitter that honours `Retry-After`, 429 and 504 over its own schedule.
 * - An optional `maxTotalMs` budget per query, because a host that kills the process at ten
 *   minutes is not bounded by an attempt count multiplied by a per-request timeout.
 * - Mirror failover: `url` is a list, because an IP block arrives as a reset with no status.
 * - A circuit breaker after `failureThreshold` consecutive failures across every mirror;
 *   callers fail soft to cached data.
 * - A descriptive User-Agent carrying a contact URL, validated and never defaulted.
 *
 * The app uses one shared instance, memoised by `getOverpass()` in `config.ts` — a queue that
 * isn't shared isn't one.
 */

import { setTimeout as sleep } from 'node:timers/promises';
import type { BBox, LngLat } from '@switchback/core';
import { DEADLINE_PASSED } from './deadline';

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

/**
 * What the pipeline needs from Overpass. Narrow on purpose: it is what lets a caller with a
 * wall-clock ceiling wrap the shared client without owning a second queue — see `withDeadline`.
 */
export interface OverpassQuerier {
  query(ql: string): Promise<OverpassResponse>;
}

export interface OverpassResponse {
  version?: number;
  generator?: string;
  osm3s?: { timestamp_osm_base?: string };
  elements: OverpassElement[];
  /**
   * Overpass's own postscript on a query that did not fully succeed. Present at HTTP 200
   * alongside a plausible-looking `elements` array — see `assertUsable`.
   */
  remark?: string;
}

export interface OverpassOptions {
  /**
   * One endpoint, or several tried in order. Empty entries are dropped, so a half-filled
   * `OVERPASS_URL` degrades to the defaults rather than to a request against `''`.
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
  /**
   * Wall clock one `query()` may spend, retries and backoff included. Unset means the only
   * ceiling is `maxAttempts x requestTimeoutMs` plus backoff, which on the defaults is ~24
   * minutes — longer than the Function App host will let an invocation live. See `attempt`.
   */
  maxTotalMs?: number;
  fetchImpl?: typeof fetch;
  /** Injected in tests so backoff is instant rather than actually waiting 30 s. */
  sleepImpl?: (ms: number) => Promise<unknown>;
  now?: () => number;
  /** Where strain is reported. Injected in tests; `console.warn` everywhere else. */
  logImpl?: (line: string) => void;
}

/**
 * The literal an operator greps for when a mirror refuses, a failover happens or the breaker
 * moves.
 *
 * Overpass etiquette is a correctness requirement — the failure mode is an IP block that takes
 * the product down — and none of the three events above leaves a row anywhere. A retry that
 * eventually succeeds never reaches `ingest_jobs.lastError`, so without a line here the only
 * record of a mirror rate-limiting this client is that nothing appeared to go wrong.
 *
 * What an alert can watch is the subset that *does* leave a row: a 429 that outlives the retry
 * budget fails the job, and `queueHealth`'s `rateLimited` counts it. These lines are for the
 * reader of the Function App's own telemetry, which is where the one drainer writes.
 */
export const OVERPASS_STRAIN_MARKER = 'switchback-ingest-overpass-strain';

/**
 * The literal `switchback-ingest-overpass-skipped` greps for.
 *
 * Three of a tile's four Overpass queries fail soft — region, waypoints, parent routes — so a
 * budget that refuses them costs metadata silently: the tile still reaches `ready`, the request row
 * still reads success, and no job row records anything. This token is what makes the loss
 * countable, and it is why `lookupRegion` logs at all.
 */
export const OVERPASS_SKIPPED_MARKER = 'switchback-ingest-overpass-skipped';

/**
 * Public instances, tried in this order. Two rules govern the list. A mirror must serve the
 * planet: a regional extract answers an out-of-area query `200 OK` with no elements, which is
 * indistinguishable from "no trails here" and caches a tile empty for thirty days
 * (`overpass.osm.ch` fails this way and is deliberately absent). And a mirror must be a
 * distinct host — `kumi.systems` and `private.coffee` share an address, so rotating between
 * them is the same outage twice.
 *
 * Ordered by measured reachability, not reputation, and the vantage point is half the
 * measurement: `overpass-api.de` publishes an A record that is unreachable from some consumer
 * networks, which is a fact about those networks and not about a data centre, where every
 * deployment that ingests actually runs. From a GitHub-hosted runner it answered 6 of 6 rounds at
 * a 2.4 s median across two runs 90 seconds apart, while `maps.mail.ru` answered 3 of 6 and spent
 * the other three at a 30 s abort — so the reference instance leads. `scripts/overpass-probe.ts`
 * is the measurement; re-run it before reordering again, from a runner rather than a workstation.
 *
 * A wrong leader is bounded rather than fatal — `cursor` is an instance field, so a dead primary
 * costs one failed attempt per process, not one per tile — which is what makes the order a
 * latency decision rather than an availability one.
 */
const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
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
    super(`Overpass ${OVERPASS_BREAKER_OPEN}; retry in ${Math.round(retryAfterMs / 1000)}s`);
    this.name = 'OverpassUnavailableError';
  }
}

/**
 * Statuses meaning "come back later". `Retry-After` is in seconds when it is sent at all.
 *
 * Exported because `classifyDeath` decides whether to revive a buried job on the same question
 * this set answers. Two hand-kept lists would drift, and the drift that matters is silent: 500 is
 * deliberately absent here, so a copy that included it would have the reconciler retrying the
 * broken query this set exists to stop retrying.
 */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 502, 503, 504]);

/**
 * Fragments of the messages this module raises, named because `classifyDeath` reads them off a
 * buried job's `lastError` to decide whether running it again is a different request. A reworded
 * sentence would silently reclassify the failure it describes, and nothing would go red.
 */
export const OVERPASS_MALFORMED_QL = 'malformed Overpass QL';
export const OVERPASS_UA_REFUSED = 'refused this User-Agent';
export const OVERPASS_UA_UNUSABLE = 'OVERPASS_USER_AGENT must include';
/** The sibling of the above: a User-Agent that carries a URL, but not one that reaches anybody. */
export const OVERPASS_UA_UNREACHABLE = 'does not reach this project';
export const OVERPASS_BUDGET_SPENT = 'Overpass gave up after';
export const OVERPASS_BREAKER_OPEN = 'circuit breaker open';
export const OVERPASS_NON_JSON = 'Overpass returned a non-JSON body';
export const OVERPASS_UNPARSEABLE = 'Overpass returned unparseable JSON';
export const OVERPASS_REMARK = 'Overpass reported';
export const OVERPASS_REQUEST_FAILED = 'Overpass request failed';

/** How every status failure names itself, so the raiser and the classifier share one shape. */
export function overpassStatusText(status: number, endpoint: string): string {
  return `Overpass ${status} from ${endpoint}`;
}

/**
 * Overpass phrasings that mean "this answer is not the answer to your query". Matched against
 * `remark`, which arrives at HTTP 200 beside a well-formed but empty or truncated `elements`
 * array — the most dangerous failure the service has, because every layer above sees success.
 */
const REMARK_FAILURE = /error|timed out|too busy|out of memory|please try again/i;

/**
 * Hosts a contact URL must not name. The RFC 2606 four and `localhost` mean "I never filled this
 * in", and Overpass's front end answers a User-Agent carrying one with `406 Not Acceptable` from
 * Apache before the query runs at all.
 *
 * `switchback.app` is here for the opposite reason and is the entry a maintainer would delete as
 * obviously wrong: it reads like ours and is not. It belongs to somebody else and serves an
 * unrelated site, so an Overpass operator following it to complain about this client reaches a
 * stranger — which is the condition they block for. It was deployed once. Only shape can be
 * checked here; that a URL reaches *this* project is a fact no constructor can verify.
 */
const UNREACHABLE_HOSTS = [
  'example.com',
  'example.org',
  'example.net',
  'localhost',
  'yourdomain',
  'switchback.app',
];

/**
 * Reject a User-Agent a public instance will refuse, while it can still be fixed by editing
 * `.env`. Two rules, both learned from a real 406: a contact URL, and one that reaches us.
 */
function assertUsableUserAgent(userAgent: string): void {
  const hint =
    'e.g. OVERPASS_USER_AGENT="Switchback/0.1 (+https://switchback-three.vercel.app/attribution)". ' +
    'It must carry a URL or address that reaches a human — Overpass operators block clients they cannot contact.';

  if (!/https?:\/\/\S/.test(userAgent)) {
    throw new Error(`${OVERPASS_UA_UNUSABLE} a contact URL. ${hint}`);
  }

  const unreachable = UNREACHABLE_HOSTS.find((host) => userAgent.toLowerCase().includes(host));
  if (unreachable) {
    throw new Error(
      `OVERPASS_USER_AGENT names "${unreachable}", which ${OVERPASS_UA_UNREACHABLE} — a mirror ` +
        `answers such a client 406 Not Acceptable, or blocks it. Replace it with a real contact — ${hint}`,
    );
  }
}

/** One exchange, already drained: `send` reads the body while its abort timer is still armed. */
interface Answer {
  ok: boolean;
  status: number;
  retryAfter: string | null;
  text: string;
}

export class OverpassClient implements OverpassQuerier {
  private readonly endpoints: readonly string[];
  private readonly userAgent: string;
  private readonly maxConcurrent: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxTotalMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<unknown>;
  private readonly now: () => number;
  private readonly logImpl: (line: string) => void;

  /** Slots currently in flight, and everyone waiting for one. */
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  private consecutiveFailures = 0;
  private breakerOpenedAt: number | null = null;
  /** True between the half-open probe being admitted and its outcome, so the close is reportable. */
  private probing = false;

  /**
   * Where the next request goes. An instance field, not a per-call local, so a dead primary
   * costs one failed attempt in total rather than one per tile.
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
     * Two passes over the mirror list, not one. One pass routes around a host that is down
     * but never sleeps — and the case that costs us is every public mirror busy in the same
     * minute, where only a sleep helps. An explicit `maxAttempts` still wins.
     */
    this.maxAttempts = options.maxAttempts ?? Math.max(6, this.endpoints.length * 2);
    this.baseBackoffMs = options.baseBackoffMs ?? 2_000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.openMs = options.openMs ?? 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 190_000;
    this.maxTotalMs = options.maxTotalMs ?? Number.POSITIVE_INFINITY;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.sleepImpl = options.sleepImpl ?? ((ms) => sleep(ms));
    this.now = options.now ?? (() => Date.now());
    this.logImpl = options.logImpl ?? ((line) => console.warn(line));

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
   * Run one Overpass QL query. Throws `OverpassUnavailableError` when the breaker is open,
   * which is the signal to serve cache rather than to fail the reader's request.
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
    // Half-open: let exactly one request through. `recordFailure` re-opens it for a full
    // window if that one fails.
    this.breakerOpenedAt = null;
    this.probing = true;
    this.reportStrain('breaker=half-open, admitting one probe');
  }

  private async attempt(ql: string): Promise<OverpassResponse> {
    let lastError: unknown;
    // Rotating onto a fresh mirror is free, so the backoff sleep is charged only once the
    // rotation wraps back onto a host we have already annoyed.
    const tried = new Set<string>();
    const startedAt = this.now();
    const remaining = (): number => this.maxTotalMs - (this.now() - startedAt);

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      /*
       * The budget is checked here rather than raced against the whole call, so a request that
       * is already in flight is allowed to finish: an answer arriving at the deadline is worth
       * more than a clean abort. What it forbids is *starting* work that cannot finish in time.
       */
      const left = remaining();
      if (attempt > 1 && left <= 0) {
        lastError ??= new Error(`${OVERPASS_BUDGET_SPENT} ${this.maxTotalMs} ms`);
        break;
      }

      const endpoint = this.endpoints[this.cursor % this.endpoints.length] ?? DEFAULT_ENDPOINTS[0];
      tried.add(endpoint);

      // Set from the response before `retry` runs, so a server that named its own delay
      // gets to keep naming it.
      let retryAfter: string | null = null;
      const retry = async (): Promise<void> => {
        this.cursor = (this.cursor + 1) % this.endpoints.length;
        const next = this.endpoints[this.cursor] ?? endpoint;
        // Named rather than left to be reconstructed by diffing `endpoint=` across consecutive
        // lines: a failover is the response to a mirror refusing this client, and it is the event
        // an operator investigating an IP block is looking for.
        if (next !== endpoint) this.reportStrain(`failover=${endpoint} -> ${next}`);
        if (tried.has(next)) {
          await this.sleepImpl(
            Math.min(this.backoffMs(attempt, retryAfter), Math.max(remaining(), 0)),
          );
        }
      };

      try {
        const answer = await this.send(ql, endpoint, Math.min(this.requestTimeoutMs, left));

        if (answer.ok) {
          // Read as text, not `.json()`: a busy dispatcher answers 200 with an XHTML error
          // page, which `.json()` would surface as a parse error that reads like our bug.
          const body = assertUsable(answer.text, endpoint);
          this.recordSuccess();
          return body;
        }

        if (!RETRYABLE_STATUS.has(answer.status)) {
          // Almost always our own query being wrong, and every mirror runs the same
          // Overpass — retrying a broken query is exactly what gets a client blocked.
          this.recordFailure();
          throw new OverpassFatalError(
            `${overpassStatusText(answer.status, endpoint)}: ${explain(answer.status)}${answer.text.slice(0, 300)}`,
            answer.status,
          );
        }

        lastError = new Error(overpassStatusText(answer.status, endpoint));
        retryAfter = answer.retryAfter;
        this.reportStrain(
          `status=${answer.status} endpoint=${endpoint} attempt=${attempt}` +
            (answer.retryAfter === null ? '' : ` retryAfter=${answer.retryAfter}`),
        );
        if (attempt < this.maxAttempts) await retry();
      } catch (error) {
        if (error instanceof OverpassFatalError) throw error;
        // The case mirrors exist for: an IP-level block arrives as a reset with no status,
        // and no amount of waiting makes this host answer.
        lastError = error instanceof Error ? new Error(`${endpoint}: ${error.message}`) : error;
        this.reportStrain(
          `transport endpoint=${endpoint} attempt=${attempt} ` +
            `error=${error instanceof Error ? error.message : String(error)}`,
        );
        if (attempt < this.maxAttempts) await retry();
      }
    }

    this.recordFailure();
    throw lastError instanceof Error ? lastError : new Error(OVERPASS_REQUEST_FAILED);
  }

  /**
   * One request, body included.
   *
   * The body read is inside the timer on purpose, and it is the whole reason this returns text
   * rather than a `Response`. `fetch` resolves as soon as the *headers* arrive, so clearing the
   * timeout there and reading the body afterwards leaves the download — which for a route query
   * is the hundreds of megabytes `[maxsize:1073741824]` permits — with no ceiling and no live
   * signal. That is not a hypothetical slow tail: it is the difference between `maxTotalMs`
   * bounding a query and bounding only its time to first byte.
   */
  private async send(ql: string, endpoint: string, timeoutMs: number): Promise<Answer> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': this.userAgent,
          Accept: 'application/json',
        },
        body: new URLSearchParams({ data: ql }).toString(),
        signal: controller.signal,
      });
      return {
        ok: response.ok,
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        // A failed body is not a failed request: on the error paths the status carries the
        // meaning and the text is only ever quoted into a message.
        text: response.ok ? await response.text() : await safeText(response),
      };
    } finally {
      globalThis.clearTimeout(timer);
    }
  }

  /**
   * Exponential with full jitter. Without the jitter, twelve tiles queued at once fail at
   * once and retry in lockstep — a herd aimed at a service that just said it was overloaded.
   */
  private backoffMs(attempt: number, retryAfter: string | null): number {
    const serverAsked = retryAfter === null ? NaN : Number(retryAfter) * 1000;
    if (Number.isFinite(serverAsked) && serverAsked > 0) {
      return Math.min(serverAsked, this.maxBackoffMs);
    }
    const ceiling = Math.min(this.baseBackoffMs * 2 ** (attempt - 1), this.maxBackoffMs);
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
  }

  /** One line per strain event, prefixed so a log search finds all of them together. */
  private reportStrain(detail: string): void {
    this.logImpl(`${OVERPASS_STRAIN_MARKER} ${detail}`);
  }

  private recordSuccess(): void {
    // `assertBreakerClosed` has already cleared `breakerOpenedAt` to admit this probe, so the
    // flag is the only thing that still knows the breaker was open a moment ago.
    if (this.probing) this.reportStrain('breaker=closed');
    this.probing = false;
    this.consecutiveFailures = 0;
    this.breakerOpenedAt = null;
  }

  private recordFailure(): void {
    // A failed probe re-opens the breaker for a full window immediately, rather than spending
    // `failureThreshold` more requests against a service that has just refused one.
    if (this.probing) {
      this.probing = false;
      this.consecutiveFailures = 0;
      this.breakerOpenedAt = this.now();
      this.reportStrain(`breaker=open for ${this.openMs}ms after a failed probe`);
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.breakerOpenedAt = this.now();
      this.consecutiveFailures = 0;
      this.reportStrain(
        `breaker=open for ${this.openMs}ms after ${this.failureThreshold} failures`,
      );
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  // Hands the slot straight to the next waiter rather than freeing it and waking them, so
  // `active` never dips below the cap between the two. Decrementing first opens a window in
  // which a caller already queued ahead of the wake-up sees a free slot and barges past it.
  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

/** Thrown by a `withDeadline` view once its window has closed. */
export class OverpassDeadlineError extends Error {
  constructor(overrunMs: number) {
    super(`Overpass ${DEADLINE_PASSED} ${Math.round(overrunMs / 1000)}s ago`);
    this.name = 'OverpassDeadlineError';
  }
}

/**
 * The same client, but refusing to *start* a query after `at`.
 *
 * For a host that kills the process on a wall clock — Azure Functions Consumption ends an
 * invocation at ten minutes, no extension available. A handler makes several queries in
 * sequence, so bounding each one is not enough to bound the handler; this bounds the handler,
 * and `maxTotalMs` bounds how far past the deadline the one query already running can carry it.
 * A view rather than a second client: the queue, the breaker and the mirror cursor are the
 * shared instance's, which is the property the whole concurrency argument rests on.
 *
 * Failing here is the good outcome. The alternative is the host killing the worker mid-tile,
 * which strands the `ingest_jobs` lease and redelivers the message; a throw is caught per job,
 * writes `lastError`, releases the lease and schedules a retry.
 */
export function withDeadline(
  client: OverpassQuerier,
  at: number,
  now: () => number = () => Date.now(),
): OverpassQuerier {
  return {
    query(ql: string): Promise<OverpassResponse> {
      const overrun = now() - at;
      if (overrun >= 0) return Promise.reject(new OverpassDeadlineError(overrun));
      return client.query(ql);
    },
  };
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<unreadable body>';
  }
}

/**
 * Turn a 200 response body into one we are willing to believe. Overpass signals most
 * failures inside a successful exchange: an XHTML error page, or valid JSON carrying a
 * `remark` and no data. Both must throw rather than return, because a partial answer is
 * indistinguishable from a complete one downstream — the tile would be marked `ready` and
 * cached empty for thirty days over real terrain. A plain `Error`, not `OverpassFatalError`,
 * so `attempt` retries and rotates mirrors.
 */
function assertUsable(text: string, endpoint: string): OverpassResponse {
  if (text.trimStart().slice(0, 1) !== '{') {
    // The `<strong>Error</strong>: …` line, when this is Overpass's own error page.
    const detail = /error<\/strong>\s*:?\s*([^<]{0,200})/i.exec(text)?.[1]?.trim();
    throw new Error(`${OVERPASS_NON_JSON} from ${endpoint}${detail ? `: ${detail}` : ''}`);
  }

  let body: OverpassResponse;
  try {
    body = JSON.parse(text) as OverpassResponse;
  } catch {
    throw new Error(`${OVERPASS_UNPARSEABLE} from ${endpoint}`);
  }

  if (body.remark && REMARK_FAILURE.test(body.remark)) {
    throw new Error(`${OVERPASS_REMARK} "${body.remark.slice(0, 200)}" from ${endpoint}`);
  }
  return body;
}

/**
 * A one-line cause for the statuses whose body explains nothing. A 406 arrives as an Apache
 * content-negotiation page, which describes the mechanism and not the problem: the front end
 * refused the User-Agent and the query never ran. Repeated here as well as in the constructor
 * because a mirror can have its own rules, and this is what lands in `ingest_tiles.lastError`.
 */
function explain(status: number): string {
  if (status === 406) {
    return `the mirror ${OVERPASS_UA_REFUSED} before running the query — check OVERPASS_USER_AGENT. `;
  }
  if (status === 400) {
    return `${OVERPASS_MALFORMED_QL}. `;
  }
  return '';
}

/**
 * Overpass QL for one tile: route relations (somebody's assertion that these ways are one
 * named trail) plus named standalone path-like ways, for the most of the world that has no
 * relation coverage. The name filter is what keeps every garden path out.
 *
 * **`out body geom` — the verbosity is load-bearing.** `tags` is a *verbosity*, not an
 * addition: `out geom tags` reads as "geometry and tags" and silently drops `members` from
 * every relation, so relations arrive well-formed with nothing to assemble and the tile still
 * commits its standalone ways and looks healthy. `body` is the verbosity that keeps members.
 *
 * `[timeout:180]` bounds the server's work so a pathological tile fails cleanly instead of
 * holding a slot, and `[maxsize:]` makes Overpass reject the query up front rather than die
 * partway through.
 */
export function buildTileQuery(
  bbox: BBox,
  options: { timeoutS?: number; maxSizeBytes?: number } = {},
): string {
  const [w, s, e, n] = bbox;
  const timeout = options.timeoutS ?? 180;
  const maxSize = options.maxSizeBytes ?? 536_870_912;
  // Overpass bbox order is (south, west, north, east) — the transposition of GeoJSON's.
  const box = `${s},${w},${n},${e}`;

  return `[out:json][timeout:${timeout}][maxsize:${maxSize}];
(
  relation["route"~"^(hiking|foot|walking|running)$"](${box});
  way["highway"~"^(path|footway|track|bridleway|steps|cycleway)$"]["name"](${box});
);
out body geom;`;
}

/**
 * Which route relations *contain* the ones we just assembled. `relation(bbox)` does not
 * recurse into member relations, so no tile can ever see the Pacific Crest Trail itself —
 * only its sections, which look plausible enough to ship. `rel(br)` is the inverse. `out
 * tags` is right here and only here: ids and names are enough to decide what to fetch, and
 * a superroute's member lists are the expensive part.
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
 * Full geometry for named relations, selected by id so the response is bounded by the route
 * rather than by a box — the only way to get a long-distance trail in one piece.
 *
 * `maxsize` is well above the tile query's because a batch of route sections is legitimately
 * hundreds of megabytes of Overpass working memory. The timeout is deliberately *not* raised
 * to match: it stays inside the client's own abort window, since a server granted ten minutes
 * on a query we hang up on after three spends the rest generating a response nobody reads.
 * Bounding the response is the caller's job — see `ROUTE_BATCH_SIZE`. `out body geom` for the
 * same reason as the tile query.
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
 * A relation's member list without geometry — half the escape hatch for a section no mirror
 * will serve whole. Useless alone: only ever paired with `buildWayGeometryQuery`, whose
 * coordinates the caller splices back in.
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
 * Geometry for ways by id — the other half, and the expensive part of a route response, now
 * askable in batches the caller chooses. `fetchRelations` halves down to a single relation;
 * below that the unit is its ways.
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
 * Which country and region a point falls in. Run once per tile, not once per trail: a z9 tile
 * is ~78 km across, and the alternative is forty Nominatim calls against a one-per-second
 * policy. Admin levels 2–6 in one query because level 4 means "state" in the US, "region" in
 * France and nothing at all in some countries — the caller picks the most useful level present.
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
 * Waypoints and amenities across one whole tile, against its bbox padded by `PARKING_BUFFER_M` —
 * a trailhead car park is often up an access road beyond the edge. Glaciers are areas rather than
 * nodes, so `out center` gives one the point every other feature here already has. Which trail
 * each feature belongs to is decided locally, at `WAYPOINT_BUFFER_M`, in `attachWaypoints`.
 */
export function buildFeatureQuery(bbox: BBox, options: { timeoutS?: number } = {}): string {
  const [w, s, e, n] = bbox;
  const box = `${s},${w},${n},${e}`;
  const timeout = options.timeoutS ?? 90;

  return `[out:json][timeout:${timeout}];
(
  node["natural"~"^(peak|hill|saddle|spring|water|cave_entrance)$"](${box});
  node["mountain_pass"="yes"](${box});
  node["tourism"="viewpoint"](${box});
  node["waterway"="waterfall"](${box});
  node["amenity"~"^(parking|toilets|shelter|drinking_water)$"](${box});
  way["amenity"="parking"](${box});
  way["natural"="glacier"]["name"](${box});
  node["tourism"~"^(camp_site|alpine_hut|wilderness_hut)$"](${box});
  node["barrier"~"^(gate|stile)$"](${box});
  node["ford"="yes"](${box});
  node["information"="guidepost"](${box});
);
out center tags;`;
}
