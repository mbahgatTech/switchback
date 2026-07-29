/**
 * Tokens for the native app.
 *
 * The website authenticates with an Auth.js session cookie and none of this applies to
 * it. iOS cannot use that cookie: the sign-in happens in a system browser sheet
 * (`expo-auth-session` / `expo-apple-authentication`), which hands the app an identity
 * token and then closes. So the app trades that identity token for a pair of ours —
 * a short-lived access JWT it sends on every request, and a long-lived opaque refresh
 * token it keeps in the Keychain.
 *
 * Two deliberate asymmetries:
 *
 * - **The access token is a JWT and is never stored.** Verifying it is a signature check
 *   with no database round trip, which is what makes it cheap enough to put on every
 *   call. The cost is that it cannot be revoked, which is why it lives 15 minutes.
 * - **The refresh token is opaque and *is* stored, hashed.** It is a database lookup
 *   every time, but it is used once an hour at most, and being stored is what makes
 *   revocation and reuse detection possible at all. Hashed because a leaked backup of
 *   this table should not be a leaked set of live credentials — same reasoning as
 *   password storage, minus the need for a slow KDF, since these are 256 bits of
 *   entropy rather than something a human chose.
 */
import { SignJWT, jwtVerify } from 'jose';
import type { PrismaClient } from '@switchback/db';

const ISSUER = 'switchback';
const AUDIENCE = 'switchback-mobile';

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const REFRESH_TOKEN_TTL_S = 60 * 24 * 60 * 60;

/** Thrown for every refresh failure, deliberately without saying which one. */
export class RefreshTokenError extends Error {
  /** Set when the failure was a reuse, so the caller can log it as a security event. */
  readonly reuseDetected: boolean;

  constructor(message: string, reuseDetected = false) {
    super(message);
    this.name = 'RefreshTokenError';
    this.reuseDetected = reuseDetected;
  }
}

function secretKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

export interface TokenPair {
  accessToken: string;
  /** Seconds until `accessToken` expires — the client refreshes shortly before this. */
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

export async function signAccessToken(userId: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + ACCESS_TOKEN_TTL_S)
    .sign(secretKey());
}

/**
 * Returns the user id, or null for anything wrong with the token.
 *
 * Null rather than throwing because the caller is the tRPC context, which runs on every
 * request including public ones: a stale token on a public procedure should degrade to
 * "not signed in", not 500.
 */
export async function verifyAccessToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return typeof payload.sub === 'string' ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * 256 bits from the CSPRNG, base64url so it survives a header untouched.
 *
 * Exported for `mobile-auth.ts`, which mints one-time codes with the same properties and
 * should not be growing a second opinion about how to do it.
 */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/** SHA-256, hex. What goes in the database in place of a live credential. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Mint a fresh pair. Called after a successful identity-token exchange. */
export async function issueTokenPair(
  db: PrismaClient,
  userId: string,
  deviceName?: string | null,
): Promise<TokenPair> {
  const refreshToken = randomToken();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000);

  await db.mobileRefreshToken.create({
    data: {
      userId,
      tokenHash: await hashToken(refreshToken),
      deviceName: deviceName ?? null,
      expiresAt: refreshExpiresAt,
    },
  });

  return {
    accessToken: await signAccessToken(userId),
    expiresIn: ACCESS_TOKEN_TTL_S,
    refreshToken,
    refreshExpiresAt,
  };
}

/**
 * Exchange a refresh token for a new pair, invalidating the old one.
 *
 * Rotation on every use, with reuse detection. If a token that has already been *rotated*
 * comes back, there are two live copies of it — ours and someone else's — and there is no
 * way to tell from here which caller is the thief. So we assume the worst and revoke every
 * refresh token the user has, signing out all their devices. That is a real cost to a
 * legitimate user who hit a network retry at exactly the wrong moment, and it is still the
 * right trade: the alternative is leaving an attacker with a valid session.
 *
 * "Rotated" and "revoked" are not the same thing, which is why `replacedBy` is what the
 * check reads rather than `revokedAt`. A token revoked by an explicit sign-out has no
 * successor, and a device replaying its last refresh after the user signed out is a stale
 * client, not a compromise — cascading there would let anyone sign a user out of every
 * device by signing out of one and retrying.
 */
export async function rotateRefreshToken(
  db: PrismaClient,
  presented: string,
  deviceName?: string | null,
): Promise<TokenPair> {
  const tokenHash = await hashToken(presented);
  const existing = await db.mobileRefreshToken.findUnique({ where: { tokenHash } });

  if (!existing) throw new RefreshTokenError('unknown refresh token');

  if (existing.replacedBy !== null) {
    await db.mobileRefreshToken.updateMany({
      where: { userId: existing.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new RefreshTokenError('refresh token reuse detected; all sessions revoked', true);
  }

  if (existing.revokedAt) throw new RefreshTokenError('refresh token revoked');

  if (existing.expiresAt.getTime() <= Date.now()) {
    throw new RefreshTokenError('refresh token expired');
  }

  const next = randomToken();
  const nextHash = await hashToken(next);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_S * 1000);

  // Interactive transaction because the replacement's id is not known until it exists, and
  // `replacedBy` has to land in the same atomic step as the revocation: a row that is
  // revoked but not yet marked as replaced reads, for as long as that window is open, like
  // an ordinary sign-out — which is precisely the case reuse detection must not miss.
  await db.$transaction(async (tx) => {
    const created = await tx.mobileRefreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: nextHash,
        deviceName: deviceName ?? existing.deviceName,
        expiresAt: refreshExpiresAt,
      },
    });
    await tx.mobileRefreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedBy: created.id },
    });
  });

  return {
    accessToken: await signAccessToken(existing.userId),
    expiresIn: ACCESS_TOKEN_TTL_S,
    refreshToken: next,
    refreshExpiresAt,
  };
}

/** Sign out one device. Idempotent — an already-revoked or unknown token is a no-op. */
export async function revokeRefreshToken(db: PrismaClient, presented: string): Promise<void> {
  await db.mobileRefreshToken.updateMany({
    where: { tokenHash: await hashToken(presented), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Sign out every device. Used by "sign out everywhere" and by reuse detection. */
export async function revokeAllRefreshTokens(db: PrismaClient, userId: string): Promise<void> {
  await db.mobileRefreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Delete refresh tokens that expired more than a week ago.
 *
 * Not the same as revoking: revoked-but-unexpired rows have to stay, because they are
 * what reuse detection matches against. Once a token is past its own expiry it would be
 * rejected anyway, so the row stops carrying information. Drained by the cron.
 */
export async function pruneExpiredRefreshTokens(db: PrismaClient): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const { count } = await db.mobileRefreshToken.deleteMany({
    where: { expiresAt: { lt: cutoff } },
  });
  return count;
}
