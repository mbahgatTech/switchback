import type { QueryClient } from '@tanstack/react-query';

/**
 * Ask the server again after a write — and refuse any answer that was already on its way.
 *
 * The phone twin of `apps/web/src/lib/after-write.ts`, and the same bug it was written for.
 * Every screen here opens by firing one batched request; the trail screen's carries the
 * weather, the busyness week, the save state and the reports together, and the weather half
 * of it goes out to Open-Meteo. A plain `invalidateQueries` fired while that batch is still
 * in the air does nothing at all: `Query.fetch` in `@tanstack/query-core` only honours
 * `cancelRefetch` when the query already has data, so a query in its very first fetch is
 * deduped into the request already running. The reply that eventually arrives is a picture
 * taken *before* the write. The report is in Postgres, the form has closed, and the trail
 * says nobody has reported on it yet.
 *
 * **The window is wider here than on a desk.** A browser asks this over house wifi and the
 * batch is back in a few hundred milliseconds. A phone asks it from a lay-by with one bar,
 * over a radio that has to wake up first, and the hiker filing the report is the one person
 * guaranteed to be somewhere with bad signal — this is a trail app. The gap between paint and
 * first reply is where they tap Favourite and start typing, not a sliver before it.
 *
 * Cancelling first is what makes the invalidation mean something: the reply in flight is
 * discarded rather than believed, and the refetch is then a genuinely new question asked
 * after the write. In the ordinary case there is no fetch in flight and the cancel is free.
 *
 * Only the queries under the given filter are cancelled. tRPC's batch link aborts the
 * underlying HTTP request only once every item in it has been cancelled, so the weather and
 * the busyness curve sharing that batch carry on loading untouched.
 */
export async function askAgain(
  queryClient: QueryClient,
  // The filter a tRPC `pathFilter()` produces, taken from the client's own signature so it
  // cannot drift from whatever `QueryFilters` means in the installed version.
  filter: Parameters<QueryClient['invalidateQueries']>[0],
): Promise<void> {
  await queryClient.cancelQueries(filter);
  await queryClient.invalidateQueries(filter);
}
