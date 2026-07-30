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
