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

/**
 * Shown when something other than the app or our own pages opened this.
 *
 * The reader is on a page they did not ask for, in a browser sheet with no navigation, so the
 * sentence has to end somewhere they can act: the app.
 */
const CROSS_SITE = {
  heading: 'That sign-in did not come from this site',
  body: 'Another page sent your browser here, so nothing was started. Close this and start again from the app.',
};

export async function GET(request: Request): Promise<Response> {
  /*
   * **The binding is only a binding if the attacker cannot choose which browser gets it.**
   *
   * The three guards on `/complete` were reasoned about as independent, and they are not,
   * because all three can be satisfied at once by running the whole chain inside the victim's
   * browser — which an attacker page can do from here, with one `location =`. The row is
   * created with a `challenge` they chose, so they hold the verifier; the 302's `Set-Cookie`
   * is accepted because a `SameSite=Lax` cookie set on a top-level navigation response is;
   * `safeCallback` preserves the query, so a signed-in visitor is carried straight through
   * `/signin` into `GET /complete`; and by then the binding cookie *matches*, the session is
   * real, and the POST is genuinely same-origin with a genuine CSRF token. Everything after
   * this point passes. The only thing left standing between the victim and a sixty-day token
   * on their account is whether they read the confirmation button before pressing it.
   *
   * `Sec-Fetch-Site` closes it here and cannot close it anywhere later. This is the first hop
   * — the browser is opened at this URL, or follows a link from one of our pages — so the
   * header describes the thing that actually started the navigation. The redirect-chain
   * degradation documented on `fromOurOwnOrigin` and on `GET /complete` is a property of being
   * a redirect *target*, which this is not: `/complete` reads `cross-site` because the honest
   * chain runs through Microsoft, and nothing legitimate reaches `/start` through anybody.
   *
   * Measured: the app opening the system browser arrives as `none`, a link from our own pages
   * as `same-origin`, an attacker's `location =` as `cross-site`. `fromOurOwnOrigin` admits
   * the first two and refuses the third.
   *
   * It also admits a request with no `Sec-Fetch-Site` at all, and on this leg that is a
   * concession rather than a covered case: there is no binding cookie yet and no CSRF token,
   * so nothing else here catches it. Two legitimate things arrive header-less — a browser on
   * a plain-HTTP origin, which is every development build, and a browser older than Safari
   * 16.4, which is every supported iOS below 16.4 — and refusing them would 403 the first hop
   * of sign-in with no way back. The reasoning and the measurements are on `fromOurOwnOrigin`.
   */
  if (!fromOurOwnOrigin(request)) return notice(403, CROSS_SITE.heading, CROSS_SITE.body);

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
