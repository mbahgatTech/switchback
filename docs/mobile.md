# The iOS app

`apps/mobile` is an Expo (React Native) app. It is iOS-only on purpose — the "web version"
of Switchback is `apps/web`, a real Next.js site with server rendering and its own routes,
not React Native compiled to DOM. There is no `react-native-web` here and no `android/`.

The whole point of choosing Expo over SwiftUI is `packages/*`: the app imports the same
domain code, the same zod schemas, and the same tRPC router _type_ as the website. Change a
procedure and both clients fail to compile against it in the same second.

---

## Prerequisites

**Node 22 LTS or 24.** React Native 0.86 requires `^20.19.4 || ^22.13.0 || ^24.3.0 || >=25`,
and `.npmrc` sets `engine-strict=true`, so a mismatch is a failed install with a clear
message rather than a Metro crash three commands later. Node 20 left maintenance in April
2026 — 20.19 satisfies the floor but is not worth installing today.

The Expo Go app from the App Store, on an iPhone on the same Wi-Fi as this machine. No Xcode
and no Mac required for anything in Phases 0–6, which is why the stack was chosen.

---

## Running it

```bash
npm run db:up                 # Postgres 17 + PostGIS on :5433
npm run dev                   # the API and website on :3000 — required, the app is a client
npm run mobile                # Metro; scan the QR code with the iPhone camera
```

`npm run dev` is not optional. The app has no local data store yet; every screen it renders
comes from tRPC.

### Why you never type an IP address

A phone running Expo Go cannot reach `localhost` — `localhost` on an iPhone is the iPhone.
The usual workaround is pasting a LAN IP into a config file and re-pasting it every time the
router hands out a new lease.

Metro already knows the answer. Expo exposes the host the bundle was served from, and the
machine serving the bundle is the machine running `next dev`, so `src/config.ts` derives the
API origin as that host on port 3000. Nothing to configure and nothing to forget.

`EXPO_PUBLIC_API_URL` overrides the derivation and should stay unset in development — see
the note in `.env.example`. It exists for release bundles, where there is no Metro host.

`EXPO_PUBLIC_*` values are inlined into the bundle at build time and are readable by anyone
holding the app. Public by definition; never put a secret behind that prefix.

---

## What is deliberately not importable

`apps/mobile/tsconfig.json` maps `@switchback/core` and exactly one thing from
`@switchback/api` — `import type { AppRouter }`. `@switchback/db` and the _value_ exports of
`@switchback/api` have no path entry at all.

That omission is the enforcement. Both reach Prisma and `node:crypto`, neither of which
exists in Hermes, and leaving the path off turns an accidental value import into a compile
error here instead of a red screen on the phone. The type-only import costs nothing at
runtime: TypeScript erases it, so no `@switchback/api` code is ever bundled.

Verified rather than assumed — `npx expo export --platform ios` then grep the `.hbc`:
`PrismaClient`, `@prisma`, and `node:crypto` are all absent; `superjson` is present, which is
correct, because the client needs it to revive `Date`s coming back over tRPC.

---

## Sessions

The server issues a 15-minute HS256 access JWT and a 60-day opaque refresh token
(`packages/api/src/tokens.ts`). The refresh token lives in the iOS Keychain via
`expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`: a refresh token restored onto a
second device from an encrypted backup is precisely the two-live-copies case that reuse
detection exists to catch, and having it trip on a restore rather than on a theft would be a
bad trade.

`src/auth/session.ts` is a plain module rather than a hook, and the single in-flight refresh
promise in it is a correctness requirement, not an optimisation. Refresh tokens rotate on
every use; a batched screen load firing three queries at once would otherwise present the
same token three times, and the second presentation looks exactly like a stolen token to the
server. The reward for opening the app would be being signed out of every device.

Two related rules in the same file:

- A network failure during refresh **keeps** the stored token. Offline is a normal state for
  this product; being signed out for hiking into a valley is not.
- Only an HTTP 401 clears it, because only the server can say a token is dead.

### Signing in goes through a browser, on purpose

The obvious approach — `expo-auth-session` opening Entra directly from the app — needs a
custom-scheme redirect URI registered with the provider. Expo Go cannot have one; it hands
out an `exp://192.168.x.x:8081` URL that changes with the network, and no provider will
register that. A dev client with the real `switchback://` scheme would work, and building one
for a physical iPhone needs the $99 Apple enrolment.

So sign-in is a **browser-assisted handshake**: the app opens the _website's_ sign-in in a
system browser, the server completes OIDC normally against its own already-registered
redirect URI, mints a token pair against a one-time code, and deep-links back to whatever URL
`Linking.createURL` produced. Entra never sees an `exp://` URL — only our own site does —
which sidesteps redirect-URI registration entirely and keeps working unchanged after the
Apple enrolment, when the scheme becomes stable and the `exp://` case can simply be dropped.

```
 app                          our server                        provider
  │  verifier = random                                              │
  │  challenge = sha256(verifier)                                   │
  ├─ GET /start?redirect=&challenge= ─►  row created, browser        │
  │                                      cookie set, 302 ──►        │
  │                                      /signin?callbackUrl=…      │
  │                                            └─ normal OIDC ─────►│
  │                                      session cookie ◄───────────┘
  │                                      GET  /complete?request=  → a question
  │                                      POST /complete            ← the answer
  │  ◄── 303 exp://…/--/signin?code=&state= ─┘
  ├─ POST /claim {request, code, verifier} ─►  code + verifier checked
  │  ◄── token pair ────────────────────────┘
```

The code delivered over the custom scheme is deliberately **half** a credential. Any app on
iOS may claim a scheme it does not own, so the claim also demands the verifier, which never
left the device that started the flow. That is PKCE, applied to our own leg rather than the
provider's.

| Piece                                                        | Where                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------- |
| Handshake rules, single-use enforcement, redirect allow-list | `packages/api/src/mobile-auth.ts`                              |
| The three endpoints                                          | `apps/web/app/api/auth/mobile/{start,complete,claim}/route.ts` |
| Device half — verifier, browser sheet, claim                 | `apps/mobile/src/auth/handshake.ts`                            |
| The screen                                                   | `apps/mobile/app/signin.tsx`                                   |

Four properties hold it together: the code is worthless without the verifier; everything is
single-use (`codeHash` is unique and `claimedAt` is set inside the transaction that reads it);
the redirect is allow-listed **before** it is stored, because an endpoint that bounces a
browser to an arbitrary URL after a successful sign-in is a phishing primitive on our own
domain even when the code riding along with it is unredeemable; and the request belongs to one
browser.

That last one is why `/complete` takes two requests. PKCE binds the row to the device that
will _claim_ it and says nothing about the browser that _authorises_ it — so an attacker who
ran `/start` themselves, and therefore holds the verifier, could navigate a victim's browser to
`/complete?request=…` and end up with a token pair on the victim's account. `SameSite=Lax`
sends the session cookie on a top-level cross-site GET; that is what Lax is for. So:

- `/start` sets a `__Host-` cookie and stores its digest as `browserHash`. A row can only be
  authorised by the browser that opened it.
- `GET /complete` renders a question naming the device. It mints nothing.
- `POST /complete` carries the Auth.js CSRF token and is the only thing that mints a code. A
  cross-site form POST does not carry a Lax cookie, and a sibling subdomain cannot read the
  token out of an `HttpOnly` cookie.
- Both legs refuse a `Sec-Fetch-Site` that is neither `same-origin` nor `none`.

The visible cost is that a sign-in **must finish in the browser it started in**. Starting in
the app's in-app browser and finishing in Safari fails with `wrong_browser`, which says so and
says to press sign in again in the app.

Only `switchback://` is accepted in production. `exp://` and `http://localhost` are allowed
where `AUTH_MOBILE_ALLOW_DEV_SCHEMES=true` or `NODE_ENV !== 'production'`, which is what makes
Expo Go work at all.

The verifier is written to the Keychain before the browser opens, not held in component
state: iOS may reclaim the app while somebody is typing a password, and coming back to a deep
link holding a code we can no longer redeem would be a sign-in that fails for no visible
reason. `app/signin.tsx` therefore has two entry paths — the sheet returning, and a cold start
with `code`/`state` in its route params — and both end in the same claim.

Expired request rows are swept by `apps/web/app/api/cron/drain/route.ts`, alongside expired
refresh tokens.

### The native exchange never trusts an Entra email

`POST /api/auth/mobile/exchange` is the other way in: it takes a provider identity token
straight from a native sheet, verifies it against the provider's JWKS, and mints a pair. When
the `sub` is unknown but the email matches an existing account, it can either link the two or
refuse — and which it does is decided by `emailVerified` in `apps/web/src/auth-native.ts`.

For Entra that flag is now **always false**. Microsoft does not emit `email_verified`, and the
`email` claim it does emit is a tenant-mutable directory attribute that Microsoft's own
guidance says is unsuitable for identifying a user. We sign against `/common`, so the tenant is
whichever one the caller belongs to — including a free one created for the purpose. It used to
read `email !== null`, which was true whenever an email existed and made the 409
`email_taken_unverified` guard unreachable for the only provider production has enabled. That
is the nOAuth pattern, and the answer to it is that only Apple gets to assert a verified
address.

The email-linking branch itself is still there and deliberately so: an account reached through
it would, on removal, stop resolving, and its owner's next sign-in would silently create a
fresh empty account. `scripts/report-email-linked-accounts.ts` counts who that is —

```
npx tsx --env-file-if-exists=.env scripts/report-email-linked-accounts.ts
```

Run against production on 2026-07-30 it reported **zero**: no account there has ever been
created by the native exchange route, so nothing is relying on the branch. Removing it is a
follow-up, and re-running the script is the check that gates it.

---

## Native code

There is no `ios/` directory and it is gitignored. Expo's Continuous Native Generation builds
it from `app.config.ts` on demand, so a committed copy is a second source of truth that
silently wins over the config that generated it.

Everything that would normally be hand-edited in Xcode lives in `app.config.ts` instead —
bundle identifier, and the `NSLocation*` / `NSMotion` permission strings iOS shows verbatim in
its dialogs. Those strings are written now rather than at Phase 4, so the prompt a user reads
is never the placeholder text an Expo template ships with.

`newArchEnabled` is absent because RN 0.86 removed the old architecture entirely and SDK 57
dropped the flag along with it. Setting it is now a type error.

---

## Checks

```bash
npm run typecheck                      # includes the mobile workspace
npx expo-doctor                        # from apps/mobile
npx expo export --platform ios         # the real proof: it either bundles or it does not
```

`expo export` is the one worth running before claiming anything works. Typecheck passes on
plenty of code Metro cannot resolve.

One known false alarm: `expo-doctor` reports "Check that packages match versions required by
installed Expo SDK" as failed while printing `{"dependencies":[],"upToDate":true}` — an empty
list of problems. `npx expo install --check` is the authoritative answer to the same question
and exits 0. Treat that one line as noise; treat any _named_ package in it as real.
