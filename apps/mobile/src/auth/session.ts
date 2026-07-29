import { authUrl } from '@/config';
import { clearRefreshToken, readRefreshToken, writeRefreshToken } from './storage';

/**
 * The token lifecycle.
 *
 * Deliberately a plain module rather than a hook: the tRPC link needs an access token
 * while building request headers, which happens outside React's render, and a stale
 * closure over a `useState` value there would send an expired token forever.
 *
 * The one hard rule in this file is **single-flight refresh**, and it is a correctness
 * requirement rather than an optimisation. The server rotates refresh tokens and treats a
 * *replaced* token coming back as theft, revoking every session the user has. A batched
 * screen load that fires three queries at once would, without the shared promise below,
 * present the same refresh token three times and sign the user out of all their devices
 * as their reward for opening the app.
 */

export interface TokenPair {
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: string;
}

/** Refresh this far before the access token actually expires, so a slow request still lands. */
const REFRESH_SKEW_MS = 60_000;

let accessToken: string | null = null;
let accessExpiresAt = 0;
let inFlight: Promise<string | null> | null = null;

type Listener = (signedIn: boolean) => void;
const listeners = new Set<Listener>();

function announce(signedIn: boolean): void {
  for (const listener of listeners) listener(signedIn);
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function remember(pair: TokenPair): void {
  accessToken = pair.accessToken;
  accessExpiresAt = Date.now() + pair.expiresIn * 1000;
}

function forget(): void {
  accessToken = null;
  accessExpiresAt = 0;
}

/** Adopt a freshly minted pair — called by the sign-in flow after a successful exchange. */
export async function adopt(pair: TokenPair): Promise<void> {
  remember(pair);
  await writeRefreshToken(pair.refreshToken);
  announce(true);
}

async function rotate(): Promise<string | null> {
  const refreshToken = await readRefreshToken();
  if (!refreshToken) return null;

  let response: Response;
  try {
    response = await fetch(authUrl('refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    /**
     * Offline, or the dev server is not running. Emphatically *not* a reason to discard the
     * refresh token — the whole point of an app that works on a mountain is that losing
     * signal does not sign you out. The caller gets null, the request fails as
     * unauthenticated, and the next attempt tries again with the token still in place.
     */
    return null;
  }

  if (!response.ok) {
    /**
     * 401 means the token is unknown, expired, revoked, or reused — the server refuses to
     * say which, and the app's response is the same for all four: this credential is dead,
     * so drop it and show the sign-in screen. Any other status is the server having a bad
     * day, and keeping the token lets a retry succeed once it recovers.
     */
    if (response.status === 401) await signOutLocally();
    return null;
  }

  const pair = (await response.json()) as TokenPair;
  remember(pair);
  await writeRefreshToken(pair.refreshToken);
  return pair.accessToken;
}

/**
 * A valid access token, refreshing if needed, or null when not signed in.
 *
 * Concurrent callers share one rotation — see the single-flight note at the top.
 */
export async function getAccessToken(): Promise<string | null> {
  if (accessToken && Date.now() < accessExpiresAt - REFRESH_SKEW_MS) return accessToken;

  inFlight ??= rotate().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Forget the credentials on this device without telling the server. */
async function signOutLocally(): Promise<void> {
  forget();
  await clearRefreshToken();
  announce(false);
}

/**
 * Sign out this device.
 *
 * The server call is best-effort and its result is ignored: if the network is down, the
 * user still expects the app to be signed out when it comes back to the foreground. The
 * token dies of old age within 60 days regardless, and a user worried about a lost phone
 * has "sign out everywhere", which is a server-side operation that does not depend on the
 * lost phone cooperating.
 */
export async function signOut(): Promise<void> {
  const refreshToken = await readRefreshToken();
  if (refreshToken) {
    await fetch(authUrl('revoke'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    }).catch(() => undefined);
  }
  await signOutLocally();
}

/** Whether a credential exists at all — the launch check, before any request is made. */
export async function hasStoredSession(): Promise<boolean> {
  return (await readRefreshToken()) !== null;
}
