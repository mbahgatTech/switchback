/**
 * Browser-assisted sign-in for the iOS app: the app borrows the website's sign-in because Expo
 * Go hands out an `exp://192.168.x.x:8081` redirect no identity provider will accept. The
 * sequence and the four properties holding it together are in `docs/architecture.md`.
 *
 * The properties, so nothing here is removed by accident: the code is worthless without the
 * verifier that never left the device (PKCE applied to our own leg, because on iOS any app may
 * claim a URL scheme); everything is single-use inside one transaction; the redirect is
 * allow-listed when stored, not when used; and the row is bound to the authorising *browser* as
 * well as the claiming device, so a cross-site GET to `/complete` — on which `SameSite=Lax`
 * sends the session cookie by design — cannot mint a token pair on somebody else's account.
 */
import type { PrismaClient } from '@switchback/db';
import { type TokenPair, hashToken, issueTokenPair, randomToken } from './tokens';

/**
 * How long the whole round trip has. Long enough for a password, an MFA prompt and a consent
 * screen; short enough that an abandoned attempt is not a redeemable credential an hour later.
 */
export const AUTH_REQUEST_TTL_MS = 15 * 60 * 1000;

/** The app's own URL scheme, from `app.config.ts`. Always allowed. */
const NATIVE_SCHEME = 'switchback:';

export type MobileAuthFailure =
  | 'invalid_redirect'
  | 'invalid_request'
  | 'unknown_request'
  | 'expired'
  | 'already_claimed'
  | 'not_authorized'
  /** The browser finishing the sign-in is not the browser that started it. */
  | 'wrong_browser';

export class MobileAuthError extends Error {
  readonly code: MobileAuthFailure;

  constructor(code: MobileAuthFailure, message?: string) {
    super(message ?? code);
    this.name = 'MobileAuthError';
    this.code = code;
  }
}

/**
 * Whether the server is willing to bounce a browser to this URL. `switchback:` is ours and
 * always fine; the two development forms (`exp:` for Expo Go, `http://localhost` for Expo on
 * the web) are refused outright in production. Pure, and separated from the route because this
 * is the function whose being wrong is worst, so it is the one tested directly.
 */
export function isAllowedRedirect(uri: string, allowDevelopmentSchemes: boolean): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }

  if (url.protocol === NATIVE_SCHEME) return true;
  if (!allowDevelopmentSchemes) return false;
  if (url.protocol === 'exp:') return true;
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
}

/**
 * Whether development redirect schemes are on. Read from the environment at call time rather
 * than captured at import, so a test can set it per case.
 */
export function developmentSchemesAllowed(): boolean {
  if (process.env.AUTH_MOBILE_ALLOW_DEV_SCHEMES === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

/** base64url SHA-256, matching what `expo-crypto` produces on the app side. */
export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * What `/start` records. `browserSecret` is returned rather than stored so the route can put it
 * in a cookie; only its digest is written down, as with the one-time code.
 */
export interface StartedAuthRequest {
  id: string;
  browserSecret: string;
}

/**
 * Open a sign-in request. Returns the id the browser carries through OIDC, and the secret that
 * identifies the browser it was opened in. Nothing here is a credential yet: the row stays
 * useless until a real session comes back through {@link authorizeAuthRequest} *from the same
 * browser*.
 */
export async function startAuthRequest(
  db: PrismaClient,
  input: { redirectUri: string; challenge: string; deviceName?: string | null },
): Promise<StartedAuthRequest> {
  if (!isAllowedRedirect(input.redirectUri, developmentSchemesAllowed())) {
    throw new MobileAuthError('invalid_redirect');
  }
  // 43 characters is the base64url length of a 256-bit digest, and the shortest thing worth
  // accepting: a short challenge is a guessable one.
  if (input.challenge.length < 43 || !/^[A-Za-z0-9_-]+$/u.test(input.challenge)) {
    throw new MobileAuthError('invalid_request', 'challenge must be base64url, 43+ chars');
  }

  const browserSecret = randomToken();
  const request = await db.mobileAuthRequest.create({
    data: {
      challenge: input.challenge,
      redirectUri: input.redirectUri,
      deviceName: input.deviceName ?? null,
      browserHash: await hashToken(browserSecret),
      expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
    },
    select: { id: true },
  });
  return { id: request.id, browserSecret };
}

/**
 * The browser finished OIDC. Mint the one-time code and say where to send it. The code is
 * returned rather than stored in the clear, for the reason refresh tokens are.
 *
 * `browserSecret` is the value `/start` put in this browser's cookie and it is **required**: a
 * row whose `browserHash` is null, written by a build predating the column, is treated as a
 * mismatch rather than as unchecked. Those rows live at most fifteen minutes; the alternative
 * is a permanent hole.
 */
export async function authorizeAuthRequest(
  db: PrismaClient,
  requestId: string,
  userId: string,
  browserSecret: string,
): Promise<string> {
  const request = await db.mobileAuthRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new MobileAuthError('unknown_request');
  if (request.claimedAt || request.codeHash) throw new MobileAuthError('already_claimed');
  if (request.expiresAt.getTime() <= Date.now()) throw new MobileAuthError('expired');
  if (!request.browserHash || request.browserHash !== (await hashToken(browserSecret))) {
    throw new MobileAuthError('wrong_browser');
  }

  const code = randomToken();
  await db.mobileAuthRequest.update({
    where: { id: request.id },
    data: { userId, codeHash: await hashToken(code) },
  });

  const target = new URL(request.redirectUri);
  target.searchParams.set('code', code);
  // Echoed so the app can check the deep link answers the request *it* started, rather than
  // one an attacker started and hoped would land in the right foreground app.
  target.searchParams.set('state', request.id);
  return target.toString();
}

/**
 * Trade the one-time code plus the verifier for a token pair. Both halves are checked before
 * anything is issued, and the row is spent in the same transaction that reads it — two claims
 * racing on one code produce one pair and one error, not two pairs.
 */
export async function claimAuthRequest(
  db: PrismaClient,
  input: { requestId: string; code: string; verifier: string; deviceName?: string | null },
): Promise<TokenPair> {
  const [codeHash, challenge] = await Promise.all([
    hashToken(input.code),
    challengeFor(input.verifier),
  ]);

  const userId = await db.$transaction(async (tx) => {
    const request = await tx.mobileAuthRequest.findUnique({ where: { id: input.requestId } });
    if (!request) throw new MobileAuthError('unknown_request');
    if (request.claimedAt) throw new MobileAuthError('already_claimed');
    if (request.expiresAt.getTime() <= Date.now()) throw new MobileAuthError('expired');
    if (!request.userId || !request.codeHash) throw new MobileAuthError('not_authorized');
    // Constant-time comparison is not the concern it would be for a MAC: both sides are
    // SHA-256 digests of high-entropy inputs, so a timing oracle leaks a prefix of a hash the
    // attacker cannot invert.
    if (request.codeHash !== codeHash) throw new MobileAuthError('invalid_request');
    if (request.challenge !== challenge) throw new MobileAuthError('invalid_request');

    await tx.mobileAuthRequest.update({
      where: { id: request.id },
      data: { claimedAt: new Date() },
    });
    return request.userId;
  });

  return issueTokenPair(db, userId, input.deviceName ?? null);
}

/**
 * Drop requests that expired more than an hour ago. Unlike refresh tokens there is no reuse
 * detection to preserve; the hour of slack exists so a support question about a sign-in that
 * failed two minutes ago still has a row to look at.
 */
export async function pruneExpiredAuthRequests(db: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const { count } = await db.mobileAuthRequest.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return count;
}
