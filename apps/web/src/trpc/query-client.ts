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
      mutations: {
        /**
         * Send it, and let it fail.
         *
         * TanStack Query's default is `'online'`, which *pauses* a mutation while
         * `navigator.onLine` is false: `mutationFn` is never called and `mutateAsync` never
         * settles. That is reasonable for a form that can wait, and wrong for everything this
         * product queues. The whole offline design is built on a mutation rejecting with the
         * `TypeError` that `fetch` throws when it cannot connect — `isUnreachable` in
         * `offline/queue.ts` is written to recognise exactly that, and both the queued report
         * and the finished-with-no-signal hike are written from the resulting `catch`. Under
         * the default those `catch` blocks are unreachable code offline, which is the one
         * moment they exist for: pressing Finish at a trailhead with no bars left the dialog
         * on "Saving" for ever, the row with no `finish` payload, and the hike permanently
         * unfinishable.
         *
         * Queries keep the default. A read that cannot be made has nothing to record and
         * nothing to retry; pausing it is right.
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
