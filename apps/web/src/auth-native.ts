/**
 * Native sign-in: verifying a provider's OIDC identity token into a Switchback account. The
 * website never uses this — on iOS the dance happens in the system and returns a token, not a
 * code, so we check signature, issuer, audience and expiry against the provider's JWKS ourselves.
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { env } from '@/env';

export type NativeProvider = 'microsoft-entra-id' | 'apple';

export class IdentityTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityTokenError';
  }
}

export interface VerifiedIdentity {
  provider: NativeProvider;
  /** The provider's stable id for this person — `sub`. Never the email. */
  providerAccountId: string;
  email: string | null;
  /** Whether the provider asserts it verified that email. Drives account linking. */
  emailVerified: boolean;
  name: string | null;
}

/**
 * Module scope on purpose: `createRemoteJWKSet` caches the key set and refetches on an unknown
 * `kid`, so this is one round trip per key rotation. Constructing it per request defeats it.
 */
const JWKS = {
  'microsoft-entra-id': createRemoteJWKSet(
    new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'),
  ),
  apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys')),
} as const;

/**
 * A pattern, not an equality: signing in against `/common` means `iss` names whichever tenant the
 * person belongs to. `9188040d-…` is the well-known tenant for personal Microsoft accounts.
 */
const ENTRA_ISSUER = /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i;

const APPLE_ISSUER = 'https://appleid.apple.com';

function nativeAudience(provider: NativeProvider): string {
  if (provider === 'apple') {
    // Native Apple sign-in puts the *App ID* (bundle identifier) in `aud`, not the Services ID
    // the web flow uses. Verifying against the Services ID fails every time.
    const bundleId = env.AUTH_APPLE_BUNDLE_ID;
    if (!bundleId) throw new IdentityTokenError('AUTH_APPLE_BUNDLE_ID is not configured');
    return bundleId;
  }
  // Entra can serve the browser and the app from one registration; the override is for setups
  // that keep them separate.
  const clientId = env.AUTH_MICROSOFT_ENTRA_ID_MOBILE_ID ?? env.AUTH_MICROSOFT_ENTRA_ID_ID;
  if (!clientId) throw new IdentityTokenError('Microsoft sign-in is not configured');
  return clientId;
}

/** Apple sends `email_verified` as a boolean in some flows and the string "true" in others. */
function claimIsTrue(value: JWTPayload[string]): boolean {
  return value === true || value === 'true';
}

export async function verifyIdentityToken(
  provider: NativeProvider,
  idToken: string,
  /** Only present when the client generated one; when it did, it must match. */
  expectedNonce?: string,
): Promise<VerifiedIdentity> {
  if (provider === 'apple' && !env.AUTH_APPLE_ENABLED) {
    throw new IdentityTokenError('Apple sign-in is not enabled on this server');
  }

  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(idToken, JWKS[provider], {
      audience: nativeAudience(provider),
      issuer: provider === 'apple' ? APPLE_ISSUER : undefined,
      // 60 s for a phone whose clock has drifted. Any more and an expired token stays usable.
      clockTolerance: 60,
    }));
  } catch (error) {
    throw new IdentityTokenError(
      `identity token rejected: ${error instanceof Error ? error.message : 'unknown'}`,
    );
  }

  // `jwtVerify` cannot check a pattern, so the multi-tenant issuer is checked after.
  if (provider === 'microsoft-entra-id' && !ENTRA_ISSUER.test(String(payload.iss))) {
    throw new IdentityTokenError('identity token issuer is not a Microsoft tenant');
  }

  if (expectedNonce && payload.nonce !== expectedNonce) {
    throw new IdentityTokenError('nonce mismatch');
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new IdentityTokenError('identity token has no subject');
  }

  const email =
    typeof payload.email === 'string'
      ? payload.email
      : typeof payload.preferred_username === 'string' && payload.preferred_username.includes('@')
        ? payload.preferred_username
        : null;

  return {
    provider,
    providerAccountId: payload.sub,
    email,
    /**
     * **The nOAuth defence — do not make this conditional.** Entra emits no `email_verified`, and
     * its `email` claim is a tenant-mutable directory attribute; signing against `/common` means
     * anyone can set a user's `mail` to somebody else's in a tenant they made this morning and
     * hand us a correctly-signed token. `false` unconditionally is what keeps the
     * `email_taken_unverified` guard in `app/api/auth/mobile/exchange/route.ts` reachable. The
     * price, paid on purpose: a browser-made account signing in on the phone under a different
     * `sub` is refused rather than merged.
     */
    emailVerified: provider === 'apple' ? claimIsTrue(payload.email_verified) : false,
    name: typeof payload.name === 'string' ? payload.name : null,
  };
}
