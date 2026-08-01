import { authUrl } from '@/config';
import { clearRefreshToken, readRefreshToken, writeRefreshToken } from './storage';

/**
 * The token lifecycle. A plain module, not a hook: the tRPC link needs an access token while
 * building headers, outside React's render, where a stale closure would send an expired token.
 *
 * **Single-flight refresh is correctness, not optimisation.** The server rotates refresh tokens
 * and treats a replaced one coming back as theft, revoking every session. Without the shared
 * promise below, a batched screen load would present the same token three times.
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
    // Offline, or the dev server is down. Emphatically *not* a reason to discard the refresh
    // token: losing signal on a mountain must not sign anybody out.
    return null;
  }

  if (!response.ok) {
    // Only a 401 is the server saying this credential is dead. Any other status is a bad day,
    // and keeping the token lets a retry succeed once it recovers.
    if (response.status === 401) await signOutLocally();
    return null;
  }

  const pair = (await response.json()) as TokenPair;
  remember(pair);
  await writeRefreshToken(pair.refreshToken);
  return pair.accessToken;
}

/** A valid access token, refreshing if needed, or null when not signed in. Single-flight. */
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
 * Sign out this device. The server call is best-effort and its result ignored — the app must
 * be signed out even with the network down. A lost phone is what "sign out everywhere" is for.
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
