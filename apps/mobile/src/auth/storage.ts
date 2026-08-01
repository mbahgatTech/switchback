import * as SecureStore from 'expo-secure-store';

/**
 * The refresh token, in the iOS Keychain via `SecureStore` — `AsyncStorage` is an unencrypted
 * SQLite file readable from a backup. The access token is deliberately not here: 15 minutes,
 * in memory only.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` rather than the default, so the token cannot ride an
 * encrypted backup onto a second device — two live copies is exactly what the server's reuse
 * detection revokes every session over.
 */
const REFRESH_TOKEN_KEY = 'switchback.refreshToken';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function readRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
  } catch {
    // Keychain reads fail for reasons that are not our bug — an older build's accessibility
    // class, or a device state where it is unavailable. "Not signed in" costs one sign-in;
    // throwing would strand the reader on a screen they cannot leave.
    return null;
  }
}

export async function writeRefreshToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, token, OPTIONS);
}

export async function clearRefreshToken(): Promise<void> {
  await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
}

/**
 * The half of a sign-in handshake that must never leave the device. In the Keychain rather than
 * component state because iOS may reclaim the app while the browser sheet is open. Same
 * accessibility class as the refresh token.
 */
const PENDING_HANDSHAKE_KEY = 'switchback.pendingSignIn';

export interface PendingHandshake {
  verifier: string;
  /** Epoch ms. The server's own window is fifteen minutes; this is how we notice it lapsed. */
  startedAt: number;
}

export async function readPendingHandshake(): Promise<PendingHandshake | null> {
  let raw: string | null;
  try {
    raw = await SecureStore.getItemAsync(PENDING_HANDSHAKE_KEY, OPTIONS);
  } catch {
    return null;
  }
  if (!raw) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { verifier, startedAt } = parsed as Partial<PendingHandshake>;
    if (typeof verifier !== 'string' || typeof startedAt !== 'number') return null;
    return { verifier, startedAt };
  } catch {
    return null;
  }
}

export async function writePendingHandshake(pending: PendingHandshake): Promise<void> {
  await SecureStore.setItemAsync(PENDING_HANDSHAKE_KEY, JSON.stringify(pending), OPTIONS);
}

export async function clearPendingHandshake(): Promise<void> {
  await SecureStore.deleteItemAsync(PENDING_HANDSHAKE_KEY, OPTIONS);
}
