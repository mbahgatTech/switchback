# Sign in with Apple

**There is no Apple Developer account.** Sign in with Apple is implemented end to end and sits
dark behind `AUTH_APPLE_ENABLED=false`; it turns on with the $99/yr Apple Developer Program
enrolment, which TestFlight and the App Store also require. Microsoft Entra ID is live in the
meantime, so nothing is blocked — but the App Store requires that an app offering third-party
sign-in also offer Sign in with Apple, so this has to be on before submission.

Two flows use two different identifiers, and mixing them up is the usual way this fails:

| Flow                   | Where                                    | `client_id` / `aud`                | Secret                       |
| ---------------------- | ---------------------------------------- | ---------------------------------- | ---------------------------- |
| Web (browser redirect) | `switchback.app/api/auth/callback/apple` | the **Services ID**                | an ES256 JWT we sign         |
| Native (iOS sheet)     | inside the app                           | the **App ID** (bundle identifier) | none — we verify their token |

## The native exchange

```mermaid
sequenceDiagram
    participant App as iOS app
    participant Apple
    participant API as Switchback API
    participant Keychain as expo-secure-store

    App->>Apple: expo-apple-authentication sheet
    Apple-->>App: identity token, plus the real name on first consent only
    App->>API: POST /api/auth/mobile/exchange with idToken, nonce, fullName
    API->>Apple: verify the token against Apple's JWKS, check aud and nonce
    API-->>App: access JWT (15 min) and refresh token (60 days)
    App->>Keychain: store the refresh token in the iOS Keychain
```

The web flow is an ordinary Auth.js redirect and needs no diagram.

## Setting it up

Full portal walkthroughs live in Apple's own documentation; these are the values Switchback
needs out of them.

1. **App ID** — Certificates, Identifiers & Profiles → Identifiers → App IDs → App. Bundle ID
   `app.switchback.ios`, explicit rather than wildcard (Sign in with Apple requires explicit),
   with the **Sign in with Apple** capability ticked. This becomes `AUTH_APPLE_BUNDLE_ID`, and
   it is what native identity tokens carry in `aud`.
2. **Services ID** — Identifiers → Services IDs, identifier `app.switchback.web`. Configure it
   against the App ID above, domain `switchback.app`, return URL
   `https://switchback.app/api/auth/callback/apple`. This becomes `AUTH_APPLE_ID`. Apple
   rejects `localhost` and plain HTTP here, so testing the _web_ flow locally means a tunnel
   hostname (ngrok, Cloudflare Tunnel) in both fields with `AUTH_URL` set to match.
3. **Signing key** — Keys → +, Sign in with Apple, configured against the App ID. You get
   `AuthKey_XXXXXXXXXX.p8` and **Apple lets you download it exactly once**; `XXXXXXXXXX` is the
   Key ID. The Team ID is under Membership.

## Configuring the environment

```dotenv
AUTH_APPLE_ENABLED="true"
AUTH_APPLE_ID="app.switchback.web"          # Services ID  — the web client_id
AUTH_APPLE_BUNDLE_ID="app.switchback.ios"   # App ID       — the native aud
AUTH_APPLE_TEAM_ID="..."
AUTH_APPLE_KEY_ID="..."
AUTH_APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
```

The `.p8` is multi-line and `.env` is not, so newlines are written as `\n` inside double quotes
and `applePrivateKey()` in `src/env.ts` unescapes them. Hosting dashboards that accept real
newlines take the file contents directly.

`src/env.ts` validates these five as a set: with the flag on and any one missing the server
refuses to start and names the variable. With the flag off it ignores them, so a half-finished
setup is harmless.

**Never commit the `.p8`**, and never paste a key or a minted secret into this file or any
other. `.gitignore` excludes `*.p8`; anyone holding one can mint sign-in tokens as us until the
key is revoked.

Check the wiring without starting the app:

```bash
npm run apple:secret --workspace=@switchback/web
```

It prints the JWT and its decoded claims. `iss` must be the **Team** ID and `sub` the
**Services** ID — reversed is the usual cause of `invalid_client`, which is all Apple will tell
you.

## Secret lifetime and rotation

Apple caps a client secret at six months and expects it rotated on that schedule. We do not
store one: `src/auth-apple.ts` signs a fresh one-hour ES256 JWT per token exchange, so there is
no dated secret to expire quietly. The `.p8` **key** never expires — rotate it only if it
leaks: create a new key, update `AUTH_APPLE_KEY_ID` and `AUTH_APPLE_PRIVATE_KEY`, deploy, then
revoke the old one in the portal.

## Things that will bite

**The name arrives exactly once.** Apple sends the user's real name in the authorization
response on first consent only — never in the identity token, never again. The client forwards
it as `fullName` to `/api/auth/mobile/exchange`, which stores it at account creation. Miss it
and that account has no name permanently. To replay the first-run path, revoke the app under
Settings → your name → Sign-In & Security → Sign in with Apple.

**Private relay addresses are real addresses.** `something@privaterelay.appleid.com` receives
mail only if the sending domain is registered under Services → Sign in with Apple for Email
Communication. Unregistered senders are dropped silently, which will matter the first time
Switchback sends a Lifeline alert.

**A revoked Apple account keeps working until you check.** Revoking access stops new identity
tokens, but our refresh token stays valid for 60 days. Apple's server-to-server notification
endpoint would close that window and is not wired up.

## After enabling

1. Set `AUTH_APPLE_ENABLED=true`, restart, confirm the button appears on `/`.
2. Web flow end to end through the tunnel hostname.
3. Native flow — needs a development build, so a Mac and the enrolment. Confirm a `users` row
   and an `accounts` row with `provider = 'apple'`.
4. Sign in with Apple _and_ Microsoft on the same verified address, and confirm you land on one
   account rather than two.
