import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { after } from 'next/server';
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

function handler(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: '/api/trpc',
    req,
    router: appRouter,
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
      }
    },
  });
}

export { handler as GET, handler as POST };
