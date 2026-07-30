# Switchback

Trail discovery, planning, and navigation. A website and an iOS app, sharing one API and one
design system.

The product's single job: tell you what a trail will be like **at the hour you will be
standing there**. Every other trail app forecasts the trailhead. This one walks the route —
Tobler's hiking function over the real elevation profile gives an ETA at each sample point,
and each point's forecast is read at _its own_ arrival hour.

> Trailhead 07:00 · 11 °C, calm → Ridge 09:40 · 6 °C, gusts 38 km/h → **Summit 11:20 · 1 °C,
> gusts 61 km/h, 30 % precip** → back at the car 14:05 · 9 °C

---

## Run it

Node ≥ 22.13 (the floor is React Native 0.86's; `.npmrc` sets `engine-strict=true`, so a
mismatch fails the install with a readable message instead of crashing Metro three commands
later). Docker for the local database.

```bash
npm install
cp .env.example .env            # fill in DATABASE_URL and AUTH_SECRET; the rest is optional
npm run db:up                   # Postgres 17 + PostGIS 3.5 on :5433
npm run db:push                 # schema, then packages/db/prisma/spatial.sql
npm run db:seed
npm run dev                     # web on :3000
npm run mobile                  # Expo — scan the QR with Expo Go
```

`AUTH_SECRET` needs 32+ characters; `openssl rand -base64 32` will do. Everything after
those two variables degrades gracefully rather than failing:

| Unset                       | What happens                                                                                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AUTH_MICROSOFT_ENTRA_ID_*` | Sign-in is unavailable; everything readable stays readable. Required in production — `env.ts` refuses to boot without it.                                                                                                      |
| `R2_*`                      | Photo uploads go to local disk via a filesystem driver. **All five or none** — a half-configured bucket silently writes user photographs into a serverless container that is discarded minutes later.                          |
| `NEXT_PUBLIC_PMTILES_URL`   | Falls through to keyless OpenFreeMap. The `.env.example` placeholder is rejected as firmly as an empty string.                                                                                                                 |
| `MAPILLARY_TOKEN`           | Photo enrichment uses Wikimedia Commons alone.                                                                                                                                                                                 |
| `DATABASE_SIZE_LIMIT_BYTES` | The ingest storage guard is off and only the queue-depth ceiling applies. Set it to the storage quota of the plan the database is on — nothing can measure that, so an unset guard fails open on purpose rather than guessing. |
| `AUTH_APPLE_ENABLED`        | Off. See [gated on an Apple account](#gated-on-an-apple-developer-account).                                                                                                                                                    |

`scripts/setup-entra.ps1` registers the Entra app and writes the credentials straight into
`.env` without echoing the secret.

---

## Architecture

```
apps/web        Next.js 16 App Router — website, PWA, and the API
apps/mobile     Expo / React Native — iOS
packages/core   domain types, zod schemas, difficulty and pace formulas
packages/api    tRPC routers — consumed by both clients, end-to-end typed
packages/db     Prisma schema, PostGIS
packages/geo    GPX/GeoJSON, elevation profile, terrarium decode, Tobler, off-route, quadkeys
packages/ingest Overpass client, route assembly, enrichment
packages/weather Open-Meteo adapter, along-route time-shifted sampling
packages/busyness forecast model + pluggable provider
packages/ui     design tokens — Tailwind v4 and React Native StyleSheet read the same source
infra           docker-compose for local Postgres + PostGIS
```

**One API, two clients.** The routers live in `packages/api` and are mounted at
`apps/web/app/api/trpc/[trpc]/route.ts`. The Expo app imports the same router _type_, so
changing a procedure type-checks against both clients immediately. That is the whole reason
the iOS app is Expo rather than SwiftUI.

The packages are source-only — no build step, no `dist/`. TypeScript project references
resolve them directly, which is what keeps a one-line change in `packages/core` from needing
a rebuild before either app sees it.

### Trail data arrives on demand

There is no seeded corpus and no region to pick. A viewport is covered with z9 quadkeys;
tiles already in Postgres and fresher than 30 days serve instantly, and missing tiles are
queued and streamed in over SSE as they land.

```
viewport ──► z9 quadkeys ──┬── READY & fresh ──► Postgres, instantly
                           └── missing/stale ──► partial results now + { pending: [...] }
                                                 waitUntil(processTile) + SSE
```

`processTile` is six idempotent steps: Overpass query → assemble relation members into
ordered LineStrings → resample every 25 m and decode terrarium PNGs at z13 → derive length,
gain/loss, grade histogram, route type, difficulty and Tobler time → enrich with Commons and
Mapillary photographs and nearby parking → commit.

**Overpass etiquette is a correctness requirement, not politeness** — public instances block
abusive clients and would take this product down with them. The client enforces a descriptive
`User-Agent` with a contact URL (a placeholder address is refused at construction), a
serialized queue at two concurrent, jittered exponential backoff that honours `Retry-After`,
mirror failover, and a circuit breaker that fails soft to cached data. `overpass.test.ts`
asserts every one of those.

Durability is a two-part answer: `waitUntil` kicks the job immediately for latency, and a
Vercel Cron drains the `IngestJob` table to catch whatever a deploy or a timeout drops.
That cron is scheduled daily rather than minutely, because Vercel's Hobby plan fails the
_deployment_ on any expression that would run more often — one field in
`apps/web/vercel.json` gets the minute-hand back on Pro, and any external scheduler pointed
at the same URL with the same bearer token gets it back for free.

**The ingest holds its own connection pool**, so each server process opens two. Sharing one
was survivable until three code paths could start drains at once — two `waitUntil` kicks and
the cron, each guarded against starting a second of its own kind and none aware of the
others — at which point background commits took every connection and the query that lost was
Auth.js's session lookup. The symptom was not a slow ingest; it was a signed-out header and
an empty map. `packages/db/src/client.ts` sizes both pools and says why.

---

## Data sources

| Layer                                    | Source                            | Terms                                     |
| ---------------------------------------- | --------------------------------- | ----------------------------------------- |
| Trail geometry, names, tags              | OpenStreetMap via Overpass        | **ODbL — attribution and share-alike**    |
| Elevation                                | AWS Terrain Tiles (terrarium PNG) | Public domain / CC-BY per tile source     |
| Weather, air quality                     | Open-Meteo                        | CC-BY, 10k calls/day free, non-commercial |
| Base map                                 | Protomaps PMTiles, self-hosted    | Open                                      |
| Satellite                                | Esri World Imagery                | Free with attribution                     |
| Photographs (seed)                       | Wikimedia Commons, Mapillary      | CC variants — license stored per photo    |
| Photographs, reviews, conditions, tracks | Our users                         | Ours                                      |
| Busy times                               | Our model + our activity data     | Ours, labelled **Estimated**              |

OSM is ODbL: attribution is required and a derived database carries share-alike. It is baked
into the map chrome and the `/attribution` page rather than bolted on, and
`trail.spec.ts` fails the build if the credit disappears.

**Busy times are modelled, not measured.** No API sells this — Google Places (New) exposes no
`popularTimes` field in any SKU. A parametric weekly prior per trail archetype is pulled
toward reality by an EWMA over start times from activities our own users record, and the UI
says which it is showing ("modeled" → "based on 240 visits").

---

## Testing

```bash
npm run format:check            # prettier --check .
npm run typecheck               # tsc across root, e2e, web, mobile
npm run lint                    # eslint --max-warnings=0
npm test                        # vitest — 1295 unit tests
npm run test:e2e                # playwright, incl. 15 axe WCAG 2.1 A/AA audits
```

`.github/workflows/ci.yml` runs the first four on every push and pull request. The browser
suite runs nightly and on demand instead, because filling an ingest tile means querying a
public Overpass instance and doing that on every push is how a project gets blocked.

`npm test` prints a Prisma error mid-run. That is `packages/db/test/spatial.test.ts`
deliberately asserting that `rating: 6` violates the `reviews_rating_range` constraint — the
run is green.

The unit tests cover the things that are wrong in ways nobody notices: terrarium decode
against known survey elevations, gain/loss on a synthetic profile, Tobler pace against
published tables, off-route distance, quadkey cover, route-type classification, difficulty
boundaries, and every colour token's contrast ratio against every surface it is permitted on.

The Playwright suite walks the real product — search, trail detail, the weather strip, filing
a report, downloading a trail, cutting the network, and confirming the trail still opens. It
starts with a `warm` project that requests every page once, so the dev server's first-request
compile is paid before any assertion's clock is running rather than inside whichever spec
happened to ask for a page first.

---

## Design

`docs/design.md` has the direction. The short version: a USGS quadrangle is printed from five
colour separations and every hiker who reads maps already knows the code, so we borrow the
separation and give each plate exactly one job. Contour is elevation, water is weather,
woodland is the trail, **survey — red — is you and your safety and nothing else**, and culture
is structure. Colour is a legend here, not decoration.

`packages/ui/test/tokens.test.ts` asserts the contrast ratios, so an ink cannot be nudged
without the measurement being re-made.

---

## Gated on an Apple Developer account

Sign in with Apple is implemented end to end — Services ID, the `.p8` → `client_secret` JWT
generator, rotation script, and the native `expo-apple-authentication` path — and sits behind
`AUTH_APPLE_ENABLED=false`. Setup is written up in `docs/auth-apple.md`; flip the flag on
enrolment day. Until then Microsoft Entra ID is live and fully testable, and iOS runs in Expo
Go and the simulator. TestFlight needs the $99/yr membership.

Two other things are deliberately absent. **National Geographic maps** are licensed content
and cannot be cloned. **Apple Watch** needs a native watchOS target, which Expo does not
build; GPX and FIT export ship instead, so a Garmin works today.
