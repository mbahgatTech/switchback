'use client';

import { useState } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { createTRPCClient, httpBatchLink, httpLink, splitLink } from '@trpc/client';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import superjson from 'superjson';
import { isUnbatched, MAX_BATCH_SIZE } from '@switchback/core';
import type { AppRouter } from '@switchback/api';
import { makeQueryClient } from './query-client';

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

let browserQueryClient: QueryClient | undefined;

/**
 * On the server, a fresh client per request — sharing one would leak one user's cached
 * data into another's render. In the browser, a single client for the tab's lifetime, or
 * suspense would discard the cache on every re-render during hydration.
 */
function getQueryClient(): QueryClient {
  if (typeof window === 'undefined') return makeQueryClient();
  browserQueryClient ??= makeQueryClient();
  return browserQueryClient;
}

function getBaseUrl(): string {
  if (typeof window !== 'undefined') return '';
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

export function TRPCReactProvider({ children }: { children: React.ReactNode }) {
  const queryClient = getQueryClient();
  // useState, not useMemo: React may discard a memo, and a discarded tRPC client would
  // silently drop in-flight batches.
  const [trpcClient] = useState(() => {
    const options = { url: `${getBaseUrl()}/api/trpc`, transformer: superjson };
    return createTRPCClient<AppRouter>({
      links: [
        // Batch by default; the procedures that wait on somebody else's server go alone.
        // `UNBATCHED_PROCEDURES` in @switchback/core says which, and why.
        splitLink({
          condition: (op) => isUnbatched(op.path),
          true: httpLink(options),
          // `maxItems` is the client half of the server's `maxBatchSize`, and it is here so
          // that a tick which somehow exceeds the ceiling splits into two requests rather
          // than building one the server will reject outright. Same constant on both ends,
          // for the reason `MAX_BATCH_SIZE` gives.
          false: httpBatchLink({ ...options, maxItems: MAX_BATCH_SIZE }),
        }),
      ],
    });
  });

  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </QueryClientProvider>
  );
}
