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

const t = initTRPC.context<Context>().create({
  /**
   * superjson because the domain is full of `Date` — `hikedOn`, `capturedAt`, every
   * forecast timestamp. Plain JSON turns those into strings, and a client that has to
   * remember which fields to `new Date()` gets it wrong eventually.
   */
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
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
