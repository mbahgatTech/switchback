import { z } from 'zod';
import { RefreshTokenError, rotateRefreshToken } from '@switchback/api/tokens';
import { prisma } from '@switchback/db';

/**
 * POST /api/auth/mobile/refresh
 *
 * The app calls this when its 15-minute access token is close to expiring. Rotation and
 * reuse detection live in `@switchback/api/tokens`; this is the transport around them.
 */
export const runtime = 'nodejs';

const bodySchema = z.object({
  refreshToken: z.string().min(1),
  deviceName: z.string().trim().max(80).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  try {
    const tokens = await rotateRefreshToken(
      prisma,
      parsed.data.refreshToken,
      parsed.data.deviceName,
    );
    return Response.json(tokens);
  } catch (error) {
    if (error instanceof RefreshTokenError) {
      if (error.reuseDetected) {
        // Worth a loud log: this is either a stolen token or a client bug that retries a
        // consumed one, and the two look identical from here.
        console.error('refresh token reuse detected; all sessions revoked');
      }
      /**
       * One status and one body for every failure — unknown, expired, revoked, reused.
       * Distinguishing them would tell a caller holding a guessed token whether it ever
       * existed, and the app's response is the same in all four cases: sign in again.
       */
      return Response.json({ error: 'invalid_grant' }, { status: 401 });
    }
    throw error;
  }
}
