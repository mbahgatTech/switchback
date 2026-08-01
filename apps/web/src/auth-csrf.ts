/**
 * The Auth.js CSRF token, read or minted. Its one caller is `/api/auth/mobile/complete`, whose
 * interstitial is a plain HTML form rather than a server action.
 *
 * The cookie is `<token>|<hash>`, hash being hex SHA-256 of token + `AUTH_SECRET` — this is
 * `createCSRFToken` in `@auth/core`, reimplemented because that module is not public. If Auth.js
 * changes either, the symptom is a confirmation refused every time. Minting is needed because
 * Auth.js writes the cookie with no `Max-Age`: a reader who quit their browser has a 30-day
 * database session and no CSRF token.
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

/** The token this browser should send. A cookie whose hash does not verify is treated as absent. */
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
 * Whether a posted token matches this browser's cookie. The cookie's own hash is checked first,
 * so a cookie we did not write is not accepted merely because it was echoed into the form.
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
