/**
 * Request context, built once per request. `getWebSession` is injected rather than imported so
 * this package stays a leaf: Auth.js is configured in `apps/web/auth.ts`, and importing it
 * would drag a Next.js module graph behind the Expo app, which imports the router *type* here.
 * Both auth methods — the website's session cookie and the app's bearer token — are resolved
 * here, so no procedure has to care which client it is talking to.
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
   * Keeps work alive after the response has been sent — Next's `after` on the web route,
   * nothing in a test or script, where the work falls to the cron. Injected for the same
   * reason `getWebSession` is.
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

/**
 * The signed-in user is the whole row, not just an id: nearly every protected procedure needs
 * `isPlus` or `units`, so one query per request beats one per procedure.
 */
export interface Context {
  db: PrismaClient;
  user: User | null;
  headers: Headers;
  /** How the caller authenticated. Useful for logging and for rate limits later. */
  authMethod: 'session' | 'bearer' | null;
  /**
   * Runs work after the response is sent, when the platform supports it. Absent means "no
   * background work here" — every caller must still be correct without it, which is why the
   * ingest queue is durable rather than relying on this.
   */
  waitUntil?: (work: Promise<unknown>) => void;
}

export async function createContext(opts: CreateContextOptions): Promise<Context> {
  const db = opts.db ?? prisma;
  const base = { db, headers: opts.headers, waitUntil: opts.waitUntil };

  const bearer = opts.headers.get('authorization');
  if (bearer?.toLowerCase().startsWith('bearer ')) {
    const claims = await verifyAccessToken(bearer.slice(7).trim());
    if (claims) {
      const user = await db.user.findUnique({ where: { id: claims.userId } });
      /*
       * A token whose user was deleted verifies fine but must not authenticate anyone, and
       * neither must one minted before the account was signed out everywhere — nothing stores
       * the access JWT, so revoking refresh tokens and session rows leaves it alive for its
       * full fifteen minutes, which is what `signOutEverywhere` promises to end.
       *
       * `iat` is whole seconds, so the comparison is `<=` rather than `<`: a token minted in
       * the same second as the press would otherwise survive it.
       */
      if (user) {
        const revokedAt = user.sessionsRevokedAt;
        const staleToken = revokedAt !== null && claims.issuedAt * 1000 <= revokedAt.getTime();
        if (!staleToken) return { ...base, user, authMethod: 'bearer' };
      }
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
