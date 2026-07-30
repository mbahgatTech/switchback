/**
 * Reading — and, when it is missing, minting — the Auth.js CSRF token.
 *
 * Auth.js protects its own POST endpoints with a double-submit token and already owns the
 * cookie for it. Anything else on this origin that needs a state-changing POST outside React's
 * server actions should present the same token rather than invent a second scheme: one token,
 * one cookie, one thing to get right. Today that is exactly one caller —
 * `/api/auth/mobile/complete`, whose interstitial is a plain HTML form because it is served
 * from a route handler.
 *
 * The cookie is `<token>|<hash>`, where the hash is the hex SHA-256 of the token concatenated
 * with `AUTH_SECRET`. That hash is what makes the cookie *ours*: a network attacker who can
 * write cookies for this origin cannot compute one, so a forged cookie fails to verify and is
 * replaced rather than trusted. The format and the algorithm are `createCSRFToken` in
 * `@auth/core`, reimplemented here rather than imported because that module is not part of the
 * package's public surface. If Auth.js ever changes either, the symptom is a confirmation that
 * is refused every time — visible on the first mobile sign-in after the upgrade, and the
 * reason this file names its source precisely.
 *
 * **Why mint at all.** Auth.js writes this cookie without a `Max-Age`, so it is a session
 * cookie and dies when the browser is closed — while the database session cookie lives for
 * thirty days. A reader who signed in yesterday, quit their browser, and came back has a
 * session and no CSRF token, and refusing them would be a dead end caused by our own
 * bookkeeping. Minting one is what Auth.js itself does on any GET to its endpoints.
 */
import { env } from '@/env';

const BASE_NAME = 'authjs.csrf-token';

export interface CsrfToken {
  /** The value to put in the form. */
  token: string;
  /** Present only when the cookie had to be created; send it as `Set-Cookie` if so. */
  setCookie?: string;
}

/** Hex SHA-256, matching `createHash` in `@auth/core/lib/utils/web`. */
async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function cookieName(secure: boolean): string {
  // Auth.js uses the stricter `__Host-` prefix for this one, not `__Secure-`.
  return secure ? `__Host-${BASE_NAME}` : BASE_NAME;
}

function readCookie(header: string, name: string): string {
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return '';
}

/**
 * The token this browser should send, creating the cookie if it has none.
 *
 * A cookie whose hash does not verify is treated as absent — that is the case the hash exists
 * to catch, and the answer to it is a fresh token, not an error page.
 */
export async function csrfTokenFor(request: Request, secure: boolean): Promise<CsrfToken> {
  const raw = readCookie(request.headers.get('cookie') ?? '', cookieName(secure));
  const [token, hash] = raw.split('|');

  if (token && hash && hash === (await sha256Hex(`${token}${env.AUTH_SECRET}`))) {
    return { token };
  }

  const fresh = randomToken();
  const value = `${fresh}|${await sha256Hex(`${fresh}${env.AUTH_SECRET}`)}`;
  const attributes = [
    `${cookieName(secure)}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ];
  return { token: fresh, setCookie: attributes.join('; ') };
}

/**
 * Whether a posted token is the one this browser's cookie carries.
 *
 * Both halves are checked: the cookie's own hash first, so a cookie we did not write is not
 * accepted merely because the attacker echoed it back into the form, and then the equality
 * that makes it a double submit.
 */
export async function csrfTokenValid(
  request: Request,
  secure: boolean,
  posted: string,
): Promise<boolean> {
  if (!posted) return false;
  const raw = readCookie(request.headers.get('cookie') ?? '', cookieName(secure));
  const [token, hash] = raw.split('|');
  if (!token || !hash) return false;
  if (hash !== (await sha256Hex(`${token}${env.AUTH_SECRET}`))) return false;
  return token === posted;
}

/** 32 bytes, hex — the shape `randomString(32)` produces in `@auth/core`. */
function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
