import 'server-only';
import { cache } from 'react';
import { headers } from 'next/headers';
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query';
import { appRouter, createCallerFactory, createContext } from '@switchback/api';
import { auth } from '@/auth';
import { makeQueryClient } from './query-client';

/**
 * Server-side tRPC. Server components call procedures in-process — no HTTP, no serialisation —
 * under the identical names the client uses, so there is one API that does not fork by
 * rendering environment.
 */

/** `cache` scopes this to one request, so a page and its children share a QueryClient. */
export const getQueryClient = cache(makeQueryClient);

const getContext = cache(async () =>
  createContext({ headers: await headers(), getWebSession: auth }),
);

/**
 * For prefetching into the QueryClient that streams to the browser: a server component prefetches
 * with `trpc.x.y.queryOptions()`, and the client's `useQuery` on the same key renders from it.
 */
export const trpc = createTRPCOptionsProxy({
  ctx: getContext,
  router: appRouter,
  queryClient: getQueryClient,
});

/**
 * For a value the server component renders itself. The options proxy above only produces
 * *options*; awaiting a procedure needs a caller, and sharing the request-scoped context keeps
 * `ctx.user` identical between the two.
 */
export const caller = createCallerFactory(appRouter)(getContext);
