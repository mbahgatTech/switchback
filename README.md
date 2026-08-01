# Switchback

Trail discovery, planning and navigation: a Next.js website that is also a PWA, an Expo/React
Native iOS app, and one tRPC API both consume. Its single job is to say what a trail will be like
**at the hour you will be standing there** — Tobler's hiking function over the real elevation
profile gives an arrival time at each point along the route, and each point's forecast is read at
_its own_ arrival hour rather than the trailhead's.

![Switchback's explore map on the dark surface: an index rail listing four trails with distance,
ascent, walking time and difficulty, beside a shaded-relief map of the Vesper Peak area with the
trail drawn as a pale green line.](docs/screenshots/product/explore-1400.png)

There is no seeded trail corpus and no region to pick. OpenStreetMap is read on demand, tile by
tile, as people look at places: a viewport is covered with z9 quadkeys, whatever Postgres already
holds returns immediately, and the rest is queued. Progress is **polled, not streamed** — the
client re-asks `browse` every 2.5 s while tiles are pending.

## Quick start

Node 22 or 24, and Docker for the local database. `.npmrc` sets `engine-strict=true`, so a Node
below the floor fails the install with a readable message instead of crashing Metro three commands
later.

```bash
npm install
cp .env.example .env   # DATABASE_URL and AUTH_SECRET are the only two required
npm run db:up          # Postgres 17 + PostGIS 3.5 on :5433
npm run db:push        # schema, then packages/db/prisma/spatial.sql
npm run db:seed
npm run dev            # web on http://localhost:3000
npm run mobile         # Expo — scan the QR with Expo Go
```

`AUTH_SECRET` needs 32+ characters; `openssl rand -base64 32` will do. Everything after those two
degrades rather than fails. Without `AUTH_MICROSOFT_ENTRA_ID_*` sign-in is unavailable and
everything readable stays readable; without `R2_*` photo uploads go to local disk (set **all five
or none** — `env.ts` rejects a half-configured bucket); without `NEXT_PUBLIC_PMTILES_URL` the
basemap falls through to keyless OpenFreeMap; without `MAPILLARY_TOKEN` photo enrichment uses
Wikimedia Commons alone. `scripts/setup-entra.ps1` registers the Entra app and writes the
credentials into `.env` without echoing the secret.

## Workspaces

npm workspaces, all source-only — no build step and no `dist/`. TypeScript project references
resolve the packages directly, so a one-line change in `packages/core` is visible to both apps
without a rebuild.

| Path                | What it is                                                                     |
| ------------------- | ------------------------------------------------------------------------------ |
| `apps/web`          | Next.js 16 App Router — the website, the PWA, and the API the router mounts on |
| `apps/mobile`       | Expo SDK 57 / React Native — iOS, a pure client of that same API               |
| `packages/core`     | Domain types, zod schemas, difficulty and unit formulas, the WebView protocol  |
| `packages/api`      | tRPC routers, moderation, mobile token exchange, R2 signing                    |
| `packages/db`       | Prisma schema, plus the PostGIS SQL Prisma cannot express                      |
| `packages/geo`      | Quadkeys, terrarium decode, profile, Tobler, corridors, GPX/FIT, routing graph |
| `packages/ingest`   | Overpass client, the tile pipeline, the job queue and its admission control    |
| `packages/weather`  | Open-Meteo adapter and along-route time-shifted sampling                       |
| `packages/busyness` | Forecast model and a pluggable provider                                        |
| `packages/ui`       | One token source that Tailwind v4 and React Native StyleSheet both read        |
| `infra`             | docker-compose for local Postgres + PostGIS; `infra/azure` is production Bicep |

The routers live in `packages/api` and are mounted at `apps/web/app/api/trpc/[trpc]/route.ts`. The
iOS app imports the same router _type_, so changing a procedure type-checks against both clients
at once — which is the whole reason it is Expo rather than SwiftUI.

## Gates

```bash
npm run typecheck    # tsc across root, e2e, web and mobile
npm run lint         # eslint --max-warnings=0
npm test             # vitest
npm run format:check # prettier --check .
```

`.github/workflows/ci.yml` runs all four on every push and every pull request, and `master` only
deploys behind them. **The browser suite is not part of that tick.** `npm run test:e2e` — Playwright
against a real browser, including axe WCAG 2.1 A/AA audits — runs nightly and on demand only, so a
green PR does not mean Playwright passed. Filling an ingest tile means querying a public Overpass
instance, and doing that on every push is how a project gets blocked. Run it locally, where the
tile is already there.

`npm test` prints a Prisma error mid-run: `packages/db/test/spatial.test.ts` deliberately asserts
that `rating: 6` violates the `reviews_rating_range` constraint. The run is green.

## Data and attribution

| Layer                       | Source                            | Terms                                  |
| --------------------------- | --------------------------------- | -------------------------------------- |
| Trail geometry, names, tags | OpenStreetMap via Overpass        | **ODbL — attribution and share-alike** |
| Elevation                   | AWS Terrain Tiles (terrarium PNG) | Public domain / CC-BY per tile source  |
| Weather, air quality        | Open-Meteo                        | CC-BY, free tier is non-commercial     |
| Base map                    | Protomaps PMTiles, self-hosted    | Open                                   |
| Satellite                   | Esri World Imagery                | Free with attribution                  |
| Photographs (seed)          | Wikimedia Commons, Mapillary      | CC variants — licence stored per photo |
| Busy times                  | Our model over our own activity   | Ours, labelled **Estimated**           |

**OpenStreetMap is ODbL: crediting it is a licence obligation, not a courtesy, and a derived
database carries share-alike.** The credit is built into the map chrome and the `/attribution`
page, and `e2e/trail.spec.ts` fails the build if it disappears.

Busy times are modelled, never measured — no API sells this — and the UI says which it is showing.

## Where to read next

- [docs/architecture.md](docs/architecture.md) — the system in diagrams: lazy ingest, along-trail
  weather, offline, auth, and the design decisions recorded once.
- [docs/design.md](docs/design.md) — the five-plate USGS palette, the rules that follow from it,
  and what every screen looks like.
- [docs/mobile.md](docs/mobile.md) — the iOS app, and why its map is a WebView.
- [docs/auth-apple.md](docs/auth-apple.md) — Sign in with Apple: implemented end to end, dark
  behind `AUTH_APPLE_ENABLED=false` until there is an Apple Developer account.
- [infra/azure/README.md](infra/azure/README.md) — the production Postgres, provisioned from Bicep.
