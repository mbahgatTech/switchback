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

A fourth rule lives one layer up, in `src/api/identity.ts`: **every announced change of identity
empties the query cache.** React Query keys an entry by procedure and input and never by who
asked, so a sign-out followed by a sign-in — the ordinary way to correct a wrong account — would
otherwise serve the new reader the previous one's profile, lists and stats for a whole
`staleTime`.

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

## Recording with the screen off

A hike is recorded by a CoreLocation task the OS owns, not by anything the app schedules.
`Location.watchPositionAsync` is a foreground subscription: iOS suspends the JavaScript runtime
when the screen locks, and a track recorded that way is a straight line between the two moments
somebody looked at their phone. `src/record/background.ts` registers a `TaskManager` task
instead, at module load rather than in a component, because iOS relaunches a terminated app
_headless_ to hand it a position and a task defined in a `useEffect` does not exist yet at that
moment.

The capability is a build-time declaration, not a runtime request. `app.config.ts` enables
`isIosBackgroundLocationEnabled` on the `expo-location` plugin, which is what puts `location`
into `UIBackgroundModes`. Without that key `startLocationUpdatesAsync` throws
`LocationUpdatesUnavailable` — and that throw is exactly how the app tells the two hosts apart.
There is no `Constants` check anywhere, because there is nothing to check: a development build
and Expo Go report the same execution environment, and only the `Info.plist` differs.

| Host                               | What it does                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Expo Go**                        | No `location` background mode, so the task cannot register. The app falls back to `watchPositionAsync`, holds the screen awake, and the Record screen says the track pauses when the phone locks. |
| **Development build / TestFlight** | The task registers. Recording continues with the screen off and the app behind others.                                                                                                            |

Two permissions, doing different jobs:

- **When In Use** is the one recording requires. With the background mode declared, it is enough
  to keep the track running with the screen off, and iOS shows the location indicator while it
  does — `showsBackgroundLocationIndicator` is set deliberately.
- **Always** buys one further thing: iOS may relaunch the app after terminating it under memory
  pressure and carry on feeding the recording. Refusing it is not a broken hike, so the app never
  treats it as an error. It reports it — `mayNotSurviveTermination` on the recorder snapshot, and
  a line on the Record screen naming the setting to change.

`pausesUpdatesAutomatically` is set to `false`. `expo-location` defaults it to **true**
(`ios/TaskConsumers/EXLocationTaskConsumer.m`), which lets CoreLocation stop updates when it
decides the user has stopped moving — and with no `activityType` to judge by, it may not start
them again. `activityType: Fitness` is set alongside it.

Continuous GPS is the heaviest thing a phone does; a long day out wants a battery pack, and the
Record screen says so before anybody sets off. The journal is the other half of that cost, which
is why it appends rather than rewrites: `Documents/recording-v2/` holds a small `head.json` and an
append-only `fixes.ndjson`, so a fix costs one line instead of re-serialising six hours of track
once a second. A kill mid-write leaves a half-line, which `src/record/journal.ts` drops — the
recording loses the last second, not the hike.

Nothing leaves the phone that did not already: the same `activities.append` batch, on the same
minute tick. Background location changes when fixes are collected, not where they go.

A restored recording comes back **paused** unless the OS still holds the task, which is the only
evidence that distinguishes an app iOS relaunched — where the hike genuinely never stopped — from
a crash or a force-quit, where the track has a hole in it and only the user can say whether to
carry on.

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
