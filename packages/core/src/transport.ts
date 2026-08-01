/**
 * Which procedures travel on their own HTTP request.
 *
 * Both clients batch by default, and should: a screen that mounts and fires eight small
 * queries in the same tick gets one round trip instead of eight, which on a phone over
 * cellular is the difference between a screen that fills and a screen that stutters.
 *
 * The cost is that a batch resolves at the speed of its slowest member. That is a fair
 * trade when the members are comparable, and a bad one the moment they are not.
 *
 * They are not, here, and it produced a real defect rather than a theoretical one. Typing
 * a place name fires two queries on the same keystroke — `places.search` to ask the
 * gazetteer where that is, and `trails.browse` to ask what is in the current view. Over an
 * area we already hold, both are quick. Over one we do not, `trails.browse` kicks the
 * on-demand ingest and waits on Overpass:
 *
 *     GET /api/trpc/places.search,trails.browse … 200 in 31.0s
 *
 * The gazetteer had answered in about a second. The suggestions did not appear for
 * thirty-one, because they were sharing a response with a query that was busy downloading
 * a mountain range. The reader sees an empty dropdown and concludes we have never heard of
 * the place they are standing on — which is the exact complaint that put a geocoder in this
 * product in the first place.
 *
 * So the rule: **a procedure that waits on a server we do not own travels alone.** Its
 * latency is not ours to predict, and it must not become anybody else's.
 *
 * A list rather than a flag at each call site. tRPC's idiomatic escape hatch is per-call
 * context, but that scatters the decision across every caller and is silently forgettable —
 * a new call site simply does not opt out and the bug comes back somewhere else. This is
 * one place to read the whole policy, and one place to change it.
 */
export const UNBATCHED_PROCEDURES: readonly string[] = [
  // Overpass, via the lazy ingest pipeline. Tens of seconds over a cold viewport, and it is
  // fired by every pan and zoom, so it is the likeliest thing to be in flight when anything
  // else needs to be quick.
  'trails.browse',
  // Nominatim. Fast, but a shared public gazetteer that allows one request a second, so it
  // is queued rather than merely slow — and it sits under a cursor, where waiting shows.
  'places.search',
];

/** Does this procedure get its own request? `op.path` is the dotted path tRPC hands links. */
export function isUnbatched(path: string): boolean {
  return UNBATCHED_PROCEDURES.includes(path);
}

/**
 * How many procedures one HTTP request may carry.
 *
 * Batching is a convenience for our clients and a multiplier for everybody else. tRPC's
 * `maxBatchSize` is only enforced when it is a number — the check reads
 * `typeof maxBatchSize === 'number'`, and `allowBatching` defaults true — so leaving it
 * unset does not mean "some sensible default", it means no ceiling at all. One request
 * would run as many procedures as its URL had commas in it, which was demonstrated at
 * twenty-five in a single 306 ms call. Mutations batch in the POST body, so the URL length
 * limit is not a ceiling either.
 *
 * That is the finding this number closes, and the reason it matters is not the one request:
 * it is that every per-IP limit downstream of it — rate limiting, connection budget, the
 * ingest queue guard — silently counts requests while the cost is per procedure. An
 * unbounded multiplier makes all of them decorative.
 *
 * **What it is sized against.** Sixteen, against a measured worst case of seven.
 *
 * - The largest batch actually observed in a browser, driving the heaviest screens against
 *   production — explore with filters open, a trail page with weather and busyness, `/plan`,
 *   `/downloads` — was **five**, on a signed-out trail page:
 *   `weather.alongRoute,busyness.forWeek,weather.airQualityAt,reviews.summary,reviews.list`.
 * - Signed in, that same page adds `reviews.mine` and `lists.saveState`, both of which are
 *   `enabled` on having a viewer, for **seven** in one tick. That is the ceiling either
 *   client reaches; the mobile trail screen's heaviest tick is six.
 *
 * Sixteen is a shade over twice that, which is headroom for a screen growing a couple more
 * panels without anybody having to think about this file.
 *
 * **Both ends are pinned, and that is what makes it safe to be this tight.** A server that
 * refuses an oversized batch rejects the *whole* batch with `BAD_REQUEST`, so a screen that
 * one day fires seventeen queries would not degrade — it would break, and it would look like
 * the page breaking rather than like a limit. So the clients pass the same number as
 * `maxItems`, and tRPC's batch loader splits a tick that exceeds it into two requests
 * instead of building one the server will refuse. Our own clients therefore cannot trip
 * this; only somebody hand-rolling a request can, which is the only caller it is for.
 */
export const MAX_BATCH_SIZE = 16;
