/**
 * What the deployed drain measurably achieves. Every ceiling sized against throughput derives from
 * here, so one re-measurement retunes all of them together.
 */

/**
 * Tiles per hour the estate completes: 3600 / 126.2 s, the mean over the 50 `ingestDrain`
 * invocations of 2026-08-08 recorded against `PUMP_QUEUE_DEPTH` in `apps/ingest-worker/src/pump.ts`.
 *
 * Serial, with no concurrency to divide by: `apps/ingest-worker/host.json` sets
 * `maxConcurrentCalls: 1` against the `functionAppScaleLimit` of 1 in `infra/azure/ingest.bicep`.
 * The p90 of 540.1 s is 6.7 tiles an hour, so anything derived from this is a steady-state figure
 * and not a bound — a queue sized here is three times deeper in hours when tiles run p90.
 */
export const ESTATE_DRAIN_TILES_PER_HOUR = 28.5;

/** Jobs that drain in `hours` at the measured rate: what a wait horizon is worth as a queue depth. */
export function queueDepthForHours(hours: number): number {
  return Math.floor(ESTATE_DRAIN_TILES_PER_HOUR * hours);
}

/** Hours `depth` queued jobs take to drain — what a depth reading costs the reader behind it. */
export function hoursToDrain(depth: number): number {
  return depth / ESTATE_DRAIN_TILES_PER_HOUR;
}
