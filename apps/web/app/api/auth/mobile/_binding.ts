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
 * `Sec-Fetch-Site` is set by the browser and cannot be forged from script. `none` is a typed
 * address or a bookmark, `same-origin` is our own form; anything else — `cross-site`,
 * `same-site` from a sibling subdomain — is refused. A request with no header at all is
 * allowed through, because that is what every non-browser client looks like and the two legs
 * this guards are also protected by the binding cookie and the CSRF token.
 */
export function fromOurOwnOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
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
