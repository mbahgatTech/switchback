/**
 * What the deployed drain measurably achieves. Every ceiling sized against throughput derives from
 * here, so one re-measurement retunes all of them together.
 */

/**
 * Tiles per hour a drainer completes while it is draining tiles: 3600 / 126.2 s, the mean over the
 * 50 `ingestDrain` invocations of 2026-08-08 recorded against `PUMP_QUEUE_DEPTH` in
 * `apps/ingest-worker/src/pump.ts`.
 *
 * Serial, with no concurrency to divide by: `apps/ingest-worker/host.json` sets
 * `maxConcurrentCalls: 1` against the `functionAppScaleLimit` of 1 in `infra/azure/ingest.bicep`.
 *
 * **Not a request-kind rate on its own** — see `REQUEST_DRAIN_TILES_PER_HOUR`, which is what a
 * request-kind queue depth must be divided by.
 *
 * **Two things date this number, both pushing the true rate up.** It predates the shared terrain
 * cache (`terrain-cache-r2.ts`, 2026-08-29), which removes a per-invocation terrarium fetch from
 * exactly the phase being timed; and the p90 of 540.1 s is 6.7 an hour, so the distribution behind
 * this mean is wide. Re-measuring is `03-throughput.sql`; treat a ceiling built on it as a floor on
 * capacity rather than a forecast.
 */
export const ESTATE_DRAIN_TILES_PER_HOUR = 28.5;

/**
 * The pump's refill shape, mirrored from `PUMP_QUEUE_DEPTH` and `PUMP_DERIVED_SHARE`.
 *
 * Restated rather than imported because `packages/ingest` cannot depend on the app that runs it.
 * `apps/ingest-worker/test/pump.test.ts` keeps the two equal — it can see both.
 */
export const PUMP_MESSAGES_PER_REFILL = 8;
export const PUMP_MESSAGES_FOR_DERIVED = 2;

/**
 * The share of drained messages that carry a *request* kind. The worker takes one job per message
 * (`limit: 1, derivedLimit: 0` in `apps/ingest-worker/src/drain.ts`) and the pump reserves the
 * derived band, so this ratio of messages is the ratio of invocations.
 */
export const REQUEST_DRAIN_SHARE =
  (PUMP_MESSAGES_PER_REFILL - PUMP_MESSAGES_FOR_DERIVED) / PUMP_MESSAGES_PER_REFILL;

/**
 * Request-kind tiles per hour: the number a request-kind queue depth must be divided by, and a
 * deliberate lower bound.
 *
 * Two of every eight messages are `enrich_trail`/`ingest_route`, and the worker is serial, so those
 * invocations are wall clock a request tile does not get. Charging them a full tile's duration is
 * the worst case — they are a lookup and an image fetch (`DEFAULT_DERIVED_SHARE`), so the true rate
 * sits between this and `ESTATE_DRAIN_TILES_PER_HOUR`, approaching the latter as derived work gets
 * cheaper. Sizing against the bound keeps the promise good at either end: a ceiling may deliver a
 * shorter wait than it advertises, never a longer one.
 *
 * **UNVERIFIED at the true value.** Q6 of `scripts/ingest-metrics/04-queue-depth.sql` measures the
 * request-kind completion rate directly and would replace this bound with an observation.
 */
export const REQUEST_DRAIN_TILES_PER_HOUR = ESTATE_DRAIN_TILES_PER_HOUR * REQUEST_DRAIN_SHARE;

/** Request jobs that drain in `hours`: what a wait horizon is worth as a queue depth. */
export function queueDepthForHours(hours: number): number {
  return Math.floor(REQUEST_DRAIN_TILES_PER_HOUR * hours);
}

/** Hours `depth` queued request jobs take to drain — what a depth reading costs the reader behind it. */
export function hoursToDrain(depth: number): number {
  return depth / REQUEST_DRAIN_TILES_PER_HOUR;
}
