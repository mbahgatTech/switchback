# Sign in with Apple

Everything here is already implemented. Apple sign-in is dark because
`AUTH_APPLE_ENABLED=false`, and it stays dark until you enrol in the Apple Developer
Program ($99/yr). Microsoft Entra ID works fully in the meantime, so nothing is blocked on
this — but the App Store requires that an app offering third-party sign-in also offers
Sign in with Apple, so this has to be on before submission.

Two separate flows use two separate identifiers, and mixing them up is the single most
common way this fails:

| Flow                   | Where                                    | `client_id` / `aud`                | Secret                       |
| ---------------------- | ---------------------------------------- | ---------------------------------- | ---------------------------- |
| Web (browser redirect) | `switchback.app/api/auth/callback/apple` | the **Services ID**                | an ES256 JWT we sign         |
| Native (iOS sheet)     | inside the app                           | the **App ID** (bundle identifier) | none — we verify their token |

---

## 1. Enrol and create the App ID

1. Enrol at <https://developer.apple.com/programs/> ($99/yr).
2. **Certificates, Identifiers & Profiles → Identifiers → +**
3. **App IDs → App**. Description "Switchback", Bundle ID `app.switchback.ios`
   (explicit, not wildcard — Sign in with Apple needs an explicit ID).
4. Under **Capabilities**, tick **Sign in with Apple**. Register.

This bundle ID is what native identity tokens carry in `aud`, so it becomes
`AUTH_APPLE_BUNDLE_ID`.

## 2. Create the Services ID (the web client)

1. **Identifiers → + → Services IDs**.
2. Description "Switchback Web", Identifier `app.switchback.web`. Register.
3. Open it, tick **Sign in with Apple**, then **Configure**:
   - **Primary App ID:** the App ID from step 1.
   - **Domains and Subdomains:** `switchback.app`
   - **Return URLs:** `https://switchback.app/api/auth/callback/apple`

   Apple rejects `localhost` and plain HTTP here. To test the _web_ flow locally, put a
   tunnel hostname (ngrok, Cloudflare Tunnel) in both fields and set `AUTH_URL` to match.
   The _native_ flow needs none of this — it works in the simulator on day one.

This Services ID becomes `AUTH_APPLE_ID`.

## 3. Create the signing key

1. **Keys → +**. Name it "Switchback Sign in with Apple".
2. Tick **Sign in with Apple**, **Configure** → pick the App ID from step 1. Save,
   Register, **Download**.
3. You get `AuthKey_XXXXXXXXXX.p8`. **Apple lets you download it exactly once.** The
   `XXXXXXXXXX` is the Key ID.

Your Team ID is in the top right of the developer portal, or under Membership.

## 4. Configure the environment

```dotenv
AUTH_APPLE_ENABLED="true"
AUTH_APPLE_ID="app.switchback.web"          # Services ID  — the web client_id
AUTH_APPLE_BUNDLE_ID="app.switchback.ios"   # App ID       — the native aud
AUTH_APPLE_TEAM_ID="ABCDE12345"
AUTH_APPLE_KEY_ID="XXXXXXXXXX"
AUTH_APPLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIGT...\n-----END PRIVATE KEY-----"
```

The `.p8` is multi-line and `.env` is not, so newlines are written as `\n` inside double
quotes; `applePrivateKey()` in `src/env.ts` unescapes them. On Vercel, paste the file
contents directly into the environment variable field — that one accepts real newlines.

`src/env.ts` validates these four as a set: with `AUTH_APPLE_ENABLED=true` and any one
missing, the server refuses to start and names the variable. With the flag off it ignores
them entirely, so half-finished setup is harmless.

**Never commit the `.p8`.** `.gitignore` already excludes `*.p8`, and anyone holding it
can mint sign-in tokens as you until you revoke the key.

Check the wiring without starting the app:

```bash
npm run apple:secret --workspace=@switchback/web
```

It prints the JWT and its decoded claims. `iss` must be the **Team** ID and `sub` the
**Services** ID — reversed is the usual cause of `invalid_client`, and Apple's error says
nothing more specific than that.

## 5. The rotation you do not have to do

Apple caps client secrets at six months and expects you to rotate them. We sign a fresh
one-hour JWT per token exchange instead (`src/auth-apple.ts`), so there is no long-lived
secret to expire quietly at 3am on a Sunday six months from now. Signing costs a few
milliseconds of ECDSA and happens only at sign-in.

The **key** itself never expires. Rotate it only if it leaks: create a new key, update
`AUTH_APPLE_KEY_ID` and `AUTH_APPLE_PRIVATE_KEY`, deploy, then revoke the old one in the
portal.

## Things that will bite

**The name arrives exactly once.** Apple sends the user's real name in the _authorization
response_ on first consent only — never in the identity token, and never again. The native
client forwards it as `fullName` to `/api/auth/mobile/exchange`, which stores it on
account creation. Miss it and that account has no name permanently; deleting the app and
reinstalling does not bring it back. To test the first-run path again, revoke the app under
**Settings → your name → Sign-In & Security → Sign in with Apple** on the device.

**Private relay addresses are real addresses.** Users who hide their email get
`something@privaterelay.appleid.com`, which does receive mail — but only if the sending
domain is registered under **Certificates, Identifiers & Profiles → Services → Sign in with
Apple for Email Communication**. Unregistered senders are dropped silently. This matters
the first time Switchback sends a Lifeline alert or a trip summary.

**A revoked Apple account keeps working until you check.** If a user revokes access, their
identity token stops being issued but our refresh token remains valid for 60 days. Apple
offers a server-to-server notification endpoint for this; wiring it is a Phase 7 item.

## After enabling

1. `AUTH_APPLE_ENABLED=true` locally, restart, confirm the button appears on `/`.
2. Web flow through the tunnel hostname end to end.
3. Native flow in the simulator: `expo-apple-authentication` → `/api/auth/mobile/exchange`
   → confirm a `users` row and an `accounts` row with `provider = 'apple'`.
4. Sign in with Apple _and_ Microsoft using the same verified address, and confirm you
   land on one account rather than two.
