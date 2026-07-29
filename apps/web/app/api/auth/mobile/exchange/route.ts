import { z } from 'zod';
import { ensureSystemLists } from '@switchback/api';
import { issueTokenPair } from '@switchback/api/tokens';
import { prisma } from '@switchback/db';
import { IdentityTokenError, verifyIdentityToken } from '@/auth-native';

/**
 * POST /api/auth/mobile/exchange
 *
 * Trade a provider identity token for a Switchback token pair. This is the native
 * equivalent of the callback the browser goes through, and the only endpoint the app hits
 * while signed out.
 */
export const runtime = 'nodejs';

const bodySchema = z.object({
  provider: z.enum(['microsoft-entra-id', 'apple']),
  idToken: z.string().min(1),
  /** Echoed back from the token when the client generated one. */
  nonce: z.string().optional(),
  /** Shown in the "signed-in devices" list. Cosmetic, and therefore never trusted. */
  deviceName: z.string().trim().max(80).optional(),
  /**
   * Apple returns the user's name exactly once, in the *authorization response* rather
   * than the identity token, and never again. If the app does not forward it here on that
   * first call, the account has no name forever.
   */
  fullName: z.string().trim().max(80).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  const { provider, idToken, nonce, deviceName, fullName } = parsed.data;

  let identity;
  try {
    identity = await verifyIdentityToken(provider, idToken, nonce);
  } catch (error) {
    if (error instanceof IdentityTokenError) {
      console.warn('mobile exchange rejected:', error.message);
      return Response.json({ error: 'invalid_token' }, { status: 401 });
    }
    throw error;
  }

  const existing = await prisma.account.findUnique({
    where: {
      provider_providerAccountId: {
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
      },
    },
    select: { userId: true },
  });

  let userId: string;

  if (existing) {
    userId = existing.userId;
  } else {
    const byEmail = identity.email
      ? await prisma.user.findUnique({ where: { email: identity.email }, select: { id: true } })
      : null;

    if (byEmail && !identity.emailVerified) {
      /**
       * An account with this email exists and the provider will not vouch for the
       * address. Linking here would let anyone who can get an unverified token for
       * `you@example.com` take over that account, which is the classic account-linking
       * hole. Refusing costs a legitimate user one extra step; allowing it costs someone
       * their account.
       */
      return Response.json({ error: 'email_taken_unverified' }, { status: 409 });
    }

    if (byEmail) {
      userId = byEmail.id;
    } else {
      const created = await prisma.user.create({
        data: {
          email: identity.email,
          // Apple's name only ever arrives on the first authorization, so prefer it over
          // the token claim, which for Apple is absent.
          name: fullName ?? identity.name,
          emailVerified: identity.emailVerified ? new Date() : null,
        },
        select: { id: true },
      });
      userId = created.id;
      await ensureSystemLists(prisma, userId);
    }

    await prisma.account.create({
      data: {
        userId,
        type: 'oidc',
        provider: identity.provider,
        providerAccountId: identity.providerAccountId,
      },
    });
  }

  const tokens = await issueTokenPair(prisma, userId, deviceName);
  return Response.json(tokens);
}
