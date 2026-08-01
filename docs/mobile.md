# The iOS app

`apps/mobile` is an Expo (React Native) app, iOS only. It is a pure client: every screen it
draws comes from the tRPC API served by `apps/web`, so the website has to be running for the
app to do anything. The "web version" of Switchback is that Next.js site, not React Native
compiled to DOM — there is no `react-native-web` and no `android/`.

## The map is a web page

Everything in the app is native React Native **except the map**.
`apps/mobile/src/components/explore-map.tsx` is a `react-native-webview` loading `/embed/map`
from our own server, and inside that page is MapLibre GL JS — the same `buildStyle` and the
same trail layers the website draws. `packages/core/src/map-bridge.ts` is the typed message
protocol between the two halves, validated on receipt at both ends because the app bundle and
the page deploy separately.

The native binding (`@maplibre/maplibre-react-native`) would need a development build, which
needs a Mac, and would have meant a second copy of the cartography in a second language kept in
step by hand. This is the single most surprising thing about the mobile codebase; read
`map-bridge.ts` before changing anything on either side of it.

The page owns the viewport and runs `trails.browse` for itself. Geometry never crosses the
bridge.

## Why Expo and not SwiftUI

Web and mobile share `packages/*` — the domain code, the zod schemas, the design tokens — and
consume the same tRPC router _type_. Change a procedure and both clients fail to compile
against it in the same second. That shared type is the whole payoff.

## Running it

Node 22 LTS or 24 (`engine-strict=true`, so a mismatch fails the install rather than Metro).
You need the Expo Go app on an iPhone on the same Wi-Fi as this machine; no Xcode and no Mac.

```bash
npm run db:up      # Postgres 17 + PostGIS on :5433
npm run dev        # the API and website on :3000 — required, the app is a client
npm run mobile     # Metro; scan the QR code with the iPhone camera
```

You never type an IP address. A phone cannot reach `localhost`, so `src/config.ts` derives the
API origin from the host Metro served the bundle from — the same machine running the website.
`EXPO_PUBLIC_API_URL` overrides that and exists for release bundles, where there is no Metro
host; leave it unset in development.

`EXPO_PUBLIC_*` and `NEXT_PUBLIC_*` values are inlined into the shipped bundle at build time
and are readable by anyone holding the app. Public by definition — never put a secret behind
either prefix.

## What the app cannot import

`apps/mobile/tsconfig.json` maps `@switchback/core` and exactly one thing from
`@switchback/api`: `import type { AppRouter }`. `@switchback/db` and the _value_ exports of
`@switchback/api` have no path entry, which is the enforcement — both reach Prisma and
`node:crypto`, neither of which exists in Hermes, so an accidental value import is a compile
error here instead of a red screen on the phone.

## Sessions and sign-in

The server issues a 15-minute HS256 access JWT and a 60-day opaque refresh token
(`packages/api/src/tokens.ts`). The refresh token lives in the iOS Keychain through
`expo-secure-store` with `WHEN_UNLOCKED_THIS_DEVICE_ONLY`, so it cannot ride an encrypted
backup onto a second device and trip reuse detection.

Three rules in `src/auth/session.ts` are correctness, not polish:

- One in-flight refresh promise, shared. Refresh tokens rotate on use, so three queries
  presenting the same token would look like a stolen token and sign the user out everywhere.
- A network failure during refresh **keeps** the stored token. Offline is normal for this
  product.
- Only an HTTP 401 clears it, because only the server can say a token is dead.

Sign-in does not talk to the provider directly. The app opens the _website's_ sign-in in a
system browser, the server completes OIDC against its own registered `https://` redirect URI,
and the browser deep-links back with a one-time code that is worthless without the verifier the
device kept — PKCE applied to our own leg. Expo Go's `exp://` host changes with the network and
no provider will register it, which is why the handshake exists at all; it keeps working
unchanged after Apple enrolment.

| Piece                                            | Where                                                          |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Handshake rules, single-use, redirect allow-list | `packages/api/src/mobile-auth.ts`                              |
| The three endpoints                              | `apps/web/app/api/auth/mobile/{start,complete,claim}/route.ts` |
| Device half — verifier, browser sheet, claim     | `apps/mobile/src/auth/handshake.ts`                            |
| The screen                                       | `apps/mobile/app/signin.tsx`                                   |

Two consequences a maintainer meets: a sign-in **must finish in the browser it started in**
(otherwise `wrong_browser`), and only `switchback://` is accepted in production —
`exp://` and `http://localhost` need `AUTH_MOBILE_ALLOW_DEV_SCHEMES=true` or a non-production
`NODE_ENV`.

`POST /api/auth/mobile/exchange` is the other way in, taking a provider identity token straight
from a native sheet. It never treats an Entra `email` claim as verified — Microsoft does not
emit `email_verified` and the address is a tenant-mutable directory attribute, so only Apple
gets to assert one. See `apps/web/src/auth-native.ts` and `docs/auth-apple.md`.

## Native project files

There is no `ios/` directory and it is gitignored. Expo's Continuous Native Generation builds
it from `app.config.ts`, so a committed copy would be a second source of truth that silently
wins. Everything normally hand-edited in Xcode — bundle identifier, the `NSLocation*` and
`NSMotion` permission strings iOS shows verbatim — lives in `app.config.ts` instead.

## Verifying a change

**There is no iOS simulator on this machine — it runs Windows.** Mobile changes are verified by
`npm run typecheck`, `npm run lint`, and the mobile conventions gate in
`apps/mobile/test/conventions.test.ts` (part of `npm run test`), plus whatever you can see in
Expo Go on a real phone. On a Mac, `npx expo export --platform ios` is the honest proof that
something bundles; typecheck passes on plenty of code Metro cannot resolve.

`npx expo-doctor` reports "Check that packages match versions required by installed Expo SDK"
as failed while printing an empty problem list. `npx expo install --check` answers the same
question and exits 0; treat any _named_ package as real and that bare line as noise.

## Gated on an Apple Developer account

**There is no Apple Developer account** ($99/yr). Sign in with Apple is implemented and sits
behind `AUTH_APPLE_ENABLED=false` — see `docs/auth-apple.md`. TestFlight, the App Store, and any
development build for a physical device all need the enrolment. Microsoft Entra ID is live and
fully testable in the meantime, in Expo Go.
