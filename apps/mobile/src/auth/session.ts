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

/**
 * Set the moment a sign-out is decided, and cleared only by a new sign-in.
 *
 * Clearing the Keychain can fail, and the reset this device now performs on every announcement
 * refetches immediately — so without this the first thing after "Sign out" is `rotate()` finding
 * the token that survived, minting a fresh pair and silently signing the reader back in while
 * the interface says they are out. The decision is not the delete; the delete is how the
 * decision is *persisted*.
 */
let signedOut = false;

/** Told on every transition, in both directions. Exported so a subscriber need not retype it. */
export type Listener = (signedIn: boolean) => void;
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

/**
 * Adopt a freshly minted pair — called by the sign-in flow after a successful exchange.
 *
 * `finally`, because by this point `remember` has already installed the new reader's access
 * token: every request from here is made as them, so the announcement is not optional — it is
 * what empties the previous reader's cached answers. A Keychain that refuses the write costs
 * this session its survival across a restart, and must not also cost the identity change.
 */
export async function adopt(pair: TokenPair): Promise<void> {
  remember(pair);
  signedOut = false;
  try {
    await writeRefreshToken(pair.refreshToken);
  } finally {
    announce(true);
  }
}

async function rotate(): Promise<string | null> {
  // A token that outlived a failed sign-out is still on disk. It is not a licence to come back.
  if (signedOut) return null;

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

/**
 * Give up the stored credential, and make sure it cannot be honoured if the delete fails.
 *
 * An empty string is the fallback rather than a second delete: it neutralises the credential
 * even across a relaunch, where the in-memory `signedOut` guard no longer exists. That rests on
 * every reader treating a falsy value as "not signed in" — `rotate` does, and `hasStoredSession`
 * does since it stopped asking `!== null`; `session.test.ts` holds both.
 */
async function discardStoredToken(): Promise<void> {
  try {
    await clearRefreshToken();
  } catch (error) {
    await writeRefreshToken('').catch(() => undefined);
    throw error;
  }
}

/** Forget the credentials on this device without telling the server. `finally` as in `adopt`. */
async function signOutLocally(): Promise<void> {
  forget();
  signedOut = true;
  try {
    await discardStoredToken();
  } finally {
    announce(false);
  }
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

/**
 * Whether a credential exists at all — the launch check, before any request is made.
 *
 * Falsiness, not `!== null`: a failed delete leaves `''` behind, and this is the reader that
 * turns a stored value into `signedIn` — and so into every gated query on the screen firing.
 */
export async function hasStoredSession(): Promise<boolean> {
  return Boolean(await readRefreshToken());
}
