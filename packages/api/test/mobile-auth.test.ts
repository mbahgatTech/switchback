import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@switchback/db';
import {
  AUTH_REQUEST_TTL_MS,
  MobileAuthError,
  authorizeAuthRequest,
  challengeFor,
  claimAuthRequest,
  isAllowedRedirect,
  pruneExpiredAuthRequests,
  startAuthRequest,
} from '@switchback/api/mobile-auth';
import { verifyAccessToken } from '@switchback/api/tokens';

/**
 * Integration tests for the browser-assisted sign-in handshake.
 *
 * Same shape and same reasoning as `tokens.test.ts`: the properties worth asserting here are
 * all statements about database state surviving between three separate HTTP requests — a code
 * can only be spent once, an authorized request cannot be re-authorized, a claim without the
 * matching verifier fails. None of that is observable without writing rows.
 *
 * `isAllowedRedirect` and `challengeFor` are pure and kept in the same file for the reason the
 * token suite gives: splitting one module's tests by whether they touch a socket makes them
 * harder to find, not easier.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(DATABASE_URL);

const EMAIL = 'zz-mobile-auth-integration-fixture@example.invalid';
const REDIRECT = 'switchback://signin';

/** 64 hex characters — exactly what `newVerifier()` produces on the device. */
const VERIFIER = 'a'.repeat(64);
const OTHER_VERIFIER = 'b'.repeat(64);

/** The code out of the deep link the browser was sent to. */
function codeFrom(target: string): string {
  return new URL(target).searchParams.get('code') ?? '';
}

describe('redirect allow-list', () => {
  it('always accepts the app-owned scheme', () => {
    expect(isAllowedRedirect('switchback://signin', false)).toBe(true);
    expect(isAllowedRedirect('switchback://signin?x=1', false)).toBe(true);
  });

  it('accepts Expo Go and localhost only where development schemes are allowed', () => {
    // Expo Go hands out a URL keyed to the current Wi-Fi lease, which is the whole reason
    // this flow exists — but it is also an address anything on the LAN can listen on, so it
    // is a development affordance and never a production one.
    expect(isAllowedRedirect('exp://192.168.1.42:8081/--/signin', true)).toBe(true);
    expect(isAllowedRedirect('exp://192.168.1.42:8081/--/signin', false)).toBe(false);
    expect(isAllowedRedirect('http://localhost:8081/signin', true)).toBe(true);
    expect(isAllowedRedirect('http://localhost:8081/signin', false)).toBe(false);
  });

  it('refuses anything that would bounce a signed-in browser off our origin', () => {
    // This endpoint redirects a browser that has just completed OIDC. An open redirect here
    // is a phishing primitive on our own domain even when the code riding along is
    // unredeemable, which is why the check happens before the row is written.
    for (const hostile of [
      'https://evil.example/steal',
      'http://evil.example/steal',
      'http://127.0.0.1.evil.example/',
      'javascript:alert(1)',
      'data:text/html,<script>',
      '//evil.example',
      '/signin',
      '',
    ]) {
      expect(isAllowedRedirect(hostile, true), hostile).toBe(false);
    }
  });
});

describe('challenge', () => {
  it('is the base64url SHA-256 of the verifier', async () => {
    // The known digest of the empty string, so this fails if the encoding drifts rather than
    // only if the two sides drift together.
    await expect(challengeFor('')).resolves.toBe('47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU');
  });

  it('produces something long enough for `startAuthRequest` to accept', async () => {
    const challenge = await challengeFor(VERIFIER);
    expect(challenge).toHaveLength(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/u);
  });
});

describe.skipIf(!IS_LOCAL).sequential('browser-assisted sign-in', () => {
  let userId: string;
  let otherUserId: string;
  let challenge: string;

  beforeAll(async () => {
    process.env.AUTH_SECRET ??= 'x'.repeat(48);
    challenge = await challengeFor(VERIFIER);

    await prisma.user.deleteMany({ where: { email: EMAIL } });
    const user = await prisma.user.create({ data: { email: EMAIL } });
    userId = user.id;
    const other = await prisma.user.create({ data: { email: `other-${EMAIL}` } });
    otherUserId = other.id;
  });

  afterAll(async () => {
    /*
     * By challenge rather than by user id: most of the rows this suite creates are never
     * authorized, so they have no user id to delete them by. The challenge is the digest of a
     * fixed 64-character verifier, which no real device will ever generate.
     */
    await prisma.mobileAuthRequest.deleteMany({ where: { challenge } });
    for (const id of [userId, otherUserId]) {
      await prisma.mobileAuthRequest.deleteMany({ where: { userId: id } });
      await prisma.mobileRefreshToken.deleteMany({ where: { userId: id } });
    }
    await prisma.user.deleteMany({ where: { email: { in: [EMAIL, `other-${EMAIL}`] } } });
    await prisma.$disconnect();
  });

  it('records the request without recording anything that could sign anyone in', async () => {
    const { id, browserSecret } = await startAuthRequest(prisma, {
      redirectUri: REDIRECT,
      challenge,
      deviceName: "Mazen's iPhone",
    });

    const row = await prisma.mobileAuthRequest.findUniqueOrThrow({ where: { id } });
    expect(row.challenge).toBe(challenge);
    expect(row.redirectUri).toBe(REDIRECT);
    expect(row.deviceName).toBe("Mazen's iPhone");
    // The first leg is unauthenticated by necessity. Until a browser comes back through
    // `/complete` with a session, the row is an intent with no authority attached to it.
    expect(row.userId).toBeNull();
    expect(row.codeHash).toBeNull();
    expect(row.claimedAt).toBeNull();
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + AUTH_REQUEST_TTL_MS);

    // The browser binding is stored as a digest, on the same reasoning as the code: a dump of
    // this table should not hand anybody the second half of an in-flight sign-in.
    expect(browserSecret).toHaveLength(43);
    expect(row.browserHash).not.toBe(browserSecret);
    expect(row.browserHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a redirect it will not honour, and a challenge too short to be one', async () => {
    await expect(
      startAuthRequest(prisma, { redirectUri: 'https://evil.example', challenge }),
    ).rejects.toMatchObject({ code: 'invalid_redirect' });

    // A short challenge is a guessable one, which would undo the point of having it: the
    // whole defence is that an intercepted code is useless without a preimage nobody has.
    await expect(
      startAuthRequest(prisma, { redirectUri: REDIRECT, challenge: 'short' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(
      startAuthRequest(prisma, { redirectUri: REDIRECT, challenge: `${'a'.repeat(42)}+` }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('completes the round trip and issues a usable token pair', async () => {
    const { id, browserSecret } = await startAuthRequest(prisma, {
      redirectUri: REDIRECT,
      challenge,
    });
    const target = await authorizeAuthRequest(prisma, id, userId, browserSecret);

    expect(target.startsWith('switchback://signin?')).toBe(true);
    // Echoed so the app can tell a deep link answering *its* request from one an attacker
    // started and hoped would land in the right foreground app.
    expect(new URL(target).searchParams.get('state')).toBe(id);

    const pair = await claimAuthRequest(prisma, {
      requestId: id,
      code: codeFrom(target),
      verifier: VERIFIER,
      deviceName: 'iPhone 15',
    });

    await expect(verifyAccessToken(pair.accessToken)).resolves.toBe(userId);
    const tokens = await prisma.mobileRefreshToken.findMany({ where: { userId } });
    expect(tokens.some((row) => row.deviceName === 'iPhone 15')).toBe(true);
  });

  it('stores a hash of the code, never the code', async () => {
    const { id, browserSecret } = await startAuthRequest(prisma, {
      redirectUri: REDIRECT,
      challenge,
    });
    const target = await authorizeAuthRequest(prisma, id, userId, browserSecret);
    const code = codeFrom(target);

    const row = await prisma.mobileAuthRequest.findUniqueOrThrow({ where: { id } });
    expect(row.codeHash).not.toBe(code);
    expect(row.codeHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a claim without the verifier that started it', async () => {
    const { id, browserSecret } = await startAuthRequest(prisma, {
      redirectUri: REDIRECT,
      challenge,
    });
    const target = await authorizeAuthRequest(prisma, id, userId, browserSecret);

    // The point of the whole design: any app on the device can register a URL scheme it does
    // not own, so holding the code has to be worth nothing on its own.
    await expect(
      claimAuthRequest(prisma, {
        requestId: id,
        code: codeFrom(target),
        verifier: OTHER_VERIFIER,
      }),
    ).rejects.toBeInstanceOf(MobileAuthError);

    // And the failure did not spend the row, so the device that *does* hold the verifier can
    // still finish — an interception attempt must not become a denial of service.
    await expect(
      claimAuthRequest(prisma, { requestId: id, code: codeFrom(target), verifier: VERIFIER }),
    ).resolves.toBeDefined();
  });

  it('refuses a guessed code', async () => {
    const { id, browserSecret } = await startAuthRequest(prisma, {
      redirectUri: REDIRECT,
      challenge,
    });
    await authorizeAuthRequest(prisma, id, userId, browserSecret);

    await expect(
      claimAuthRequest(prisma, { requestId: id, code: 'not-the-code', verifier: VERIFIER }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('spends the code exactly once', async () => {
    const { id, browserSecret } = await startAuthRequest(prisma, {
      redirectUri: REDIRECT,
      challenge,
    });
    const target = await authorizeAuthRequest(prisma, id, userId, browserSecret);
    const code = codeFrom(target);

    await claimAuthRequest(prisma, { requestId: id, code, verifier: VERIFIER });
    await expect(
      claimAuthRequest(prisma, { requestId: id, code, verifier: VERIFIER }),
    ).rejects.toMatchObject({ code: 'already_claimed' });
  });

  it('cannot be authorized twice, so a second signer cannot overwrite the first', async () => {
    const { id, browserSecret } = await startAuthRequest(prisma, {
      redirectUri: REDIRECT,
      challenge,
    });
    await authorizeAuthRequest(prisma, id, userId, browserSecret);

    // Without this, anyone who could replay `/complete` while signed in as themselves would
    // hand *their* account to a device that asked for somebody else's.
    await expect(
      authorizeAuthRequest(prisma, id, otherUserId, browserSecret),
    ).rejects.toMatchObject({
      code: 'already_claimed',
    });
  });

  it('refuses a claim on a request nobody signed in for', async () => {
    const { id } = await startAuthRequest(prisma, { redirectUri: REDIRECT, challenge });

    await expect(
      claimAuthRequest(prisma, { requestId: id, code: 'anything', verifier: VERIFIER }),
    ).rejects.toMatchObject({ code: 'not_authorized' });
  });

  it('refuses an unknown request id', async () => {
    await expect(
      authorizeAuthRequest(prisma, 'no-such-request', userId, 'anything'),
    ).rejects.toMatchObject({
      code: 'unknown_request',
    });
    await expect(
      claimAuthRequest(prisma, { requestId: 'no-such-request', code: 'x', verifier: VERIFIER }),
    ).rejects.toMatchObject({ code: 'unknown_request' });
  });

  it('refuses to authorize from a browser that did not start the request', async () => {
    /*
     * The CSRF fix, stated as a property. Without it, an attacker runs `/start` themselves —
     * so that they, not the victim, hold the PKCE verifier — and then walks the victim's
     * browser to `/complete?request=<id>`. `SameSite=Lax` sends the session cookie on a
     * top-level cross-site GET by design, so the row would be authorized against the victim's
     * account and the attacker would claim a sixty-day refresh token on it.
     */
    const mine = await startAuthRequest(prisma, { redirectUri: REDIRECT, challenge });
    const theirs = await startAuthRequest(prisma, { redirectUri: REDIRECT, challenge });

    await expect(
      authorizeAuthRequest(prisma, mine.id, userId, theirs.browserSecret),
    ).rejects.toMatchObject({ code: 'wrong_browser' });
    await expect(authorizeAuthRequest(prisma, mine.id, userId, '')).rejects.toMatchObject({
      code: 'wrong_browser',
    });

    // And the refusal did not spend the row: the browser that does hold the secret can still
    // finish. A forgery attempt must not become a denial of service on a real sign-in.
    await expect(
      authorizeAuthRequest(prisma, mine.id, userId, mine.browserSecret),
    ).resolves.toBeDefined();
  });

  it('refuses a row written before the binding column existed', async () => {
    // Requests in flight when this shipped have no `browserHash`, and null is treated as a
    // mismatch rather than as unchecked. They live fifteen minutes, so the whole population
    // clears within a quarter of an hour of a deploy; the alternative is a permanent hole.
    const { id } = await startAuthRequest(prisma, { redirectUri: REDIRECT, challenge });
    await prisma.mobileAuthRequest.update({ where: { id }, data: { browserHash: null } });

    await expect(authorizeAuthRequest(prisma, id, userId, 'anything')).rejects.toMatchObject({
      code: 'wrong_browser',
    });
  });

  it('expires, on both legs', async () => {
    const { id, browserSecret } = await startAuthRequest(prisma, {
      redirectUri: REDIRECT,
      challenge,
    });
    const target = await authorizeAuthRequest(prisma, id, userId, browserSecret);
    await prisma.mobileAuthRequest.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      claimAuthRequest(prisma, { requestId: id, code: codeFrom(target), verifier: VERIFIER }),
    ).rejects.toMatchObject({ code: 'expired' });

    const stale = await startAuthRequest(prisma, { redirectUri: REDIRECT, challenge });
    await prisma.mobileAuthRequest.update({
      where: { id: stale.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      authorizeAuthRequest(prisma, stale.id, userId, stale.browserSecret),
    ).rejects.toMatchObject({
      code: 'expired',
    });
  });

  it('prunes rows that expired an hour ago and keeps ones that just did', async () => {
    const ancient = await startAuthRequest(prisma, { redirectUri: REDIRECT, challenge });
    const recent = await startAuthRequest(prisma, { redirectUri: REDIRECT, challenge });

    await prisma.mobileAuthRequest.update({
      where: { id: ancient.id },
      data: { expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
    });
    await prisma.mobileAuthRequest.update({
      where: { id: recent.id },
      data: { expiresAt: new Date(Date.now() - 60 * 1000) },
    });

    const pruned = await pruneExpiredAuthRequests(prisma);
    expect(pruned).toBeGreaterThanOrEqual(1);

    expect(await prisma.mobileAuthRequest.findUnique({ where: { id: ancient.id } })).toBeNull();
    // Kept for the grace period so an app claiming a few seconds late gets `expired` — which
    // it can explain — rather than `unknown_request`, which reads like a bug in the server.
    expect(await prisma.mobileAuthRequest.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});
