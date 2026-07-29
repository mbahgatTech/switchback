/**
 * Browser-assisted sign-in for the iOS app.
 *
 * The direct approach — `expo-auth-session` opening Entra straight from the app — needs a
 * redirect URI registered with the provider, and Expo Go hands out `exp://192.168.x.x:8081`,
 * which changes with the Wi-Fi lease and which no identity provider will accept. So the app
 * borrows the website's sign-in instead:
 *
 * ```
 *  app                          our server                        provider
 *   │  verifier = random                                              │
 *   │  challenge = sha256(verifier)                                   │
 *   ├─ GET /start?redirect=&challenge= ─►  row created, 302 ──►       │
 *   │                                      /signin?callbackUrl=…      │
 *   │                                            └─ normal OIDC ─────►│
 *   │                                      session cookie ◄───────────┘
 *   │                                      GET /complete?request=
 *   │  ◄── 302 exp://…/--/signin?code=&state= ─┘
 *   ├─ POST /claim {request, code, verifier} ─►  code + verifier checked
 *   │  ◄── token pair ────────────────────────┘
 * ```
 *
 * The provider only ever sees our own already-registered `https://` redirect URI. The custom
 * scheme is a leg between us and the app, which is entirely ours to define — and it keeps
 * working unchanged after the Apple enrolment, when `switchback://` becomes available and the
 * `exp://` case can simply be dropped.
 *
 * Three properties hold this together, and each one is doing real work:
 *
 * - **The code is worthless alone.** It is delivered over a custom-scheme URL, and on iOS any
 *   app may claim a scheme it does not own. So the code is only half the credential: the
 *   claim must also present the verifier, which never left the device that started the flow.
 *   This is PKCE, applied to our own leg rather than the provider's.
 * - **Everything is single-use.** `codeHash` is unique and `claimedAt` is set inside the same
 *   transaction that reads it, so a replay finds the row already spent.
 * - **The redirect is allow-listed before it is stored**, not when it is used. An endpoint
 *   that will bounce a browser to an arbitrary URL after a successful sign-in is a phishing
 *   primitive on our own domain even when the code riding along with it is unredeemable.
 */
import type { PrismaClient } from '@switchback/db';
import { type TokenPair, hashToken, issueTokenPair, randomToken } from './tokens';

/**
 * How long the whole round trip has.
 *
 * Long enough for a password, an MFA prompt, and a consent screen on a phone in bad light;
 * short enough that an abandoned attempt is not a redeemable credential sitting in a table an
 * hour later. The code leg inside it takes seconds — the app claims on the deep link.
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
  | 'not_authorized';

export class MobileAuthError extends Error {
  readonly code: MobileAuthFailure;

  constructor(code: MobileAuthFailure, message?: string) {
    super(message ?? code);
    this.name = 'MobileAuthError';
    this.code = code;
  }
}

/**
 * Whether the server is willing to bounce a browser to this URL.
 *
 * `switchback:` is ours and always fine. The two development forms are not: `exp:` is Expo
 * Go, whose host is a LAN address that changes, and `http://localhost` is Expo on the web —
 * both are only reachable from a machine on the same network as the one running Metro, and
 * both are refused outright in production, where the app has its own scheme and no reason to
 * ask for either.
 *
 * Pure, and separated from the route for exactly that reason: this is the function whose
 * being wrong is worst, so it is the one that gets tested directly.
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
 * Whether development redirect schemes are on.
 *
 * Read from the environment at call time rather than captured at import, so a test can set it
 * per case. `NODE_ENV` is what Next sets; a deployment that wants the LAN forms on a preview
 * build can say so explicitly.
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
 * Open a sign-in request. Returns the id the browser carries through OIDC.
 *
 * Nothing here is a credential yet — the row is an intent, and stays useless until a real
 * session comes back through {@link authorizeAuthRequest}.
 */
export async function startAuthRequest(
  db: PrismaClient,
  input: { redirectUri: string; challenge: string; deviceName?: string | null },
): Promise<string> {
  if (!isAllowedRedirect(input.redirectUri, developmentSchemesAllowed())) {
    throw new MobileAuthError('invalid_redirect');
  }
  // 43 characters is the base64url length of a 256-bit digest, and the shortest thing worth
  // accepting: a short challenge is a guessable one, which would undo the whole point of it.
  if (input.challenge.length < 43 || !/^[A-Za-z0-9_-]+$/u.test(input.challenge)) {
    throw new MobileAuthError('invalid_request', 'challenge must be base64url, 43+ chars');
  }

  const request = await db.mobileAuthRequest.create({
    data: {
      challenge: input.challenge,
      redirectUri: input.redirectUri,
      deviceName: input.deviceName ?? null,
      expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
    },
    select: { id: true },
  });
  return request.id;
}

/**
 * The browser finished OIDC. Mint the one-time code and say where to send it.
 *
 * The code is returned rather than stored in the clear for the same reason refresh tokens
 * are: a dump of this table should not be a set of live credentials, even ones that expire in
 * minutes.
 */
export async function authorizeAuthRequest(
  db: PrismaClient,
  requestId: string,
  userId: string,
): Promise<string> {
  const request = await db.mobileAuthRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new MobileAuthError('unknown_request');
  if (request.claimedAt || request.codeHash) throw new MobileAuthError('already_claimed');
  if (request.expiresAt.getTime() <= Date.now()) throw new MobileAuthError('expired');

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
 * Trade the one-time code plus the verifier for a token pair.
 *
 * Both halves are checked before anything is issued, and the row is spent in the same
 * transaction that reads it — two claims racing on one code produce one pair and one error,
 * not two pairs.
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
    // attacker cannot invert. The equality checks below are ordinary string compares.
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
 * Drop requests that expired more than an hour ago.
 *
 * Unlike refresh tokens there is no reuse detection to preserve here — a spent or lapsed row
 * carries no information once it can no longer be claimed. The hour of slack only exists so a
 * support question about a sign-in that failed two minutes ago still has a row to look at.
 */
export async function pruneExpiredAuthRequests(db: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000);
  const { count } = await db.mobileAuthRequest.deleteMany({ where: { expiresAt: { lt: cutoff } } });
  return count;
}
