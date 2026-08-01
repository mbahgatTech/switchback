import NextAuth, { type NextAuthConfig } from 'next-auth';
import type { Provider } from 'next-auth/providers';
import MicrosoftEntraID from 'next-auth/providers/microsoft-entra-id';
import Apple from 'next-auth/providers/apple';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@switchback/db';
import { ensureSystemLists } from '@switchback/api';
import { env } from '@/env';
import { appleClientSecret } from '@/auth-apple';

/**
 * Auth.js configuration. **Database sessions, not JWT** — a session row can be deleted, so "sign
 * out everywhere" is one query; the cookie is an opaque pointer at that row, never a bearer claim.
 * The config is an async factory because Apple's client secret is a JWT signed on each use.
 */
async function buildProviders(): Promise<Provider[]> {
  const providers: Provider[] = [];

  /**
   * Skipped rather than registered with an undefined client id — Auth.js accepts that and fails
   * at the redirect with an error from Microsoft rather than from us.
   */
  if (env.AUTH_MICROSOFT_ENTRA_ID_ID && env.AUTH_MICROSOFT_ENTRA_ID_SECRET) {
    providers.push(
      MicrosoftEntraID({
        clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
        clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
        issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
        /** Entra's avatar comes from Graph; without `User.Read` the stored URL 401s. */
        authorization: { params: { scope: 'openid profile email User.Read' } },
      }),
    );
  }

  if (env.AUTH_APPLE_ENABLED) {
    providers.push(
      Apple({
        clientId: env.AUTH_APPLE_ID!,
        clientSecret: await appleClientSecret(),
      }),
    );
  }

  return providers;
}

export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const config: NextAuthConfig = {
    adapter: PrismaAdapter(prisma),
    providers: await buildProviders(),
    session: { strategy: 'database', maxAge: 30 * 24 * 60 * 60 },
    // Behind Vercel's proxy the Host header identifies the deployment; without this Auth.js
    // refuses to construct callback URLs on preview deployments.
    trustHost: true,
    pages: {
      signIn: '/signin',
      error: '/signin',
    },
    callbacks: {
      /** The default session shape has no user id, and every tRPC request needs one. */
      session({ session, user }) {
        session.user.id = user.id;
        return session;
      },
    },
    events: {
      /**
       * Eagerly, not lazily on first use — see `ensureSystemLists`. The native sign-in path calls
       * the same helper, so a phone-created account matches a browser-created one.
       */
      async createUser({ user }) {
        if (!user.id) return;
        await ensureSystemLists(prisma, user.id);
      },
    },
  };

  return config;
});
