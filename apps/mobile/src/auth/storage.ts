import * as SecureStore from 'expo-secure-store';

/**
 * The refresh token, in the Keychain.
 *
 * `SecureStore` is a thin wrapper over iOS Keychain Services, which is the only place on
 * the device where a long-lived credential belongs — `AsyncStorage` is an unencrypted
 * SQLite file readable from a backup. The access token is deliberately *not* here: it
 * lives 15 minutes, is held in memory only, and writing it to the Keychain every quarter
 * hour would be a lot of disk churn to protect something that expires on its own.
 *
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` rather than the default: the token must not travel in
 * an encrypted backup to a new phone, because a refresh token restored onto a second
 * device is exactly the two-live-copies situation the server's reuse detection exists to
 * catch — it would sign the user out everywhere on their first launch.
 */
const REFRESH_TOKEN_KEY = 'switchback.refreshToken';

const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export async function readRefreshToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(REFRESH_TOKEN_KEY, OPTIONS);
  } catch {
    /**
     * Keychain reads fail for reasons that are not our bug — the item was written under a
     * different accessibility class by an older build, or the device is in a state where
     * the class is unavailable. Treating it as "not signed in" costs the user one sign-in;
     * throwing would strand them on a screen they cannot leave.
     */
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
 * The half of a sign-in handshake that must never leave the device.
 *
 * Kept in the Keychain rather than in component state because the browser sheet is a
 * different process: iOS may reclaim this app while somebody is typing a password, and
 * coming back to a deep link holding a code we can no longer redeem would be a sign-in that
 * fails for no visible reason. Same accessibility class as the refresh token — a verifier
 * restored onto another phone is a verifier on a phone that never started the sign-in.
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
