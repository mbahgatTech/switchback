import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { after } from 'next/server';
import { MAX_BATCH_SIZE } from '@switchback/core';
import { appRouter, createContext } from '@switchback/api';
import { auth } from '@/auth';

/**
 * The single entry point for both clients.
 *
 * Node runtime, not edge: Prisma's query engine needs it. That is a deliberate trade —
 * edge would shave latency off a cold start, but every procedure touches Postgres anyway,
 * and running two runtimes means two sets of bugs.
 */
export const runtime = 'nodejs';

/**
 * How many procedures a batched request asked for, read off the URL.
 *
 * tRPC batches as `/api/trpc/a.one,b.two,c.three?batch=1`, and when the cap rejects the
 * request it does so before `info` is parsed — so the path list is the only place the count
 * survives. Returns 0 when there is nothing countable, which reads as "unknown" at the one
 * call site rather than as a real batch of nothing.
 */
function batchLength(url: string): number {
  const path = new URL(url).pathname.replace(/^\/api\/trpc\/?/u, '');
  if (path === '') return 0;
  return path.split(',').filter((part) => part !== '').length;
}

function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
    /**
     * The ceiling on how many procedures one request may run. See `MAX_BATCH_SIZE` in
     * `@switchback/core` for what it is sized against and why leaving it unset is not a
     * default but an absence.
     */
    maxBatchSize: MAX_BATCH_SIZE,
    createContext: () =>
      createContext({
        headers: req.headers,
        getWebSession: auth,
        // Lets a viewport request start ingesting its missing tiles the moment the
        // response is on the wire. Nothing depends on it finishing — whatever `after`
        // drops through a timeout or a deploy, the cron drain picks up a minute later.
        waitUntil: (work) => {
          after(work);
        },
      }),
    onError({ error, path }) {
      // Anything 500-class is ours. Client errors (bad input, unauthorized) are the
      // system working and would drown the signal.
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        console.error(`tRPC ${path ?? '<no path>'} failed:`, error.cause ?? error);
        return;
      }

      /*
       * The one client error worth a line, because it is the only refusal in this app that
       * an operator cannot otherwise see happen.
       *
       * tRPC rejects an oversized batch with a bare `BAD_REQUEST` reading "Batch call
       * exceeds maximum size" — no count, no ceiling — and the 500-only filter above dropped
       * it. That left the cap and the absence of the cap looking identical from the logs, in
       * the two states where the difference matters: somebody hand-rolling oversized batches,
       * which is the abuse `MAX_BATCH_SIZE` exists for and which would fire on every request
       * while producing no evidence it ever fired; and an installed mobile binary pinned to
       * an older, larger `maxItems` than the deployed server, where every batched tick fails
       * whole with a 400 and nothing on the server points at why.
       *
       * Warn rather than error: the request was refused correctly. Named like the ingest
       * refusals — what tripped, and what it hit.
       */
      if (error.code === 'BAD_REQUEST' && /batch call exceeds maximum size/iu.test(error.message)) {
        const asked = batchLength(req.url);
        console.warn(
          `tRPC batch refused: ${asked > 0 ? String(asked) : 'an unreadable number of'} calls in one request, ceiling ${MAX_BATCH_SIZE}`,
        );
      }
    },
  });
}

export { handler as GET, handler as POST };
