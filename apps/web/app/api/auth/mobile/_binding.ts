/**
 * The cookie that ties one mobile sign-in request to one browser.
 *
 * `/start` mints a secret, keeps its digest in `MobileAuthRequest.browserHash`, and sets the
 * value here; `/complete` will not authorise a row it cannot present the secret for. That is
 * the whole of the defence against the cross-site variant of this flow, and the reasoning for
 * why it is needed at all is in `packages/api/src/mobile-auth.ts`.
 *
 * **`__Host-` only where the connection is secure.** The prefix is worth having — it forbids a
 * `Domain` attribute and any path but `/`, so a sibling subdomain cannot write this cookie —
 * but a browser refuses a `__Host-` cookie without `Secure`, and refuses a `Secure` cookie
 * outright over plain HTTP on anything but localhost. Development is exactly the case that
 * breaks: Expo opens `http://192.168.x.x:3000`, which is not a trustworthy origin, so a
 * hard-coded `__Host-` name would silently drop the cookie and make every sign-in on a
 * development build fail with `wrong_browser`. Auth.js switches its own cookie names on the
 * same condition, for the same reason, so the two agree about what a deployment is.
 *
 * Written by hand rather than through `cookies()`: these are set on a `Response.redirect`,
 * where Next's cookie store does not reach.
 */
import { AUTH_REQUEST_TTL_MS } from '@switchback/api/mobile-auth';

const BASE_NAME = 'switchback.mobile-auth';

export function isSecureRequest(request: Request): boolean {
  // `x-forwarded-proto` is what Vercel sets; the URL's own protocol is the truth everywhere
  // else. Either saying https is enough — behind the proxy the socket is plain HTTP.
  if (request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') return true;
  return new URL(request.url).protocol === 'https:';
}

export function bindingCookieName(request: Request): string {
  return isSecureRequest(request) ? `__Host-${BASE_NAME}` : BASE_NAME;
}

/** The `Set-Cookie` value that hands the browser its half of the binding. */
export function bindingCookie(request: Request, secret: string): string {
  const secure = isSecureRequest(request);
  const name = secure ? `__Host-${BASE_NAME}` : BASE_NAME;
  return [
    `${name}=${encodeURIComponent(secret)}`,
    'Path=/',
    `Max-Age=${Math.floor(AUTH_REQUEST_TTL_MS / 1000)}`,
    'HttpOnly',
    // Lax, not Strict. The cookie has to survive the return leg from Entra, which arrives as
    // a cross-site top-level navigation — under Strict the browser would withhold it and the
    // ordinary sign-in would fail. Lax is safe here precisely because the cookie is not the
    // authority: it is a second factor beside a session cookie that is also Lax, and the POST
    // interstitial in `/complete` is what stops a cross-site request using either of them.
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** The same cookie, expired. Sent once the request it belongs to is spent or refused. */
export function clearBindingCookie(request: Request): string {
  const secure = isSecureRequest(request);
  const name = secure ? `__Host-${BASE_NAME}` : BASE_NAME;
  return [
    `${name}=`,
    'Path=/',
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/**
 * Whether this request came from our own pages rather than from somebody else's.
 *
 * `Sec-Fetch-Site` is set by the browser and cannot be forged or stripped from script. `none`
 * is a typed address, a bookmark, or an app opening the browser at a URL; `same-origin` is our
 * own form; anything else — `cross-site`, `same-site` from a sibling subdomain — is refused.
 *
 * **A request with no header at all is admitted, and that is a concession, not a proof.** The
 * older wording here justified it once for both callers — "every non-browser client, and this
 * leg has the binding cookie and the CSRF token as well" — and that sentence is only true of
 * `POST /complete`. `GET /start` is where the binding cookie is minted and carries no CSRF
 * token, so it has neither of the two things that argument leans on. Three kinds of request
 * arrive header-less, and they land differently on the two callers:
 *
 * - **A non-browser client** — curl, a health check, an uptime probe. On `POST /complete` it
 *   still has to present the binding secret and a valid CSRF token, so it gets nowhere. On
 *   `GET /start` it can create a row, which the docblock on that route already concedes is an
 *   intent with no authority attached and nobody's browser bound to it.
 * - **A browser on an origin that is not potentially trustworthy.** Fetch Metadata is only
 *   attached to secure origins, so plain HTTP on a LAN address gets no `Sec-Fetch-*` at all.
 *   That is development exactly: `apiBaseUrl()` in the app derives `http://<metro host>:3000`,
 *   the same origin the `__Host-` note above already calls untrustworthy. Measured against the
 *   dev server, a browser opened at `http://127.0.0.1:3000/api/auth/mobile/start` sends `none`
 *   and one opened at `http://10.0.0.93:3000/…` sends nothing — and a cross-site `location =`
 *   to that same LAN URL sends nothing either. On plain HTTP the guard is inert in both
 *   directions; it is load-bearing on HTTPS, which is where the account is.
 * - **A browser too old to send it.** WebKit shipped Fetch Metadata in Safari 16.4, and the
 *   minimum iOS this app supports is 15.1 (`min_ios_version_supported`, React Native 0.86).
 *   Every supported device from 15.1 to 16.3 opens the sign-in sheet without the header, over
 *   HTTPS, in production. On those devices the first hop is genuinely unguarded and the checks
 *   on `/complete` are jointly satisfiable again, with the consent button the last thing left.
 *
 * Requiring `none || same-origin` on `/start` was proposed as the alternative and is not done.
 * It reads as free only if the app-opened browser always sends the header, and it does not:
 * the third case above turns into a 403 on the first hop of sign-in for every iOS 15.1–16.3
 * device, and the second turns into the same 403 for every development build — both of them in
 * a browser sheet with no navigation in it, so there is nothing the reader can do but give up.
 * That is a certain break of working sign-ins to close a hole that still needs the victim to
 * read a device name off a button and press it. The concession stays; what was wrong was
 * claiming it cost nothing.
 *
 * **Only safe on a request the browser makes in one hop.** `Sec-Fetch-Site` is not a property
 * of the page that started a navigation. The browser recomputes it at every hop of a redirect
 * chain against the whole list of URLs in that chain, and it degrades permanently: one
 * cross-site URL anywhere in the chain and every later hop reads `cross-site`, however
 * same-origin the last two hops are. `none` is the exception — a browser-initiated navigation
 * stays `none` through any number of redirects.
 *
 * So this must not be used on a redirect target. It has two callers, and both are first hops:
 *
 * - `POST /complete`, a form submission from a page we rendered.
 * - `GET /start`, which the app opens the system browser at (`none`, or nothing at all on the
 *   two header-less paths above) or which is reached from one of our own pages
 *   (`same-origin`). Nothing legitimate arrives there via a redirect. It
 *   is the hop that makes the guards on `/complete` independent of each other rather than
 *   jointly satisfiable — without it an attacker page can create the row *and* have the
 *   victim's browser bound to it, and every later check passes. See the note there.
 *
 * `GET /complete` is the counter-example and is deliberately not guarded: it is where Entra's
 * callback sends the browser, and checking this there refused every first-time sign-in with
 * `cross-site` after the reader had already authenticated — the docblock on the cookie above
 * concedes the same fact about the return leg and the guard did not listen to it.
 */
export function fromOurOwnOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  // `null` is admitted knowingly, and what it costs differs per caller — see above. Do not
  // drop it without reading the third bullet: iOS 15.1 to 16.3 sends no header over HTTPS.
  return site === null || site === 'same-origin' || site === 'none';
}

/** Read the binding secret out of a request's `Cookie` header. Empty string when absent. */
export function readBindingSecret(request: Request): string {
  const name = bindingCookieName(request);
  const header = request.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}
