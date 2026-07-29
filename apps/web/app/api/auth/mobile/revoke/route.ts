import { z } from 'zod';
import { revokeRefreshToken } from '@switchback/api/tokens';
import { prisma } from '@switchback/db';

/**
 * POST /api/auth/mobile/revoke
 *
 * Sign out on this device. Deliberately unauthenticated beyond the token itself: sign-out
 * has to work when the access token has already expired, which is exactly the state an app
 * is in after sitting closed overnight.
 */
export const runtime = 'nodejs';

const bodySchema = z.object({ refreshToken: z.string().min(1) });

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  // Always 204, even for a token that was never ours. Revocation is idempotent by nature,
  // and a distinguishable response would turn this into an oracle for whether a token
  // exists.
  await revokeRefreshToken(prisma, parsed.data.refreshToken);
  return new Response(null, { status: 204 });
}
