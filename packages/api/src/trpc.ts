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
   * So `INTERNAL_SERVER_ERROR` gets one fixed sentence and the real message stays where it is
   * useful — `console.error` in `app/api/trpc/[trpc]/route.ts`, which already logs the cause
   * with the procedure path beside it, and which goes to the server's log and nowhere else.
   *
   * **Only the 500s.** Every other code is a message this codebase wrote on purpose — "Sign in
   * to do that.", "That username was just taken." — and they are the whole of what a form has
   * to show a reader. The flattened Zod issues stay for the same reason: a field-level error
   * is what turns "Bad Request" into a highlighted input.
   */
  errorFormatter({ shape, error }) {
    const internal = shape.data.code === 'INTERNAL_SERVER_ERROR';
    return {
      ...shape,
      message: internal ? SERVER_FAULT : shape.message,
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
