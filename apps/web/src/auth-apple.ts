/**
 * Apple's client secret.
 *
 * Every other OIDC provider hands you a static client secret. Apple hands you an ECDSA
 * private key (`.p8`) and expects you to mint a short-lived ES256 JWT with it, signed
 * fresh, on every token exchange. That is the entire reason this file exists.
 *
 * Apple caps the lifetime at six months (15777000 s). We use one hour and generate it
 * per request, which removes the rotation problem completely — there is no long-lived
 * secret sitting in an environment variable waiting to expire silently in half a year.
 * Signing is a few milliseconds of ECDSA, and it happens only at sign-in.
 *
 * Setup for the `.p8` and the Services ID is in `docs/auth-apple.md`.
 */
import { SignJWT, importPKCS8 } from 'jose';
import { applePrivateKey, env } from '@/env';

/** Apple requires this exact audience. */
const APPLE_AUDIENCE = 'https://appleid.apple.com';
const LIFETIME_S = 60 * 60;

export async function appleClientSecret(): Promise<string> {
  const { AUTH_APPLE_ID, AUTH_APPLE_TEAM_ID, AUTH_APPLE_KEY_ID } = env;
  if (!AUTH_APPLE_ID || !AUTH_APPLE_TEAM_ID || !AUTH_APPLE_KEY_ID) {
    throw new Error('Apple sign-in is not configured; see docs/auth-apple.md');
  }

  const key = await importPKCS8(applePrivateKey(), 'ES256');
  const now = Math.floor(Date.now() / 1000);

  return (
    new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: AUTH_APPLE_KEY_ID })
      // iss is the *team*, sub is the Services ID. Swapping them is the single most
      // common Apple setup mistake and the error Apple returns says only `invalid_client`.
      .setIssuer(AUTH_APPLE_TEAM_ID)
      .setSubject(AUTH_APPLE_ID)
      .setAudience(APPLE_AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + LIFETIME_S)
      .sign(key)
  );
}
