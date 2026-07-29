import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { appRouter, createCallerFactory, createContext } from '@switchback/api';
import { auth } from '@/auth';
import { makeQueryClient } from './query-client';

/**
 * Server-side tRPC.
 *
 * Server components call procedures directly — in-process, no HTTP, no serialisation
 * round trip — while using the identical procedure names the client uses. That is the
 * point of doing it this way rather than exporting a second set of data-fetching
 * functions: there is one API, and it does not fork by rendering environment.
 */

/** `cache` scopes this to one request, so a page and its children share a QueryClient. */
export const getQueryClient = cache(makeQueryClient);

const getContext = cache(async () =>
  createContext({ headers: await headers(), getWebSession: auth }),
);

/**
 * For prefetching into the QueryClient that gets streamed to the browser: a server
 * component calls `queryClient.prefetchQuery(trpc.x.y.queryOptions())`, the result
 * dehydrates with the page, and the client component's `useQuery` on the same key
 * renders from it without a second request.
 */
export const trpc = createTRPCOptionsProxy({
  ctx: getContext,
  router: appRouter,
  queryClient: getQueryClient,
});

/**
 * For reading a value the server component renders itself and does not hand to a client
 * component. The options proxy above only ever produces *options*; awaiting a procedure
 * needs a caller, and passing the same request-scoped context keeps `ctx.user` identical
 * between the two.
 */
export const caller = createCallerFactory(appRouter)(getContext);
