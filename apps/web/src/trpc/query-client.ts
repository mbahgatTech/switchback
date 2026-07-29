import { QueryClient, defaultShouldDehydrateQuery } from '@tanstack/react-query';
import superjson from 'superjson';

/**
 * One place both the browser and the server build a QueryClient, so a query hydrated
 * during SSR lands in a cache configured the same way as the one that will refetch it.
 */
export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /**
         * 30 seconds rather than 0. With SSR, a zero stale time means every query
         * refetches the instant it reaches the client, which throws away the data that
         * was just streamed down with the page.
         */
        staleTime: 30_000,
        retry: (failureCount, error) => {
          // Retrying a 401 or a 404 cannot succeed; it just delays the error boundary.
          const status = (error as { data?: { httpStatus?: number } }).data?.httpStatus;
          if (status && status >= 400 && status < 500) return false;
          return failureCount < 2;
        },
      },
      dehydrate: {
        serializeData: superjson.serialize,
        // Also ship queries that are still in flight, so the client picks up a pending
        // fetch instead of starting a second one.
        shouldDehydrateQuery: (query) =>
          defaultShouldDehydrateQuery(query) || query.state.status === 'pending',
      },
      hydrate: { deserializeData: superjson.deserialize },
    },
  });
}
