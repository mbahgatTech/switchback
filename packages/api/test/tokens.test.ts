import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '@switchback/db';
import {
  ACCESS_TOKEN_TTL_S,
  REFRESH_TOKEN_TTL_S,
  RefreshTokenError,
  issueTokenPair,
  pruneExpiredRefreshTokens,
  revokeAllRefreshTokens,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  verifyAccessToken,
} from '@switchback/api/tokens';

/**
 * Integration tests for the mobile token layer.
 *
 * Like the spatial suite, these need a live local Postgres — the refresh half of this
 * module *is* database state, and the properties worth asserting (a rotated token stops
 * working, a reused one takes every sibling down with it) are only observable by writing
 * rows and reading them back.
 *
 * The access-token tests are pure and would run anywhere, but they live here rather than
 * in a second file because splitting one module's tests across two files by whether they
 * touch a socket makes them harder to find, not easier.
 */
const DATABASE_URL = process.env.DATABASE_URL ?? '';
const IS_LOCAL = /@(localhost|127\.0\.0\.1|host\.docker\.internal)[:/]/.test(DATABASE_URL);

const EMAIL = 'zz-token-integration-fixture@example.invalid';

async function tokenRows(userId: string) {
  return prisma.mobileRefreshToken.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * The key the module itself is signing with, for the tests that forge a token.
 *
 * Throwing rather than defaulting to `''`: an empty key would still produce a valid HS256
 * signature, so the "rejects a different secret" tests below would pass for the wrong
 * reason if `beforeAll` ever stopped running.
 */
function currentSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error('AUTH_SECRET is not set — beforeAll should have set it');
  return new TextEncoder().encode(secret);
}

describe.skipIf(!IS_LOCAL).sequential('mobile tokens', () => {
  let userId: string;

  beforeAll(async () => {
    // The module reads AUTH_SECRET at call time rather than import time, so a repo whose
    // .env has not been filled in still runs these — the value only has to be stable
    // within the process, not correct for any real deployment.
    process.env.AUTH_SECRET ??= 'x'.repeat(48);

    await prisma.user.deleteMany({ where: { email: EMAIL } });
    const user = await prisma.user.create({ data: { email: EMAIL } });
    userId = user.id;
  });

  afterAll(async () => {
    await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
    await prisma.user.deleteMany({ where: { email: EMAIL } });
    await prisma.$disconnect();
  });

  describe('access tokens', () => {
    it('round-trips the user id', async () => {
      const token = await signAccessToken(userId);
      await expect(verifyAccessToken(token)).resolves.toBe(userId);
    });

    it('returns null rather than throwing for a malformed token', async () => {
      // The tRPC context calls this on every request including public ones, so a stale
      // token in an old build of the app must degrade to "signed out", not to a 500.
      await expect(verifyAccessToken('not-a-jwt')).resolves.toBeNull();
      await expect(verifyAccessToken('')).resolves.toBeNull();
    });

    it('rejects a token signed with a different secret', async () => {
      const forged = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setIssuer('switchback')
        .setAudience('switchback-mobile')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(new TextEncoder().encode('y'.repeat(48)));

      await expect(verifyAccessToken(forged)).resolves.toBeNull();
    });

    it('rejects a correctly signed token minted for a different audience', async () => {
      // This is the check that stops an Auth.js-issued token, or any other token we sign
      // with the same secret for another purpose, from being accepted as a mobile login.
      const wrongAudience = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setIssuer('switchback')
        .setAudience('somewhere-else')
        .setIssuedAt()
        .setExpirationTime('15m')
        .sign(currentSecret());

      await expect(verifyAccessToken(wrongAudience)).resolves.toBeNull();
    });

    it('rejects an expired token', async () => {
      const past = Math.floor(Date.now() / 1000) - 3600;
      const expired = await new SignJWT({})
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setSubject(userId)
        .setIssuer('switchback')
        .setAudience('switchback-mobile')
        .setIssuedAt(past)
        .setExpirationTime(past + ACCESS_TOKEN_TTL_S)
        .sign(currentSecret());

      await expect(verifyAccessToken(expired)).resolves.toBeNull();
    });
  });

  describe('refresh tokens', () => {
    beforeAll(async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
    });

    it('stores a hash of the refresh token, never the token', async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
      const pair = await issueTokenPair(prisma, userId, 'iPhone 15');

      const rows = await tokenRows(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.tokenHash).not.toBe(pair.refreshToken);
      // SHA-256, hex.
      expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]!.deviceName).toBe('iPhone 15');
      expect(rows[0]!.revokedAt).toBeNull();

      // The advertised expiry is the row's, not an independent guess the client would
      // then disagree with.
      expect(pair.refreshExpiresAt.getTime()).toBeCloseTo(rows[0]!.expiresAt.getTime(), -3);
      expect(pair.expiresIn).toBe(ACCESS_TOKEN_TTL_S);
    });

    it('rotates: the new token works and the old one is revoked', async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
      const first = await issueTokenPair(prisma, userId, 'iPhone 15');
      const second = await rotateRefreshToken(prisma, first.refreshToken);

      expect(second.refreshToken).not.toBe(first.refreshToken);
      await expect(verifyAccessToken(second.accessToken)).resolves.toBe(userId);

      const rows = await tokenRows(userId);
      expect(rows).toHaveLength(2);
      expect(rows[0]!.revokedAt).not.toBeNull();
      expect(rows[1]!.revokedAt).toBeNull();
      // The chain is walkable, which is what makes an incident reconstructible.
      expect(rows[0]!.replacedBy).toBe(rows[1]!.id);
    });

    it('carries the device name forward when rotation does not supply one', async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
      const first = await issueTokenPair(prisma, userId, "Mazen's iPhone");
      await rotateRefreshToken(prisma, first.refreshToken);

      const rows = await tokenRows(userId);
      expect(rows[1]!.deviceName).toBe("Mazen's iPhone");
    });

    it('rejects an unknown token', async () => {
      await expect(rotateRefreshToken(prisma, 'never-issued')).rejects.toThrow(RefreshTokenError);
    });

    it('rejects an expired token without revoking anything else', async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
      const live = await issueTokenPair(prisma, userId, 'live device');
      const stale = await issueTokenPair(prisma, userId, 'stale device');

      // Backdate past its own expiry. Expiry is not reuse — the user simply did not open
      // the app for two months, and that must not sign out their other devices.
      await prisma.mobileRefreshToken.updateMany({
        where: { userId, deviceName: 'stale device' },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await expect(rotateRefreshToken(prisma, stale.refreshToken)).rejects.toMatchObject({
        name: 'RefreshTokenError',
        reuseDetected: false,
      });

      await expect(rotateRefreshToken(prisma, live.refreshToken)).resolves.toBeDefined();
    });

    it('detects reuse and revokes every session the user has', async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
      const phone = await issueTokenPair(prisma, userId, 'iPhone');
      await issueTokenPair(prisma, userId, 'iPad');

      const rotated = await rotateRefreshToken(prisma, phone.refreshToken);

      // Presenting the already-rotated token: two copies of it exist, and we cannot tell
      // which caller is the thief, so both go.
      const error = await rotateRefreshToken(prisma, phone.refreshToken).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RefreshTokenError);
      expect((error as RefreshTokenError).reuseDetected).toBe(true);

      const rows = await tokenRows(userId);
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);

      // Including the replacement the legitimate device is holding, and the unrelated iPad.
      await expect(rotateRefreshToken(prisma, rotated.refreshToken)).rejects.toThrow(
        RefreshTokenError,
      );
    });

    it('revokes one device without touching the others, idempotently', async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
      const phone = await issueTokenPair(prisma, userId, 'iPhone');
      const pad = await issueTokenPair(prisma, userId, 'iPad');

      await revokeRefreshToken(prisma, phone.refreshToken);
      // Sign-out has to work when the access token has already expired, so the endpoint is
      // unauthenticated and callable twice. Neither call may throw.
      await revokeRefreshToken(prisma, phone.refreshToken);
      await revokeRefreshToken(prisma, 'never-issued');

      // A signed-out device replaying its last refresh is a stale client, not a thief: the
      // token has no successor, so nobody else can be holding a live copy of it. Rejecting
      // it is right; cascading would let anyone sign a user out everywhere by signing out
      // of one device and retrying.
      await expect(rotateRefreshToken(prisma, phone.refreshToken)).rejects.toMatchObject({
        name: 'RefreshTokenError',
        reuseDetected: false,
      });
      await expect(rotateRefreshToken(prisma, pad.refreshToken)).resolves.toBeDefined();
    });

    it('revokes everything for "sign out everywhere"', async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });
      const phone = await issueTokenPair(prisma, userId, 'iPhone');
      const pad = await issueTokenPair(prisma, userId, 'iPad');

      await revokeAllRefreshTokens(prisma, userId);

      for (const pair of [phone, pad]) {
        await expect(rotateRefreshToken(prisma, pair.refreshToken)).rejects.toThrow(
          RefreshTokenError,
        );
      }
    });

    it('prunes long-expired rows and keeps revoked-but-unexpired ones', async () => {
      await prisma.mobileRefreshToken.deleteMany({ where: { userId } });

      const recent = await issueTokenPair(prisma, userId, 'recently revoked');
      await revokeRefreshToken(prisma, recent.refreshToken);
      await issueTokenPair(prisma, userId, 'live');
      await issueTokenPair(prisma, userId, 'ancient');

      await prisma.mobileRefreshToken.updateMany({
        where: { userId, deviceName: 'ancient' },
        data: { expiresAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      });
      // Expired, but only yesterday — inside the 7-day grace, so still evidence.
      await prisma.mobileRefreshToken.updateMany({
        where: { userId, deviceName: 'recently revoked' },
        data: { expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });

      const pruned = await pruneExpiredRefreshTokens(prisma);
      expect(pruned).toBeGreaterThanOrEqual(1);

      const names = (await tokenRows(userId)).map((r) => r.deviceName);
      expect(names).toContain('live');
      // Kept deliberately: a revoked row inside the window is what reuse detection matches
      // against. Pruning it early turns a stolen token back into an unknown one.
      expect(names).toContain('recently revoked');
      expect(names).not.toContain('ancient');
    });

    it('issues a refresh token that outlives the access token by two months', () => {
      // Guarding the relationship, not the constants: an access TTL that crept past the
      // refresh TTL would make every refresh a no-op.
      expect(REFRESH_TOKEN_TTL_S).toBeGreaterThan(ACCESS_TOKEN_TTL_S * 100);
      expect(ACCESS_TOKEN_TTL_S).toBe(900);
      expect(REFRESH_TOKEN_TTL_S).toBe(60 * 24 * 60 * 60);
    });
  });
});
