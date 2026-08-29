import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The token lifecycle, which had no test file at all until this one.
 *
 * That absence was load-bearing: `announce()` is the *only* thing that empties the query cache,
 * so anything that skips it hands the previous reader's answers to the next one. The two
 * `try/finally` blocks in this module are what make it unskippable, and a reviewer demonstrated
 * that reverting both of them left the mobile suite entirely green. A structural gate in
 * `conventions.test.ts` reads the source for them; these cases run them.
 *
 * `expo-secure-store` and the network are mocked, so this needs no Keychain, no device and no
 * server. The module keeps state at module scope — the access token, and the `signedOut` flag —
 * so every case re-imports it fresh rather than sharing one instance.
 */

const storage = vi.hoisted(() => ({
  readRefreshToken: vi.fn<() => Promise<string | null>>(),
  writeRefreshToken: vi.fn<(token: string) => Promise<void>>(),
  clearRefreshToken: vi.fn<() => Promise<void>>(),
}));

vi.mock('../src/auth/storage', () => storage);
vi.mock('@/config', () => ({ authUrl: (path: string) => `https://switchback.test/auth/${path}` }));

/** A fresh module, because `signedOut` and the access token outlive a single call. */
async function freshSession() {
  vi.resetModules();
  return import('../src/auth/session');
}

const PAIR = {
  accessToken: 'access-bob',
  expiresIn: 3600,
  refreshToken: 'refresh-bob',
  refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

beforeEach(() => {
  storage.readRefreshToken.mockResolvedValue(null);
  storage.writeRefreshToken.mockResolvedValue(undefined);
  storage.clearRefreshToken.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('adopting a freshly minted pair', () => {
  it('tells its subscribers, so the previous reader’s answers are dropped', async () => {
    const session = await freshSession();
    const heard: boolean[] = [];
    session.subscribe((signedIn) => heard.push(signedIn));

    await session.adopt(PAIR);

    expect(heard).toEqual([true]);
  });

  it('still tells them when the Keychain refuses the write', async () => {
    const session = await freshSession();
    const heard: boolean[] = [];
    session.subscribe((signedIn) => heard.push(signedIn));
    storage.writeRefreshToken.mockRejectedValue(new Error('Keychain unavailable'));

    /*
     * `remember()` has already installed this reader's access token by the time the write is
     * attempted, so every request from here is made as them. Skipping the announcement would
     * leave the previous reader's cached answers under the new reader's requests — the exact
     * leak this seam exists to close.
     */
    await expect(session.adopt(PAIR)).rejects.toThrow('Keychain unavailable');
    expect(heard, 'the failure must cost the session, not the identity change').toEqual([true]);
  });
});

describe('signing out', () => {
  it('tells its subscribers, and revokes the stored credential upstream', async () => {
    const session = await freshSession();
    const heard: boolean[] = [];
    session.subscribe((signedIn) => heard.push(signedIn));
    storage.readRefreshToken.mockResolvedValue('refresh-alice');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await session.signOut();

    expect(heard).toEqual([false]);
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('https://switchback.test/auth/revoke');
  });

  it('signs out anyway when the revoke cannot be delivered', async () => {
    const session = await freshSession();
    const heard: boolean[] = [];
    session.subscribe((signedIn) => heard.push(signedIn));
    storage.readRefreshToken.mockResolvedValue('refresh-alice');
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));

    await session.signOut();

    expect(heard, 'losing signal must not keep somebody signed in').toEqual([false]);
  });

  it('still tells them when the Keychain refuses the delete', async () => {
    const session = await freshSession();
    const heard: boolean[] = [];
    session.subscribe((signedIn) => heard.push(signedIn));
    storage.clearRefreshToken.mockRejectedValue(new Error('Keychain unavailable'));

    await expect(session.signOut()).rejects.toThrow('Keychain unavailable');
    expect(heard).toEqual([false]);
  });

  it('neutralises a credential it could not delete', async () => {
    const session = await freshSession();
    storage.clearRefreshToken.mockRejectedValue(new Error('Keychain unavailable'));

    await expect(session.signOut()).rejects.toThrow();

    /*
     * The delete failed, so the credential is still on disk and would be honoured after a
     * relaunch, where the in-memory guard no longer exists. An empty string reads back falsy,
     * which every caller already treats as "not signed in".
     */
    expect(storage.writeRefreshToken).toHaveBeenCalledWith('');
  });

  it('is not undone by the token it failed to delete', async () => {
    const session = await freshSession();
    storage.clearRefreshToken.mockRejectedValue(new Error('Keychain unavailable'));
    storage.readRefreshToken.mockResolvedValue('refresh-alice');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 204 }));

    await expect(session.signOut()).rejects.toThrow('Keychain unavailable');
    vi.mocked(fetch).mockClear();
    const token = await session.getAccessToken();

    /*
     * Without the guard this is the live defect: the reset that follows a sign-out refetches
     * immediately, `rotate()` finds the surviving token, mints a fresh pair and signs the reader
     * back in while the interface says they are out.
     */
    expect(token, 'a deliberate sign-out is not a licence to come back').toBeNull();
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
      'https://switchback.test/auth/refresh',
      expect.anything(),
    );
  });
});

describe('refreshing an access token', () => {
  it('announces a sign-out when the server says the credential is dead', async () => {
    const session = await freshSession();
    const heard: boolean[] = [];
    session.subscribe((signedIn) => heard.push(signedIn));
    storage.readRefreshToken.mockResolvedValue('refresh-alice');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 401 }));

    const token = await session.getAccessToken();

    expect(token).toBeNull();
    expect(heard, 'a 401 is the server ending the session, and screens must hear it').toEqual([
      false,
    ]);
  });

  it('keeps the credential when the server is merely having a bad day', async () => {
    const session = await freshSession();
    const heard: boolean[] = [];
    session.subscribe((signedIn) => heard.push(signedIn));
    storage.readRefreshToken.mockResolvedValue('refresh-alice');
    vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));

    expect(await session.getAccessToken()).toBeNull();
    expect(heard, 'a 503 is not the server revoking anything').toEqual([]);
    expect(storage.clearRefreshToken).not.toHaveBeenCalled();
  });

  it('keeps the credential when there is no network at all', async () => {
    const session = await freshSession();
    storage.readRefreshToken.mockResolvedValue('refresh-alice');
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));

    expect(await session.getAccessToken()).toBeNull();
    expect(
      storage.clearRefreshToken,
      'losing signal must not sign anybody out',
    ).not.toHaveBeenCalled();
  });

  it('presents a rotated token once, however many callers ask at once', async () => {
    const session = await freshSession();
    storage.readRefreshToken.mockResolvedValue('refresh-alice');
    vi.mocked(fetch).mockResolvedValue(Response.json(PAIR));

    const [a, b, c] = await Promise.all([
      session.getAccessToken(),
      session.getAccessToken(),
      session.getAccessToken(),
    ]);

    /*
     * The server treats a replaced refresh token coming back as theft and revokes every session,
     * so the single-flight promise is correctness rather than economy.
     */
    expect([a, b, c]).toEqual(['access-bob', 'access-bob', 'access-bob']);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('a subscriber', () => {
  it('hears nothing once it has unsubscribed', async () => {
    const session = await freshSession();
    const heard: boolean[] = [];
    session.subscribe((signedIn) => heard.push(signedIn))();

    await session.adopt(PAIR);

    expect(heard).toEqual([]);
  });
});

describe('the launch check', () => {
  it('reports a session only when a credential is actually stored', async () => {
    const session = await freshSession();

    storage.readRefreshToken.mockResolvedValue(null);
    expect(await session.hasStoredSession()).toBe(false);

    storage.readRefreshToken.mockResolvedValue('refresh-alice');
    expect(await session.hasStoredSession()).toBe(true);
  });
});
