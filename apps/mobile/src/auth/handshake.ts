import Constants from 'expo-constants';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { authUrl } from '@/config';
import { type TokenPair, adopt } from './session';
import { clearPendingHandshake, readPendingHandshake, writePendingHandshake } from './storage';

/**
 * Signing in, by way of a browser.
 *
 * The app never talks to Entra. It opens *our* sign-in page in a system browser sheet, the
 * server completes OIDC against its own registered `https://` redirect URI, and the browser
 * comes back to a deep link carrying a one-time code. The full reasoning — and why the direct
 * `expo-auth-session` route is unavailable in Expo Go — is in
 * `packages/api/src/mobile-auth.ts` and `docs/mobile.md`.
 *
 * The one thing this file must get right is that the code arriving over `switchback://` or
 * `exp://` is not on its own a credential. Any app on the device can register a URL scheme it
 * does not own, so a code intercepted there has to be worthless. It is: the server also
 * demands the **verifier**, 256 bits generated here, stored in the Keychain, and sent only
 * over TLS to the API. The browser leg carries its SHA-256 and never the value.
 *
 * There are two ways back in, and both end in the same claim:
 *
 * - **The sheet returns.** `openAuthSessionAsync` watches for the return URL, dismisses
 *   itself, and hands us the URL directly. The screen never unmounts.
 * - **The app was killed while the sheet was open.** iOS delivers the deep link as a cold
 *   start, expo-router routes it to `/signin`, and the screen finds `code` in its params.
 *   That is the only reason the verifier is in the Keychain rather than in a local.
 */

export type SignInOutcome =
  { kind: 'signedIn' } | { kind: 'cancelled' } | { kind: 'failed'; reason: string };

/** Where the browser is sent back to. A real route, so a cold-start delivery lands somewhere. */
const RETURN_PATH = '/signin';

/**
 * What the server may say went wrong, in words for somebody holding a phone.
 *
 * Anything not listed gets the generic line. These are the codes `mobile-auth.ts` can put on
 * the deep link; `invalid_grant` is the one the claim endpoint returns, and it deliberately
 * covers four different server-side causes with one message, because the answer to all four
 * is the same.
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
 * The name this device shows up as under "signed-in devices".
 *
 * Cosmetic, and treated as such by the server, which trims it and never trusts it. `null`
 * rather than a fabricated "iPhone" when the OS will not say: an honest blank is more use in
 * that list than a label every device shares.
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
 * Built by hand rather than with `URL`.
 *
 * React Native's `URL` is a partial polyfill and `searchParams` on it has been incomplete for
 * long enough that relying on it here — where a mangled `redirect` parameter means the browser
 * never comes home — is not worth the tidier code.
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
 * Open the browser, wait for it, and sign in if it came back with a code.
 *
 * `dismiss` and `cancel` are both the user closing the sheet, which is a decision rather than
 * a fault — hence a distinct outcome, so the screen can go quiet instead of showing an error
 * for something the user did on purpose.
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
 * Finish a handshake whose deep link arrived without the sheet — the cold-start path.
 *
 * Returns `cancelled` when there is no stored verifier, which is what a stale link tapped
 * days later looks like. Not an error: nothing went wrong, there is simply nothing to finish.
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
     * The code is still good and the verifier is still in the Keychain, so this is left
     * pending on purpose — hiking out of signal mid-sign-in should be retryable, and the
     * server's own window is what eventually closes it.
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
