/**
 * Native sign-in: turning a provider identity token into a Switchback account.
 *
 * The website never uses this. On iOS the OAuth dance happens inside the system — Apple's
 * native sheet, or a browser session `expo-auth-session` opens — and what comes back is an
 * OIDC identity token, not an authorization code. So we verify that token ourselves
 * against the provider's JWKS and mint our own pair.
 *
 * Everything below is the verification an OIDC relying party is required to do and that
 * is easy to skip: signature against the provider's *current* published keys, issuer,
 * audience, and expiry. A token that fails any of them is not a login attempt with bad
 * input — it is someone handing us a token minted for a different app.
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
 * `createRemoteJWKSet` caches the key set and refetches on an unknown `kid`, so this is
 * one network round trip per key rotation rather than one per sign-in. Module scope is
 * what makes that cache shared; constructing it per request would defeat it entirely.
 */
const JWKS = {
  'microsoft-entra-id': createRemoteJWKSet(
    new URL('https://login.microsoftonline.com/common/discovery/v2.0/keys'),
  ),
  apple: createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys')),
} as const;

/**
 * The multi-tenant issuer.
 *
 * Because we sign in against `/common`, the `iss` claim names whichever tenant the person
 * belongs to — it is not a fixed string we can compare against, which is why this is a
 * pattern rather than an equality check. The tenant id is a GUID, and `9188040d-…` is the
 * well-known tenant for personal Microsoft accounts.
 */
const ENTRA_ISSUER = /^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/i;

const APPLE_ISSUER = 'https://appleid.apple.com';

function nativeAudience(provider: NativeProvider): string {
  if (provider === 'apple') {
    // Native Apple sign-in puts the *App ID* (bundle identifier) in `aud`, not the
    // Services ID the web flow uses. Verifying against the Services ID here fails every
    // time and the mismatch is not obvious from the error.
    const bundleId = env.AUTH_APPLE_BUNDLE_ID;
    if (!bundleId) throw new IdentityTokenError('AUTH_APPLE_BUNDLE_ID is not configured');
    return bundleId;
  }
  // Entra can serve the browser and the app from one registration with two platform
  // configurations, in which case this is the same client id. The override exists for
  // the setups that keep them separate.
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
      // 60 s of tolerance for a phone whose clock has drifted. Any more and an expired
      // token stays usable long enough to matter.
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
     * Apple states this explicitly, and is believed.
     *
     * **Entra is not, and this is the whole of the nOAuth defence.** Microsoft does not emit
     * `email_verified` at all, and the `email` claim it does emit is a tenant-mutable
     * directory attribute — Microsoft's own guidance says it is unsuitable for identifying a
     * user. We sign against `/common`, so the tenant on the other end is whichever one the
     * caller belongs to, including a free one they created this morning. Anybody can set a
     * user's `mail` to somebody else's address there and hand us a perfectly valid,
     * correctly-signed token asserting it.
     *
     * So `false`, unconditionally, which is what makes the `email_taken_unverified` guard in
     * `app/api/auth/mobile/exchange/route.ts` reachable for the only provider production has
     * switched on. Before this it read `email !== null` — true whenever an email existed —
     * and the guard was dead code protecting nothing.
     *
     * The cost is real and is paid on purpose: somebody who made their account in a browser
     * and then signs in on the phone with the same Microsoft account, but a *different*
     * `sub`, is refused rather than merged. That is a rare case with a clear instruction; the
     * alternative is a takeover with none.
     */
    emailVerified: provider === 'apple' ? claimIsTrue(payload.email_verified) : false,
    name: typeof payload.name === 'string' ? payload.name : null,
  };
}
