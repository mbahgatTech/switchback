import {
  MobileAuthError,
  developmentSchemesAllowed,
  isAllowedRedirect,
  startAuthRequest,
} from '@switchback/api/mobile-auth';
import { prisma } from '@switchback/db';
import { bindingCookie, fromOurOwnOrigin } from '../_binding';
import { notice } from '../_notice';

/**
 * The first leg of the browser-assisted sign-in (`packages/api/src/mobile-auth.ts`): records the
 * app's deep link and PKCE challenge, then hands the browser to the ordinary website sign-in. It
 * also sets the cookie marking *this* browser as the one allowed to finish. See `../_binding.ts`.
 */
export const runtime = 'nodejs';

/** Shown when something other than the app or our own pages opened this. */
const CROSS_SITE = {
  heading: 'That sign-in did not come from this site',
  body: 'Another page sent your browser here, so nothing was started. Close this and start again from the app.',
};

export async function GET(request: Request): Promise<Response> {
  /*
   * **The guard that makes `/complete`'s three checks independent rather than jointly
   * satisfiable.** Without it an attacker page does one `location =` here with a challenge they
   * chose: the binding cookie lands in the victim's browser and matches, the session is real, and
   * the POST is honestly same-origin with an honest CSRF token — leaving only the consent button.
   * It can only close it here, because this is the first hop; `/complete` is a redirect target and
   * reads `cross-site` honestly. A header-less request is still admitted — see `fromOurOwnOrigin`.
   */
  if (!fromOurOwnOrigin(request)) return notice(403, CROSS_SITE.heading, CROSS_SITE.body);

  const params = new URL(request.url).searchParams;
  const redirectUri = params.get('redirect') ?? '';
  const challenge = params.get('challenge') ?? '';
  const deviceName = params.get('device')?.slice(0, 80) ?? null;

  /*
   * Checked here as well as inside `startAuthRequest`: a redirect we will not honour is the one
   * failure we cannot tell the app about, since telling it means using the URL we just refused.
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
   * Built by hand rather than with `Response.redirect`, which returns a frozen response whose
   * headers cannot be appended to — and the binding cookie has to ride this hop.
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
