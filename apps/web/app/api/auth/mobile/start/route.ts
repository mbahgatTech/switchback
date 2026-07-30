import {
  MobileAuthError,
  developmentSchemesAllowed,
  isAllowedRedirect,
  startAuthRequest,
} from '@switchback/api/mobile-auth';
import { prisma } from '@switchback/db';
import { bindingCookie } from '../_binding';
import { notice } from '../_notice';

/**
 * GET /api/auth/mobile/start
 *
 * The first leg of the browser-assisted sign-in described in `packages/api/src/mobile-auth.ts`.
 * The app opens this in a system browser with the deep link it wants to come back to and the
 * PKCE challenge it kept the preimage of; this records both and hands the browser to the
 * ordinary website sign-in.
 *
 * A GET rather than a POST because the thing calling it is a browser being opened at a URL,
 * not a fetch. It creates a row, which is the usual argument against — but the row is an
 * intent with no authority attached, and the endpoint is unauthenticated by necessity, so
 * there is nothing here for a forged request to accomplish beyond the cleanup job's problem.
 *
 * It also sets the cookie that marks *this* browser as the one allowed to finish the request.
 * That is what stops an attacker starting their own request — so that they hold the verifier —
 * and then walking a victim's browser through `/complete`. See `../_binding.ts`.
 */
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const redirectUri = params.get('redirect') ?? '';
  const challenge = params.get('challenge') ?? '';
  const deviceName = params.get('device')?.slice(0, 80) ?? null;

  /*
   * Checked here as well as inside `startAuthRequest`, because the two failures deserve
   * different answers: a redirect we will not honour is the one case where we cannot tell the
   * app anything, since telling it means using the very URL we just refused.
   */
  if (!isAllowedRedirect(redirectUri, developmentSchemesAllowed())) {
    return notice(
      400,
      'That sign-in link is not one we answer',
      'The app asked to be sent back to an address this server will not redirect to. Update the app and try again.',
    );
  }

  let started: { id: string; browserSecret: string };
  try {
    started = await startAuthRequest(prisma, { redirectUri, challenge, deviceName });
  } catch (error) {
    if (error instanceof MobileAuthError) {
      return notice(
        400,
        'That sign-in request was malformed',
        'The app sent an incomplete request. Close this and try signing in again.',
      );
    }
    throw error;
  }

  /*
   * Straight to the website's own sign-in page, with the second leg as its callback. If a
   * session already exists in this browser, that page redirects immediately and the whole
   * round trip is invisible — which is the right behaviour: somebody signed in on the phone's
   * browser is the same person, and asking them to prove it twice would be theatre.
   *
   * Built by hand rather than with `Response.redirect`, which returns a frozen response whose
   * headers cannot be appended to — and the cookie has to ride this hop.
   */
  const callbackUrl = `/api/auth/mobile/complete?request=${encodeURIComponent(started.id)}`;
  const target = new URL(`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`, request.url);

  return new Response(null, {
    status: 302,
    headers: {
      location: target.toString(),
      'set-cookie': bindingCookie(request, started.browserSecret),
    },
  });
}
