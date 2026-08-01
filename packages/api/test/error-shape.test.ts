import { TRPCError } from '@trpc/server';
import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { describe, expect, it } from 'vitest';
import type { Context } from '../src/context';
import { deliberateServerError, publicProcedure, router } from '../src/trpc';

/**
 * What a client is actually told, read off the wire. `createCaller` throws the `TRPCError`
 * object straight back, so a unit test asserting on `error.message` passes whatever the error
 * formatter does afterwards — `fetchRequestHandler` is the only way to see the browser's shape.
 */
const appRouter = router({
  /** A resolver that lets an ordinary error escape — what a Prisma failure looks like. */
  unhandled: publicProcedure.query(() => {
    throw new Error('Invalid `prisma.trailList.findFirst()` invocation: column "kind" ...');
  }),
  /** A 500 whose sentence was written for the person reading it. */
  deliberate: publicProcedure.query(() => {
    throw deliberateServerError('Your saved lists are missing.');
  }),
  /** The same, carrying the upstream failure as its cause. */
  deliberateWithCause: publicProcedure.query(() => {
    throw deliberateServerError('Could not read air quality for that area.', new Error('503'));
  }),
  /** Anything that is not a 500. */
  refused: publicProcedure.query(() => {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to do that.' });
  }),
});

/** Call one procedure over HTTP and hand back the message the client would render. */
async function messageFor(path: string): Promise<string> {
  const response = await fetchRequestHandler({
    endpoint: '',
    req: new Request(`http://switchback.test/${path}`),
    router: appRouter,
    createContext: () => ({}) as unknown as Context,
  });
  const body = (await response.json()) as { error?: { json?: { message?: string } } };
  const message = body.error?.json?.message;
  expect(message, `no error message in ${JSON.stringify(body)}`).toBeTypeOf('string');
  return message ?? '';
}

describe('the error shape a client receives', () => {
  it('replaces the message on an unhandled 500', async () => {
    // Prisma answers a failed query with the SQL it was running, the table and column names in
    // it, and the Postgres error text. An attacker can act on that; a reader cannot.
    const message = await messageFor('unhandled');
    expect(message).toBe('Something on the server failed. Try again.');
    expect(message).not.toMatch(/prisma/iu);
  });

  it('keeps a 500 whose message was written for the reader', async () => {
    expect(await messageFor('deliberate')).toBe('Your saved lists are missing.');
  });

  it('keeps it when the error also carries a cause', async () => {
    // The cause is what reaches `console.error` in the tRPC route. It must not be mistaken
    // for evidence that the error was synthesised.
    expect(await messageFor('deliberateWithCause')).toBe(
      'Could not read air quality for that area.',
    );
  });

  it('leaves every other code alone', async () => {
    expect(await messageFor('refused')).toBe('Sign in to do that.');
  });
});
