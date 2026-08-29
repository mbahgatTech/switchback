import { useEffect, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import superjson from 'superjson';
import { isUnbatched, MAX_BATCH_SIZE } from '@switchback/core';
import type { AppRouter } from '@switchback/api';
import { getAccessToken, subscribe } from '@/auth/session';
import { trpcUrl } from '@/config';
import { forgetAnswersOnIdentityChange } from './identity';

/**
 * The API client.
 *
 * `AppRouter` is a *type-only* import and must stay that way. The value side of
 * `@switchback/api` reaches Prisma and `node:crypto`, neither of which exists in Hermes —
 * Babel erases `import type` before Metro ever sees a dependency, which is what makes
 * sharing the router with a React Native app free rather than impossible. The tsconfig
 * omits the `@switchback/api/*` subpath alias so that an accidental value import fails at
 * typecheck instead of at runtime on the phone.
 */
export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        /**
         * A minute, not the default zero. On a phone every remount is a network request,
         * and a trail's stats do not change between two taps of the back button. The
         * numbers that *are* live — weather, busyness — set their own staleness at the
         * call site rather than dragging this default down for everything else.
         */
        staleTime: 60_000,
        retry: 2,
      },
    },
  });
}

export function ApiProvider({ children }: { children: React.ReactNode }) {
  // useState rather than useMemo: React is allowed to discard a memo, and a discarded
  // client would drop in-flight batches on the floor.
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() => {
    const options = {
      url: trpcUrl(),
      transformer: superjson,
      /**
       * Resolved per request, not per client. The access token is replaced every 15
       * minutes, so capturing one at construction would authenticate the first quarter
       * hour of the app's life and nothing after it.
       */
      headers: async () => {
        const token = await getAccessToken();
        return token ? { authorization: `Bearer ${token}` } : {};
      },
    };
    return createTRPCClient<AppRouter>({
      links: [
        // Batch by default; the procedures that wait on somebody else's server go alone.
        // `UNBATCHED_PROCEDURES` in @switchback/core says which, and why. This app has no
        // geocoder typeahead yet, so it is the second half of that note that applies here:
        // `trails.browse` fires on every pan and can sit on Overpass for half a minute, and
        // anything unlucky enough to share its request waits too.
        splitLink({
          condition: (op) => isUnbatched(op.path),
          true: httpLink(options),
          // `maxItems` is the client half of the server's `maxBatchSize`: a tick that
          // exceeds the ceiling splits into two requests rather than building one the
          // server will reject. See `MAX_BATCH_SIZE` in @switchback/core.
          false: httpBatchLink({ ...options, maxItems: MAX_BATCH_SIZE }),
        }),
      ],
    });
  });

  /*
   * Subscribed here rather than in `AuthProvider`, and that placement is load-bearing: React
   * runs a child's effects before its parent's, so this cache is empty before any screen
   * re-renders on the new status and the fetch that follows is the first one, not a second.
   */
  useEffect(() => forgetAnswersOnIdentityChange(queryClient, subscribe), [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
