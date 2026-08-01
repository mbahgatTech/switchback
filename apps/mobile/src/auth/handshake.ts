import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { authUrl } from '@/config';
import { type TokenPair, adopt } from './session';
import { clearPendingHandshake, readPendingHandshake, writePendingHandshake } from './storage';

/**
 * Signing in, by way of a browser. The app never talks to Entra: it opens *our* sign-in page in
 * a system browser sheet, the server completes OIDC against its own registered `https://`
 * redirect URI, and the browser deep-links back with a one-time code. See `docs/mobile.md` and
 * `packages/api/src/mobile-auth.ts`.
 *
 * The code arriving over `switchback://` is not on its own a credential — any app can register
 * a URL scheme it does not own. The server also demands the **verifier**, 256 bits generated
 * here, kept in the Keychain and sent only over TLS; the browser leg carries only its SHA-256.
 *
 * The verifier is in the Keychain rather than a local because iOS may deliver the deep link as
 * a cold start, with the app killed while the sheet was open.
 */

export type SignInOutcome =
  { kind: 'signedIn' } | { kind: 'cancelled' } | { kind: 'failed'; reason: string };

/** Where the browser is sent back to. A real route, so a cold-start delivery lands somewhere. */
const RETURN_PATH = '/signin';

/**
 * The codes `mobile-auth.ts` can put on the deep link, in words for somebody holding a phone.
 * `invalid_grant` deliberately covers four server-side causes: the answer to all four is one.
 */
const REASONS: Record<string, string> = {
  expired: 'That took longer than fifteen minutes, so the sign-in lapsed. Try again.',
  already_claimed: 'That sign-in had already been used. Try again.',
  unknown_request: 'The server no longer has a record of that sign-in. Try again.',
  not_authorized: 'The browser did not finish signing in. Try again.',
  invalid_grant: 'The server would not accept that sign-in. Try again.',
  invalid_request: 'The sign-in request was malformed. Try again.',
};

function reasonFor(code: string): string {
  return REASONS[code] ?? 'Sign-in did not complete. Try again.';
}

/**
 * The name this device shows up as under "signed-in devices". Cosmetic, and never trusted by
 * the server. `null` rather than a fabricated "iPhone" when the OS will not say.
 */
function deviceName(): string | null {
  return typeof Constants.deviceName === 'string' && Constants.deviceName.length > 0
    ? Constants.deviceName
    : null;
}

/** 256 bits, hex. Hex rather than base64url so no `btoa` polyfill has to be right for this. */
async function newVerifier(): Promise<string> {
  const bytes = await Crypto.getRandomBytesAsync(32);
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** base64url SHA-256 — the same transform `challengeFor` applies on the server. */
async function challengeFor(verifier: string): Promise<string> {
  const base64 = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, verifier, {
    encoding: Crypto.CryptoEncoding.BASE64,
  });
  return base64.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

/**
 * Built by hand rather than with `URL`: React Native's is a partial polyfill whose
 * `searchParams` has long been incomplete, and a mangled `redirect` means the browser never
 * comes home.
 */
function startUrl(challenge: string, returnUrl: string): string {
  const name = deviceName();
  return (
    `${authUrl('start')}?redirect=${encodeURIComponent(returnUrl)}` +
    `&challenge=${encodeURIComponent(challenge)}` +
    (name ? `&device=${encodeURIComponent(name)}` : '')
  );
}

function firstParam(value: string | string[] | undefined | null): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Open the browser, wait for it, and sign in if it came back with a code. `dismiss` and
 * `cancel` are the user closing the sheet — a decision, not a fault, so they get their own
 * outcome and the screen stays quiet.
 */
export async function signInWithBrowser(): Promise<SignInOutcome> {
  const verifier = await newVerifier();
  const challenge = await challengeFor(verifier);
  const returnUrl = Linking.createURL(RETURN_PATH);

  await writePendingHandshake({ verifier, startedAt: Date.now() });

  let result: WebBrowser.WebBrowserAuthSessionResult;
  try {
    result = await WebBrowser.openAuthSessionAsync(startUrl(challenge, returnUrl), returnUrl);
  } catch (error) {
    await clearPendingHandshake();
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : 'Could not open a browser.',
    };
  }

  if (result.type !== 'success') {
    await clearPendingHandshake();
    return { kind: 'cancelled' };
  }

  const { queryParams } = Linking.parse(result.url);
  const error = firstParam(queryParams?.error);
  if (error) {
    await clearPendingHandshake();
    return { kind: 'failed', reason: reasonFor(error) };
  }

  const code = firstParam(queryParams?.code);
  const state = firstParam(queryParams?.state);
  if (!code || !state) {
    await clearPendingHandshake();
    return { kind: 'failed', reason: 'The browser came back without a sign-in code. Try again.' };
  }

  return claim(state, code, verifier);
}

/**
 * Finish a handshake whose deep link arrived without the sheet — the cold-start path. Returns
 * `cancelled` when there is no stored verifier, which is what a stale link tapped days later
 * looks like: nothing went wrong, there is simply nothing to finish.
 */
export async function resumeSignIn(state: string, code: string): Promise<SignInOutcome> {
  const pending = await readPendingHandshake();
  if (!pending) return { kind: 'cancelled' };

  return claim(state, code, pending.verifier);
}

async function claim(requestId: string, code: string, verifier: string): Promise<SignInOutcome> {
  let response: Response;
  try {
    response = await fetch(authUrl('claim'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, code, verifier, deviceName: deviceName() ?? undefined }),
    });
  } catch {
    /*
     * Left pending on purpose: the code is still good and the verifier is still in the
     * Keychain, so hiking out of signal mid-sign-in stays retryable until the server's own
     * window closes it.
     */
    return {
      kind: 'failed',
      reason: 'Could not reach the server. Check your connection and try again.',
    };
  }

  if (!response.ok) {
    await clearPendingHandshake();
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    return { kind: 'failed', reason: reasonFor(body?.error ?? 'invalid_grant') };
  }

  const pair = (await response.json()) as TokenPair;
  await clearPendingHandshake();
  await adopt(pair);
  return { kind: 'signedIn' };
}
