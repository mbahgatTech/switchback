import type { QueryClient } from '@tanstack/react-query';

/**
 * Ask the server again after a write, refusing any answer that was already on its way. The phone
 * twin of `apps/web/src/lib/after-write.ts`.
 *
 * A plain `invalidateQueries` fired while a screen's opening batch is still in the air does
 * nothing: `Query.fetch` only honours `cancelRefetch` once the query has data, so a first fetch
 * is deduped into the request already running and the reply is a picture taken *before* the
 * write. Cancelling first discards that reply, making the refetch a genuinely new question.
 *
 * Only queries under the given filter are cancelled — tRPC's batch link aborts the HTTP request
 * only once every item in it has been cancelled, so the rest of the batch loads untouched.
 */
export async function askAgain(
  queryClient: QueryClient,
  // Taken from the client's own signature so it cannot drift from the installed `QueryFilters`.
  filter: Parameters<QueryClient['invalidateQueries']>[0],
): Promise<void> {
  await queryClient.cancelQueries(filter);
  await queryClient.invalidateQueries(filter);
}
