import {
  MobileAuthError,
  authorizeAuthRequest,
  developmentSchemesAllowed,
  isAllowedRedirect,
} from '@switchback/api/mobile-auth';
import { prisma } from '@switchback/db';
import { auth } from '@/auth';
import { csrfTokenFor, csrfTokenValid } from '@/auth-csrf';
import {
  clearBindingCookie,
  fromOurOwnOrigin,
  isSecureRequest,
  readBindingSecret,
} from '../_binding';
import { confirmation, notice } from '../_notice';

/**
 * /api/auth/mobile/complete
 *
 * The second leg. The browser has finished OIDC and carries a real session cookie, so this
 * mints the one-time code and bounces back into the app over its deep link.
 *
 * The app is what closes the browser: `WebBrowser.openAuthSessionAsync` watches for a
 * navigation to the return URL and dismisses the sheet itself. So there is nothing to render
 * on the success path — the redirect *is* the response.
 *
 * **It takes two requests now, and that is the fix.** The GET renders a question; the POST
 * answers it. Minting the code on the GET meant any page anywhere could navigate a signed-in
 * browser here and walk away with a fifteen-minute access token and a sixty-day refresh token,
 * because `SameSite=Lax` sends the session cookie on a top-level cross-site GET — that is
 * precisely what Lax is for. Three things now stand in the way, and each covers a case the
 * others do not:
 *
 * - **The binding cookie.** The row is tied to the browser that ran `/start`, so an attacker
 *   holding their own verifier cannot have a victim's browser authorise it.
 * - **The POST, with the Auth.js CSRF token.** A cross-site form POST does not carry a
 *   `SameSite=Lax` cookie at all, and a same-site page on a sibling subdomain cannot read the
 *   token out of an `HttpOnly` cookie to put in the form.
 * - **`Sec-Fetch-Site`, on the POST only.** Set by the browser, unforgeable from script, and
 *   refused on the POST unless it says the request came from us or from nowhere. It is *not*
 *   checked on the GET, and that is a correction rather than an omission — see the note above
 *   `GET` below, and `fromOurOwnOrigin` in `../_binding.ts`.
 *
 * And a person has to press a button that names the device, which is the only one of the four
 * that still helps if the reader is being played some way the other three do not cover.
 *
 * **Sign-ins already in flight when this deploys will fail**, with `wrong_browser`: their rows
 * were written before there was a binding to write. They are engineered around rather than
 * migrated because the window is fifteen minutes wide and the recovery is one button in the
 * app — the copy below says exactly that.
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
  /*
   * The one new failure a legitimate reader can hit, so it is the one that has to say what to
   * do rather than what went wrong. It happens when a sign-in finishes in a different browser
   * from the one that started it — a link pasted from the app's in-app browser into Safari,
   * or Chrome opened where the app opened Safari — and it is also what every request written
   * before this code deployed will now get.
   */
  wrong_browser: {
    heading: 'That sign-in started in a different browser',
    body: 'A sign-in has to finish in the browser the app opened. Close this, open the app, and press sign in again — the new attempt will finish here.',
  },
};

const GENERIC: { heading: string; body: string } = {
  heading: 'That sign-in could not be completed',
  body: 'Close this and start again from the app.',
};

/**
 * Shown when the POST arrives from somewhere that is not our own interstitial.
 *
 * Only the POST. The GET is a redirect target and its `Sec-Fetch-Site` describes a chain that
 * legitimately runs through Microsoft; the POST is sent by a form on a page this route
 * rendered, one hop, so `same-origin` there is a fact rather than a hope.
 */
const CROSS_SITE: { heading: string; body: string } = {
  heading: 'That sign-in did not come from this site',
  body: 'Another page sent your browser here, so nothing was signed in. Close this and start again from the app.',
};

/**
 * The question. Reads, names the device, and mints nothing.
 *
 * **No `Sec-Fetch-Site` check here, on purpose.** There was one, and it broke every
 * first-time sign-in on a new device. `Sec-Fetch-Site` is not a property of the page that
 * started a navigation; the browser recomputes it at each hop of a redirect chain against
 * every URL in that chain, and once any of them is cross-site it stays `cross-site` for the
 * rest of the chain. That is exactly the shape of the ordinary return leg —
 * `/signin` → `login.microsoftonline.com` → `/api/auth/callback/microsoft-entra-id` → 302 →
 * here — so the guard refused the one request it most had to admit, after the reader had
 * already given Microsoft their password and their second factor. They landed on a page
 * accusing their own browser of not being this site, and `openAuthSessionAsync` never saw the
 * return URL, so the sheet did not even close.
 *
 * The already-signed-in fast path hid it: `/start` opened by the browser arrives as `none`,
 * `none` survives redirects where `same-origin` does not, and the whole chain stays `none`.
 * That is the path a manual check exercises, and it is the only one that ever passed.
 *
 * Nothing is lost by dropping it, because this leg has nothing to steal. It mints no code,
 * sets no credential and moves no state; it renders a form. Every guard that matters is on
 * the POST, where `same-origin` is genuinely the truth because our own interstitial is what
 * sends it: the binding cookie, the Lax-blocked cross-site form POST, and the double-submit
 * CSRF token. The row is still read here so that a request that cannot succeed fails before
 * the reader presses anything rather than after.
 */
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

  /*
   * Read for two reasons: to fail before the reader presses anything rather than after, and
   * to name the device in the question, which is what makes the question answerable. Nothing
   * is minted here — a GET stays a read.
   */
  const stored = await prisma.mobileAuthRequest.findUnique({
    where: { id: requestId },
    select: { deviceName: true, browserHash: true, claimedAt: true, codeHash: true },
  });
  if (!stored) return await fail(request, requestId, new MobileAuthError('unknown_request'));
  if (stored.claimedAt || stored.codeHash) {
    return await fail(request, requestId, new MobileAuthError('already_claimed'));
  }
  if (!stored.browserHash || !readBindingSecret(request)) {
    return await fail(request, requestId, new MobileAuthError('wrong_browser'));
  }

  const csrf = await csrfTokenFor(request, isSecureRequest(request));
  return confirmation({
    requestId,
    csrfToken: csrf.token,
    deviceName: stored.deviceName,
    setCookies: csrf.setCookie ? [csrf.setCookie] : [],
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!fromOurOwnOrigin(request)) return notice(403, CROSS_SITE.heading, CROSS_SITE.body);

  const form = await request.formData().catch(() => null);
  const requestId = field(form, 'request');
  const posted = field(form, 'csrfToken');
  if (!requestId) return notice(400, GENERIC.heading, GENERIC.body);

  if (!(await csrfTokenValid(request, isSecureRequest(request), posted))) {
    /*
     * Either a forgery or a form that sat open long enough for the browser to be restarted,
     * which drops the Auth.js CSRF cookie. The two are indistinguishable from here and the
     * answer to both is the same, so the copy describes the recoverable one rather than
     * accusing the reader of the other.
     */
    return notice(
      403,
      'That confirmation was no longer valid',
      'The page had been open too long, or it did not come from this site. Close this and start again from the app.',
    );
  }

  const session = await auth();
  if (!session?.user?.id) {
    return notice(
      401,
      'This browser is not signed in',
      'The sign-in has to finish in a browser with a session. Close this and start again from the app.',
    );
  }

  try {
    const target = await authorizeAuthRequest(
      prisma,
      requestId,
      session.user.id,
      readBindingSecret(request),
    );
    /*
     * 303, not 302: this is the answer to a POST, and on a 302 it is left to the browser
     * whether the redirected request keeps the method. A custom-scheme URL has no POST.
     *
     * The binding cookie is spent along with the row, so it is cleared on the same response.
     */
    return new Response(null, {
      status: 303,
      headers: { location: target, 'set-cookie': clearBindingCookie(request) },
    });
  } catch (error) {
    if (!(error instanceof MobileAuthError)) throw error;
    return await fail(request, requestId, error);
  }
}

/**
 * One text field out of a posted form.
 *
 * `FormData.get` returns a `File` as readily as a string — a multipart body naming a field
 * after ours is all it takes — so the type is narrowed rather than stringified. Anything that
 * is not text reads as absent, which is the same thing as far as this endpoint is concerned.
 */
function field(form: FormData | null, name: string): string {
  const value = form?.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Hand the failure to the app when we still can.
 *
 * The app has a screen, a back button and the context to say what happens next; this browser
 * sheet has none of those. The redirect is re-checked against the allow-list rather than
 * trusted from the row, so a stored value that predates a tightening of the rules cannot be
 * used to bounce anywhere.
 *
 * `wrong_browser` is the exception and is answered on this page instead. Bouncing it down the
 * deep link would deliver the error to whichever copy of the app is in the foreground, which
 * by definition is not the one that started this request — and the person who can act on the
 * sentence is the one reading this browser.
 */
async function fail(
  request: Request,
  requestId: string,
  error: MobileAuthError,
): Promise<Response> {
  if (error.code !== 'wrong_browser') {
    const stored = await prisma.mobileAuthRequest.findUnique({
      where: { id: requestId },
      select: { redirectUri: true },
    });
    if (stored && isAllowedRedirect(stored.redirectUri, developmentSchemesAllowed())) {
      const target = new URL(stored.redirectUri);
      target.searchParams.set('error', error.code);
      target.searchParams.set('state', requestId);
      return new Response(null, {
        status: 303,
        headers: { location: target.toString(), 'set-cookie': clearBindingCookie(request) },
      });
    }
  }

  const fault = FAULTS[error.code] ?? GENERIC;
  const response = notice(400, fault.heading, fault.body);
  response.headers.append('set-cookie', clearBindingCookie(request));
  return response;
}
