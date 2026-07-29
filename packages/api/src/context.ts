/**
 * Request context.
 *
 * Built once per request and handed to every procedure. Two things are worth explaining.
 *
 * **Why `getWebSession` is injected rather than imported.** Auth.js is configured in
 * `apps/web/auth.ts`, because its config is bound to Next's cookie and redirect handling.
 * If this package imported it, `packages/api` would depend on `apps/web`, and the Expo
 * app — which imports the router *type* from here — would drag a Next.js module graph
 * behind it. So the web route handler passes its `auth` function in, and this package
 * stays a leaf.
 *
 * **Why there are two ways to be signed in.** The website sends a session cookie; the iOS
 * app sends `Authorization: Bearer`. Resolving both here means not a single procedure has
 * to care which client it is talking to.
 */
import type { PrismaClient, User } from '@switchback/db';
import { prisma } from '@switchback/db';
import { verifyAccessToken } from './tokens';

/** The subset of the Auth.js session this package relies on. */
export interface WebSession {
  user?: { id?: string | null } | null;
}

export interface CreateContextOptions {
  headers: Headers;
  /** Auth.js `auth()`, injected by the web app. Omitted on the mobile-only path. */
  getWebSession?: () => Promise<WebSession | null>;
  db?: PrismaClient;
  /**
   * Keeps work alive after the response has been sent. The web route passes Next's
   * `after`; a test or a script passes nothing and the work simply falls to the cron.
   *
   * Injected for the same reason `getWebSession` is: `after` is a Next module, and this
   * package must stay importable from Expo's bundler.
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

/**
 * The signed-in user, or null.
 *
 * The whole row, not just an id: nearly every protected procedure needs `isPlus` or
 * `units`, and fetching it here is one query per request instead of one per procedure.
 */
export interface Context {
  db: PrismaClient;
  user: User | null;
  headers: Headers;
  /** How the caller authenticated. Useful for logging and for rate limits later. */
  authMethod: 'session' | 'bearer' | null;
  /**
   * Runs work after the response is sent, when the platform supports it. Absent means
   * "no background work here" — every caller must still be correct without it, which is
   * why the ingest queue is durable rather than relying on this.
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

export async function createContext(opts: CreateContextOptions): Promise<Context> {
  const db = opts.db ?? prisma;
  const base = { db, headers: opts.headers, waitUntil: opts.waitUntil };

  const bearer = opts.headers.get('authorization');
  if (bearer?.toLowerCase().startsWith('bearer ')) {
    const userId = await verifyAccessToken(bearer.slice(7).trim());
    if (userId) {
      const user = await db.user.findUnique({ where: { id: userId } });
      // A token whose user was deleted verifies fine but must not authenticate anyone.
      if (user) return { ...base, user, authMethod: 'bearer' };
    }
    // A bad bearer token falls through to the cookie rather than short-circuiting: the
    // request is unauthenticated either way, and public procedures should still work.
  }

  const session = await opts.getWebSession?.();
  const sessionUserId = session?.user?.id;
  if (typeof sessionUserId === 'string') {
    const user = await db.user.findUnique({ where: { id: sessionUserId } });
    if (user) return { ...base, user, authMethod: 'session' };
  }

  return { ...base, user: null, authMethod: null };
}
