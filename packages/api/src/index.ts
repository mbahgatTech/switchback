export { appRouter, type AppRouter } from './root';
export { createContext, type Context, type CreateContextOptions, type WebSession } from './context';
export { ensureSystemLists } from './provisioning';
export {
  createCallerFactory,
  middleware,
  plusProcedure,
  protectedProcedure,
  publicProcedure,
  router,
  type AuthedContext,
} from './trpc';

/**
 * Inference helpers. The clients import these rather than reaching into `@trpc/server`,
 * so a tRPC major upgrade is a change in this package and nowhere else.
 */
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from './root';

export type { inferRouterInputs, inferRouterOutputs };

export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
