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
The probe is the attempt rather than a `Constants` check, because there is nothing there to
check: a development build and Expo Go report the same execution environment, and only the
`Info.plist` differs. (`src/config.ts` does read `Constants.expoGoConfig`, for the Metro host the
API origin is derived from — a different question with a different answer.)

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
once a second. The head is written to a staging name and renamed into place — `expo-file-system`'s
string write is not atomic, and a head cut in half by a kill is a hike thrown away. A torn
`fixes.ndjson` tail is dropped by `src/record/journal.ts` and the file repaired at restore, so the
recording loses the last second, not the hike.

Running totals are folded one leg at a time (`advanceTrackStats` in `packages/geo`), not
recomputed. `summariseTrack` walks the whole buffer, which is right for a finished recording and
quadratic for a live one — at 1 Hz for eight hours it is roughly 575× the work it was when a
recording could only run while the screen was on. `packages/geo/test/track-stats.test.ts` pins the
fold to the full pass, because a recorder showing one distance while the server returns another
would be worse than a slow one.

### What the recording writes down, and how long it stays

A journal is a per-second location history. Three rules follow, and each is enforced in
`src/record/store.ts` rather than left to habit:

- **It is keyed to the person who made it.** The head carries an `ownerId`, and a journal is
  restored only for that identity. A different confirmed identity erases it rather than being
  shown where somebody has been. Signing out seals it — nothing of it is presented and the OS
  subscription stops — but does not destroy it, because a refresh token expiring mid-hike is an
  ordinary event on a mountain and losing a hike to it would teach people not to sign out.
- **Nothing outlives its format.** `recording-v1.json`, written by builds before this, is deleted
  at launch rather than ignored.
- **Nothing outlives the hike by more than a day.** The directory is cleared on finish, on
  discard, and on an identity that does not own it — and a journal whose hike began more than
  48 hours ago is erased at the next launch, whether or not it was ever finished. That horizon is
  `trackFixSchema`'s own: `t` is capped at 48 hours, so past it no further fix could legally join
  the track and the journal is only a trace. A hike sealed by a sign-out is inside the same
  horizon, so it is kept for the person who made it and erased once it is stale, not held forever.

`Documents/` rather than `Caches/` because iOS empties Caches under storage pressure and this is
the one file a recording cannot lose — the cost is that a track rides into iCloud backups, which
is why the horizon above exists and is the only control standing between an all-day trace and a
backup. Backup exclusion is not reachable from this stack's file API, and is not claimed. At rest the file takes the app's default
protection class, unlocked after first authentication: `NSFileProtectionComplete` would make the
writes fail while the phone is locked in a pocket, which is exactly when they matter.

**The Lifeline now transmits from a locked phone.** `UIBackgroundModes: location` stops iOS
suspending the JavaScript runtime during a recording, and the Lifeline's ping loop is a timer in
that same runtime — so a Lifeline running alongside a hike keeps sending position to its publicly
shareable link with the screen off, where before it went quiet. That is a change in egress, not
just in scheduling, and whether it should be bounded back to the foreground is an open decision;
`src/record/lifeline.ts` records it at the loop. Recording's own uploads are unchanged: the same
`activities.append` batch, on the same minute tick.

A restored recording comes back **paused** unless the OS still holds the task, which is the only
evidence that distinguishes an app iOS relaunched — where the hike genuinely never stopped — from
a crash or a force-quit, where the track has a hole in it and only the user can say whether to
carry on. The reverse is reconciled too: a task still registered for a hike nobody is recording is
stopped, rather than left running `BestForNavigation` GPS for readings nothing will read.

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
