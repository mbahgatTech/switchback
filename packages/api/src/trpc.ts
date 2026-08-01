/**
 * tRPC initialisation: the transformer, the error shape, and the procedure tiers. `initTRPC`
 * must be called exactly once per app, so everything needing `t` lives here — calling it twice
 * gives two incompatible `router` builders whose types look identical and whose runtime is not.
 */
import { TRPCError, initTRPC } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';
import { canAdminister, canModerate } from '@switchback/core';
import type { User } from '@switchback/db';
import type { Context } from './context';

/** The one sentence every unhandled failure says: what happened and what to do, never why. */
const SERVER_FAULT = 'Something on the server failed. Try again.';

/**
 * The mark that says "this 500's message was written for a reader". `Symbol.for` rather than a
 * module-local symbol: this package is transpiled by Next as well as loaded directly by tests
 * and cron routes, and two module instances holding two private symbols would stop matching.
 */
const DELIBERATE = Symbol.for('switchback.trpc.deliberate-message');

/**
 * A 500 that says something specific and means to — a corrupt trail geometry, a missing
 * saved-lists row — where most `INTERNAL_SERVER_ERROR`s are synthesised around whatever a
 * resolver let escape and carry Prisma's message. Only these survive the scrub below.
 *
 * Marked rather than moved off code 500, because the codes are load-bearing elsewhere:
 * `trpc/query-client.ts` refuses to retry a 4xx, and `app/trails/[slug]/page.tsx` turns a
 * `NOT_FOUND` into a 404 page, which would swallow the message entirely.
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
  /** superjson because the domain is full of `Date`; plain JSON turns those into strings. */
  transformer: superjson,
  /**
   * An unhandled `INTERNAL_SERVER_ERROR` gets one fixed sentence: the default shape carries
   * `error.message` through, and for a 500 that is Prisma's — the SQL, the table and column
   * names, and the Postgres error text, handed to whoever asked. The real message stays in
   * `console.error` in `app/api/trpc/[trpc]/route.ts`, which logs the cause with the procedure
   * path.
   *
   * Every other code, and the 500s marked by `deliberateServerError`, are messages this
   * codebase wrote on purpose and are the whole of what a form has to show. The flattened Zod
   * issues stay for the same reason.
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
 * Plus entitlement. Checks the expiry as well as the flag: a lapsed subscription leaves
 * `isPlus` true until the billing webhook lands. A null `plusUntil` is a grant with no end
 * date and stays valid.
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
 * The takedown lever. Piped onto `enforceAuth`, and **the role is read from `ctx.user`**, which
 * `createContext` loaded from the database on this request, never from anything the caller
 * sent. A procedure tier, not a check the UI performs: a signed-in member calling
 * `moderation.hide` directly over HTTP is refused before the resolver runs and before the
 * database is touched. `packages/api/test/moderation.test.ts` asserts that for both tiers.
 */
const enforceModerator = enforceAuth.unstable_pipe(({ ctx, next }) => {
  if (!canModerate(ctx.user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That needs a moderator.' });
  }
  return next({ ctx });
});

/**
 * Changing somebody's role, and nothing else. Separate from `enforceModerator` because the two
 * privileges must not travel together: a moderator who can appoint moderators is an
 * administrator, and the role column would document a distinction the code does not keep.
 */
const enforceAdmin = enforceAuth.unstable_pipe(({ ctx, next }) => {
  if (!canAdminister(ctx.user.role)) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'That needs an administrator.' });
  }
  return next({ ctx });
});

export const moderatorProcedure = t.procedure.use(enforceModerator);
export const adminProcedure = t.procedure.use(enforceAdmin);
