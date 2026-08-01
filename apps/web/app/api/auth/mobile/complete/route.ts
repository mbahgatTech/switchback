import {
  MobileAuthError,
  authorizeAuthRequest,
  developmentSchemesAllowed,
  isAllowedRedirect,
} from '@switchback/api/mobile-auth';
import { hashToken } from '@switchback/api/tokens';
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
 * The second leg: the browser has finished OIDC, so this mints the one-time code and bounces
 * back into the app. Two requests on purpose — the GET renders a question, the POST answers it,
 * because `SameSite=Lax` sends the session cookie on a top-level cross-site GET. See
 * `docs/architecture.md` for the four properties that hold the flow together.
 */
export const runtime = 'nodejs';

/** What each failure means to the person holding the phone; every message ends in "start again". */
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
  // The only failure a legitimate reader can hit — a sign-in finished in a different browser
  // from the one that started it — so the copy says what to do rather than what went wrong.
  wrong_browser: {
    heading: 'That sign-in started in a different browser',
    body: 'A sign-in has to finish in the browser the app opened. Close this, open the app, and press sign in again — the new attempt will finish here.',
  },
};

const GENERIC: { heading: string; body: string } = {
  heading: 'That sign-in could not be completed',
  body: 'Close this and start again from the app.',
};

/** Shown when the POST arrives from somewhere that is not our own interstitial. */
const CROSS_SITE: { heading: string; body: string } = {
  heading: 'That sign-in did not come from this site',
  body: 'Another page sent your browser here, so nothing was signed in. Close this and start again from the app.',
};

/**
 * The question. Reads, names the device, and mints nothing.
 *
 * **No `Sec-Fetch-Site` check here, on purpose.** This is a redirect target — the ordinary return
 * leg runs `/signin` → Microsoft → callback → here, so the header reads `cross-site` and a guard
 * refuses every first-time sign-in after the reader has already authenticated. Nothing is minted
 * on this leg; every guard that matters is on the POST.
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = new URL(request.url).searchParams.get('request') ?? '';
  if (!requestId) return notice(400, GENERIC.heading, GENERIC.body);

  const session = await auth();
  if (!session?.user?.id) {
    // Through the sign-in page rather than a refusal, so a browser that quietly lost its
    // session still completes.
    const callbackUrl = `/api/auth/mobile/complete?request=${encodeURIComponent(requestId)}`;
    return Response.redirect(
      new URL(`/signin?callbackUrl=${encodeURIComponent(callbackUrl)}`, request.url),
      302,
    );
  }

  /*
   * Read so a request that cannot succeed fails before the reader presses anything, and to name
   * the device in the question. The binding is compared, not merely tested for presence: the
   * same expression as `authorizeAuthRequest`, because two spellings of one rule come apart.
   */
  const stored = await prisma.mobileAuthRequest.findUnique({
    where: { id: requestId },
    select: { deviceName: true, browserHash: true, claimedAt: true, codeHash: true },
  });
  if (!stored) return await fail(request, requestId, new MobileAuthError('unknown_request'));
  if (stored.claimedAt || stored.codeHash) {
    return await fail(request, requestId, new MobileAuthError('already_claimed'));
  }
  if (!stored.browserHash || stored.browserHash !== (await hashToken(readBindingSecret(request)))) {
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
    // Either a forgery or a form left open until the browser restarted, dropping the Auth.js
    // CSRF cookie. Indistinguishable from here, so the copy describes the recoverable one.
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
    // 303, not 302: on a 302 the browser may keep the method, and a custom-scheme URL has no
    // POST. The binding cookie is spent with the row, so it is cleared on the same response.
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
 * One text field out of a posted form. `FormData.get` returns a `File` as readily as a string —
 * a multipart body naming a field after ours is all it takes — so the type is narrowed.
 */
function field(form: FormData | null, name: string): string {
  const value = form?.get(name);
  return typeof value === 'string' ? value : '';
}

/**
 * Hand the failure to the app when we still can — it has a screen and a back button, this browser
 * sheet has neither. The redirect is re-checked against the allow-list rather than trusted from
 * the row. `wrong_browser` is answered on this page instead: the app in the foreground is by
 * definition not the one that started the request.
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
