/**
 * tRPC initialisation: the transformer, the error shape, and the three procedure tiers.
 *
 * Everything that needs `t` lives here and nothing else does, because `initTRPC` must be
 * called exactly once per app — call it twice and you get two incompatible `router`
 * builders whose types look identical and whose runtime does not.
 */
import { TRPCError, initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import type { User } from '@switchback/db';
import type { Context } from './context';

/**
 * The one sentence every unhandled failure says.
 *
 * It reports what happened and what to do, and nothing about why — a reader cannot act on a
 * Postgres error and an attacker can. "Try again" is honest here: a 500 in this app is a
 * timed-out query or a dropped connection far more often than it is a bug, and both of those
 * do go away.
 */
const SERVER_FAULT = 'Something on the server failed. Try again.';

/**
 * The mark that says "this 500's message was written for a reader".
 *
 * `Symbol.for` rather than a module-local symbol: `packages/api` is transpiled by Next as
 * well as loaded directly by tests and cron routes, and two module instances holding two
 * private symbols would silently stop matching — which would look exactly like the bug this
 * exists to prevent, only intermittently.
 */
const DELIBERATE = Symbol.for('switchback.trpc.deliberate-message');

/**
 * A 500 that says something specific, and means to.
 *
 * Most `INTERNAL_SERVER_ERROR`s here are not thrown at all — tRPC synthesises them around
 * whatever a resolver let escape, and their message is Prisma's. Those get scrubbed. A few
 * are thrown deliberately, with a sentence somebody wrote for the person reading it: the
 * saved-lists row that is missing, a trail whose geometry is corrupt, an air-quality overlay
 * that could not be built. Those are the whole of what the failing component has to show, and
 * `save-controls.tsx` renders `error.message` raw.
 *
 * The blanket scrub swallowed all four, which among other things made `asAirQualityError` in
 * `routers/weather.ts` do nothing at all — both of its branches came out as the same generic
 * sentence, and its own comment about not sending a reader looking for a broken trail stopped
 * being true. Nothing caught it: the unit tests assert on the `TRPCError` before serialisation,
 * and serialisation is where the message was replaced.
 *
 * Marked rather than moved off code 500. The codes are load-bearing beyond the message —
 * `trpc/query-client.ts` refuses to retry a 4xx, and `app/trails/[slug]/page.tsx` turns a
 * `NOT_FOUND` into a 404 page, which would swallow "That trail has no usable geometry."
 * entirely. A 500 is the honest code for all four: something on our side is broken.
 */
export function deliberateServerError(message: string, cause?: unknown): TRPCError {
  const error = new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message, cause });
  Object.defineProperty(error, DELIBERATE, { value: true, enumerable: false });
  return error;
}

/** Whether the client may see this error's own message, or gets `SERVER_FAULT` instead. */
function writtenForTheReader(error: TRPCError, code: string): boolean {
  return code !== 'INTERNAL_SERVER_ERROR' || DELIBERATE in error;
}

const t = initTRPC.context<Context>().create({
  /**
   * superjson because the domain is full of `Date` — `hikedOn`, `capturedAt`, every
   * forecast timestamp. Plain JSON turns those into strings, and a client that has to
   * remember which fields to `new Date()` gets it wrong eventually.
   */
  transformer: superjson,
  /**
   * What a client is told when something fails.
   *
   * The default shape carries `error.message` straight through, and for a 500 that message is
   * whatever threw — which here means Prisma. A failed query answers with the SQL it was
   * running, the table and column names in it, and the Postgres error text: schema, and a
   * clear map of what to probe next, handed to whoever asked. Nobody has ever acted usefully
   * on one of those in a browser.
   *
   * So an unhandled `INTERNAL_SERVER_ERROR` gets one fixed sentence and the real message stays
   * where it is useful — `console.error` in `app/api/trpc/[trpc]/route.ts`, which already logs
   * the cause with the procedure path beside it, and which goes to the server's log and
   * nowhere else.
   *
   * **Not every 500.** Every other code is a message this codebase wrote on purpose — "Sign in
   * to do that.", "That username was just taken." — and they are the whole of what a form has
   * to show a reader. So are the four 500s built by `deliberateServerError` above, which is
   * what the mark is for: scrubbing those replaced copy written for one exact situation with a
   * sentence that sends the reader nowhere. The flattened Zod issues stay for the same reason:
   * a field-level error is what turns "Bad Request" into a highlighted input.
   */
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      message: writtenForTheReader(error, shape.data.code) ? shape.message : SERVER_FAULT,
      data: {
        ...shape.data,
        // Flattened zod issues, so a form can map them to fields instead of showing one
        // opaque "Bad Request".
        zod: error.cause instanceof ZodError ? error.cause.flatten() : null,
      },
    };
  },
});

export const router = t.router;
export const middleware = t.middleware;
export const mergeRouters = t.mergeRouters;
/** Lets server code call procedures directly — used by cron routes and tests. */
export const createCallerFactory = t.createCallerFactory;

export const publicProcedure = t.procedure;

/** Context after auth, with `user` narrowed to non-null so procedures need no check. */
export interface AuthedContext extends Context {
  user: User;
}

const enforceAuth = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Sign in to do that.' });
  }
  return next({ ctx: { ...ctx, user: ctx.user } satisfies AuthedContext });
});

/**
 * Plus entitlement.
 *
 * Checks the expiry as well as the flag: a lapsed subscription leaves `isPlus` true until
 * the billing webhook lands, and a webhook that is late or lost should not hand out
 * offline downloads indefinitely. A null `plusUntil` means a grant with no end date —
 * comped accounts, the developer's own — and stays valid.
 */
const enforcePlus = enforceAuth.unstable_pipe(({ ctx, next }) => {
  const lapsed = ctx.user.plusUntil !== null && ctx.user.plusUntil.getTime() < Date.now();
  if (!ctx.user.isPlus || lapsed) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That needs Switchback Plus.' });
  }
  return next({ ctx });
});

export const protectedProcedure = t.procedure.use(enforceAuth);
export const plusProcedure = t.procedure.use(enforcePlus);
