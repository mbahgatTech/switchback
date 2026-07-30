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
import { canAdminister, canModerate } from '@switchback/core';
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

/**
 * The takedown lever.
 *
 * **Piped onto `enforceAuth`, and the role is read from `ctx.user`** — which `createContext`
 * loaded from the database on this request — rather than from anything the caller sent. A
 * session cookie proves who you are; it carries no claim about what you may do, and the one
 * mistake this tier exists to make impossible is trusting a client that says it is an
 * operator.
 *
 * It is a *procedure tier*, not a check the UI performs. Every moderation procedure is built
 * on one of these two, so hiding a button changes what is easy and changes nothing about
 * what is permitted: a signed-in member calling `moderation.hide` directly over HTTP gets a
 * FORBIDDEN from this middleware before the resolver runs and before the database is
 * touched. `packages/api/test/moderation.test.ts` asserts exactly that, for both tiers.
 *
 * The message says what is true rather than pretending the procedure does not exist. A 404
 * would leak slightly less and would send an operator whose role was never granted looking
 * for a bug in the client.
 */
const enforceModerator = enforceAuth.unstable_pipe(({ ctx, next }) => {
  if (!canModerate(ctx.user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That needs a moderator.' });
  }
  return next({ ctx });
});

/**
 * Changing somebody's role, and nothing else.
 *
 * Separate from `enforceModerator` because the two privileges must not travel together: a
 * moderator who can appoint moderators is an administrator, and the role column would then
 * be documenting a distinction the code does not keep.
 */
const enforceAdmin = enforceAuth.unstable_pipe(({ ctx, next }) => {
  if (!canAdminister(ctx.user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That needs an administrator.' });
  }
  return next({ ctx });
});

export const moderatorProcedure = t.procedure.use(enforceModerator);
export const adminProcedure = t.procedure.use(enforceAdmin);
