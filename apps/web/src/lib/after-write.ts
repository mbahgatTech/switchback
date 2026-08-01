import type { QueryClient } from '@tanstack/react-query';

/**
 * Ask the server again after a write, refusing any answer already in flight.
 *
 * The cancel is what makes the invalidation mean anything: `invalidateQueries` restarts a fetch
 * only if the query already has data, so a query still in its *first* fetch — every page opens
 * with one slow batched request — dedupes into the request already running and then overwrites
 * the fresh write with a picture taken before it. Only queries under the filter are cancelled,
 * so the rest of the tRPC batch carries on loading.
 */
export async function askAgain(
  queryClient: QueryClient,
  // Taken from the client's own signature so it cannot drift from the installed `QueryFilters`.
  filter: Parameters<QueryClient['invalidateQueries']>[0],
): Promise<void> {
  await queryClient.cancelQueries(filter);
  await queryClient.invalidateQueries(filter);
}
