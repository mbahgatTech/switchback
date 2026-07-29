import {
  MobileAuthError,
  authorizeAuthRequest,
  developmentSchemesAllowed,
  isAllowedRedirect,
} from '@switchback/api/mobile-auth';
import { prisma } from '@switchback/db';
import { auth } from '@/auth';
import { notice } from '../_notice';

/**
 * GET /api/auth/mobile/complete
 *
 * The second leg. The browser has finished OIDC and carries a real session cookie, so this
 * mints the one-time code and bounces back into the app over its deep link.
 *
 * The app is what closes the browser: `WebBrowser.openAuthSessionAsync` watches for a
 * navigation to the return URL and dismisses the sheet itself. So there is nothing to render
 * on the success path — the redirect *is* the response.
 */
export const runtime = 'nodejs';

/**
 * What each failure means to the person holding the phone.
 *
 * Deliberately not the raw code: `not_authorized` and `already_claimed` are precise about
 * server state and useless as instructions. Every message here ends in the same place —
 * start again in the app — because that genuinely is the only thing to do from a browser
 * sheet with no navigation in it.
 */
const FAULTS: Record<string, { heading: string; body: string }> = {
  unknown_request: {
    heading: 'That sign-in has already finished',
    body: 'This link belongs to a sign-in attempt the server no longer has a record of. Close this and start again from the app.',
  },
  expired: {
    heading: 'That sign-in took too long',
    body: 'A sign-in attempt is good for fifteen minutes. Close this and start again from the app.',
  },
  already_claimed: {
    heading: 'That sign-in has already been used',
    body: 'Each attempt can only be completed once. If the app is not signed in, close this and start again from it.',
  },
};

const GENERIC: { heading: string; body: string } = {
  heading: 'That sign-in could not be completed',
  body: 'Close this and start again from the app.',
};

export async function GET(request: Request): Promise<Response> {
  const requestId = new URL(request.url).searchParams.get('request') ?? '';
  if (!requestId) return notice(400, GENERIC.heading, GENERIC.body);

  const session = await auth();
  if (!session?.user?.id) {
    /*
     * Reached when the cookie was dropped between the two legs, or when someone opened this
     * URL directly. Sending them through the sign-in page rather than refusing means the
     * ordinary case — a browser that quietly lost its session — still completes.
     */
    const callbackUrl = `/api/auth/mobile/complete?request=${encodeURIComponent(requestId)}`;
    return Response.redirect(
      new URL(`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`, request.url),
      302,
    );
  }

  try {
    const target = await authorizeAuthRequest(prisma, requestId, session.user.id);
    return Response.redirect(target, 302);
  } catch (error) {
    if (!(error instanceof MobileAuthError)) throw error;

    /*
     * Hand the failure to the app when we still can. The app has a screen, a back button and
     * the context to say what happens next; this browser sheet has none of those. The
     * redirect is re-checked against the allow-list rather than trusted from the row, so a
     * stored value that predates a tightening of the rules cannot be used to bounce anywhere.
     */
    const stored = await prisma.mobileAuthRequest.findUnique({
      where: { id: requestId },
      select: { redirectUri: true },
    });
    if (stored && isAllowedRedirect(stored.redirectUri, developmentSchemesAllowed())) {
      const target = new URL(stored.redirectUri);
      target.searchParams.set('error', error.code);
      target.searchParams.set('state', requestId);
      return Response.redirect(target.toString(), 302);
    }

    const fault = FAULTS[error.code] ?? GENERIC;
    return notice(400, fault.heading, fault.body);
  }
}
