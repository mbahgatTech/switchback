import type { QueryClient } from '@tanstack/react-query';

/**
 * Ask the server again after a write — and refuse any answer that was already on its way.
 *
 * Every page in this product opens by firing one batched request. The trail page's carries
 * the weather, the busyness week, the save state and the reviews together, and the weather
 * half of it goes out to Open-Meteo, so on a cold route the whole batch can still be in the
 * air a second or two after the page paints. That is long enough for somebody to press
 * Favourite, or pick a rating and file a report.
 *
 * When a write lands inside that window, a plain `invalidateQueries` does nothing at all.
 * It cancels an in-flight fetch and starts a fresh one *only if the query already has data*
 * (`Query.fetch` in `@tanstack/query-core`); a query still in its very first fetch has
 * `data === undefined`, so the invalidation is deduped into the request already running.
 * The reply that eventually arrives is a picture taken **before** the write — the report is
 * in Postgres, the form has closed, and the trail says nobody has reported on it yet. The
 * same shape sinks an optimistic update: the stale reply overwrites the mark we just drew.
 *
 * Cancelling first is what makes the invalidation mean something. The reply in flight is
 * discarded rather than believed, and the refetch below is then a genuinely new question
 * asked after the write. It costs nothing in the ordinary case, where there is no fetch in
 * flight and the cancel is a no-op.
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
