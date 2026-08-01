import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { after } from 'next/server';
import { MAX_BATCH_SIZE } from '@switchback/core';
import { appRouter, createContext } from '@switchback/api';
import { auth } from '@/auth';

/** The single entry point for both clients. Node runtime, not edge: Prisma's query engine needs it. */
export const runtime = 'nodejs';

/**
 * How many procedures a batched request asked for, read off the URL — the cap rejects before
 * `info` is parsed, so the path list is the only place the count survives. 0 means unknown.
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
    /** Leaving this unset is not a default but an absence — see `MAX_BATCH_SIZE`. */
    maxBatchSize: MAX_BATCH_SIZE,
    createContext: () =>
      createContext({
        headers: req.headers,
        getWebSession: auth,
        // Lets a viewport request start ingesting its missing tiles once the response is on the
        // wire. Nothing depends on it finishing; the cron drain picks up whatever `after` drops.
        waitUntil: (work) => {
          after(work);
        },
      }),
    onError({ error, path }) {
      // Anything 500-class is ours. Client errors are the system working.
      if (error.code === 'INTERNAL_SERVER_ERROR') {
        console.error(`tRPC ${path ?? '<no path>'} failed:`, error.cause ?? error);
        return;
      }

      /*
       * The one client error worth a line: tRPC rejects an oversized batch with a bare
       * `BAD_REQUEST` carrying no count and no ceiling, which the 500-only filter above dropped —
       * leaving the cap and the absence of the cap identical from the logs. Warn, not error: the
       * request was refused correctly.
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
