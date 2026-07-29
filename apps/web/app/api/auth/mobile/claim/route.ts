import { z } from 'zod';
import { MobileAuthError, claimAuthRequest } from '@switchback/api/mobile-auth';
import { prisma } from '@switchback/db';

/**
 * POST /api/auth/mobile/claim
 *
 * The third leg. The app came back from the browser holding a one-time code and trades it —
 * together with the verifier it never sent anywhere — for a token pair.
 *
 * This is the only leg that is a fetch rather than a browser navigation, and the only one
 * that produces a credential. The verifier is what makes it safe to have delivered the code
 * over a custom-scheme URL that any app on the device could have intercepted.
 */
export const runtime = 'nodejs';

const bodySchema = z.object({
  requestId: z.string().min(1).max(64),
  code: z.string().min(1).max(128),
  verifier: z.string().min(43).max(128),
  /** Shown in the "signed-in devices" list. Cosmetic, and therefore never trusted. */
  deviceName: z.string().trim().max(80).optional(),
});

export async function POST(request: Request): Promise<Response> {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  try {
    const tokens = await claimAuthRequest(prisma, parsed.data);
    return Response.json(tokens);
  } catch (error) {
    if (error instanceof MobileAuthError) {
      /**
       * One status and one body for every failure, on the same reasoning as `refresh`:
       * telling a caller whether a guessed code ever existed, or whether it was the code or
       * the verifier that did not match, is free information for an attacker and none at all
       * for the app, whose response is "start again" in every case.
       */
      return Response.json({ error: 'invalid_grant' }, { status: 401 });
    }
    throw error;
  }
}
