/**
 * Which tRPC procedures travel on their own HTTP request, and how large a batch may be. A batch
 * resolves at the speed of its slowest member, so the rule is: **a procedure that waits on a
 * server we do not own travels alone.** A list rather than a per-call-site flag, because a new
 * call site that forgets to opt out brings the defect back somewhere else.
 */
export const UNBATCHED_PROCEDURES: readonly string[] = [
  // Overpass, via the lazy ingest pipeline. Tens of seconds over a cold viewport, and fired by
  // every pan and zoom, so it is the likeliest thing to be in flight when anything else needs
  // to be quick.
  'trails.browse',
  // Nominatim: a shared public gazetteer that allows one request a second, so it is queued
  // rather than merely slow — and it sits under a cursor, where waiting shows.
  'places.search',
];

/** Does this procedure get its own request? `op.path` is the dotted path tRPC hands links. */
export function isUnbatched(path: string): boolean {
  return UNBATCHED_PROCEDURES.includes(path);
}

/**
 * How many procedures one HTTP request may carry. Must stay a number: tRPC checks
 * `typeof maxBatchSize === 'number'` and `allowBatching` defaults true, so leaving it unset is
 * no ceiling at all — and every per-IP limit downstream counts requests while the cost is per
 * procedure. Sixteen against a measured worst case of seven (a signed-in trail page).
 *
 * The clients must pass this same number as `maxItems`. An oversized batch is rejected whole
 * with `BAD_REQUEST`, so without that the seventeenth query on a screen breaks the page rather
 * than splitting into a second request.
 */
export const MAX_BATCH_SIZE = 16;
