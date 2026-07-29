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
 * Auth.js configuration.
 *
 * **Database sessions, not JWT.** The default with the Prisma adapter, and the right
 * default here: a session row can be deleted, so "sign out everywhere" and "this account
 * was compromised" are one query. A JWT session cannot be revoked before it expires. The
 * cost is a database read per request, which we were making anyway to load the user for
 * `ctx.user`.
 *
 * **The config is a function.** Apple's client secret is a JWT that has to be signed on
 * each use (see `auth/apple-secret.ts`), and signing is async. Auth.js v5 accepts an async
 * factory precisely for this, which is why the providers are assembled per request rather
 * than at module load.
 */
async function buildProviders(): Promise<Provider[]> {
  const providers: Provider[] = [];

  /**
   * Absent only before the Azure app registration exists — `env.ts` makes these mandatory
   * in production. Skipping the provider rather than registering it with an undefined
   * client id matters: Auth.js would accept that and fail at the redirect with an error
   * from Microsoft rather than from us.
   */
  if (env.AUTH_MICROSOFT_ENTRA_ID_ID && env.AUTH_MICROSOFT_ENTRA_ID_SECRET) {
    providers.push(
      MicrosoftEntraID({
        clientId: env.AUTH_MICROSOFT_ENTRA_ID_ID,
        clientSecret: env.AUTH_MICROSOFT_ENTRA_ID_SECRET,
        issuer: env.AUTH_MICROSOFT_ENTRA_ID_ISSUER,
        /**
         * Entra returns the avatar from Graph, which needs a token. Without this the
         * provider stores a URL that 401s for anyone who loads it.
         */
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
    // Behind Vercel's proxy the Host header is what identifies the deployment; without
    // this Auth.js refuses to construct callback URLs on preview deployments.
    trustHost: true,
    pages: {
      signIn: '/signin',
      error: '/signin',
    },
    callbacks: {
      /**
       * The default session shape has no user id, and every tRPC request needs one.
       * Under the database strategy the `user` argument is the actual row, so this is
       * a copy rather than a lookup.
       */
      session({ session, user }) {
        session.user.id = user.id;
        return session;
      },
    },
    events: {
      /**
       * The three system lists are created here rather than lazily on first use — see
       * `ensureSystemLists` for why. The native sign-in path calls the same helper, so an
       * account created on the phone comes out identical to one created in a browser.
       */
      async createUser({ user }) {
        if (!user.id) return;
        await ensureSystemLists(prisma, user.id);
      },
    },
  };

  return config;
});
