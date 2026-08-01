/**
 * The cookie tying one mobile sign-in request to one browser. Written by hand rather than through
 * `cookies()`: these are set on a `Response.redirect`, where Next's cookie store does not reach.
 */
import { AUTH_REQUEST_TTL_MS } from '@switchback/api/mobile-auth';

const BASE_NAME = 'switchback.mobile-auth';

export function isSecureRequest(request: Request): boolean {
  // Behind Vercel's proxy the socket is plain HTTP, so either the forwarded header or the URL's
  // own protocol saying https is enough.
  if (request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https') return true;
  return new URL(request.url).protocol === 'https:';
}

/**
 * `__Host-` only over a secure connection. A browser drops a `__Host-` cookie that is not
 * `Secure`, and Expo development serves `http://192.168.x.x:3000` — hard-coding the prefix makes
 * every development sign-in fail with `wrong_browser`. Auth.js switches names on the same test.
 */
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
    // Lax, not Strict: the cookie has to survive the return leg from Entra, which arrives as a
    // cross-site top-level navigation. Safe because it is a second factor beside the session
    // cookie, and the POST interstitial in `/complete` is what stops a cross-site request.
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
 * Whether the browser says this request came from our own pages. `none` is a typed address or an
 * app opening the browser; `same-origin` is our own form; anything else is refused.
 *
 * **Only valid on a first hop.** The browser recomputes `Sec-Fetch-Site` at every hop of a
 * redirect chain and it degrades permanently — one cross-site URL anywhere and every later hop
 * reads `cross-site`. So this must never guard a redirect target: `GET /complete` is where
 * Entra's callback lands, and checking it there refused every first-time sign-in. Both real
 * callers are first hops (`POST /complete`, `GET /start`), and `/start` is what makes the guards
 * on `/complete` independent rather than jointly satisfiable.
 */
export function fromOurOwnOrigin(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site');
  // A missing header is admitted knowingly: iOS 15.1–16.3 sends none over HTTPS (Fetch Metadata
  // landed in Safari 16.4), and an origin that is not potentially trustworthy — every plain-HTTP
  // development build — gets no `Sec-Fetch-*` at all. Do not drop this case: it 403s the first
  // hop of sign-in on supported devices and on every development build.
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
