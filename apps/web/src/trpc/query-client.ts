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
        /** 30 s, not 0: with SSR a zero stale time discards the data streamed with the page. */
        staleTime: 30_000,
        retry: (failureCount, error) => {
          // Retrying a 401 or a 404 cannot succeed; it just delays the error boundary.
          const status = (error as { data?: { httpStatus?: number } }).data?.httpStatus;
          if (status && status >= 400 && status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: {
        /**
         * **Not the default `'online'`**, which *pauses* a mutation while `navigator.onLine` is
         * false — `mutationFn` is never called and `mutateAsync` never settles. The whole offline
         * design depends on a mutation rejecting with the `TypeError` `fetch` throws when it
         * cannot connect: `isUnreachable` in `offline/queue.ts` recognises exactly that, and both
         * the queued report and the finished-with-no-signal hike are written from that `catch`.
         *
         * Queries keep the default — a read that cannot be made has nothing to record.
         */
        networkMode: 'always',
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
