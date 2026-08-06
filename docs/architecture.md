# Architecture

Switchback is trail discovery, planning and navigation: a Next.js website that is also a PWA, an
Expo/React Native iOS app, and one tRPC API both consume. There is no seeded trail corpus —
OpenStreetMap is read on demand, tile by tile, as people look at places. See also
[design.md](design.md), [mobile.md](mobile.md) and [auth-apple.md](auth-apple.md).

## System context

```mermaid
flowchart LR
  subgraph clients [Clients]
    web["Next.js 16 App Router<br/>website + PWA + service worker"]
    ios["Expo SDK 57 / RN<br/>iOS"]
  end
  subgraph deploy ["One Vercel deployment"]
    api["tRPC router + ingest + weather<br/>packages/api"]
  end
  subgraph state ["State we own"]
    pg[("Postgres + PostGIS<br/>Azure Flexible Server")]
    r2[("Cloudflare R2<br/>user photographs")]
  end
  subgraph ext ["External sources"]
    osm["OpenStreetMap<br/>via Overpass"]
    dem["AWS Terrain Tiles<br/>terrarium PNG"]
    om["Open-Meteo<br/>forecast + air quality"]
    base["Protomaps / OpenFreeMap / Esri<br/>basemap tiles"]
    pics["Wikimedia Commons<br/>Mapillary"]
  end

  web --> api
  ios --> api
  ios -. "map only: WebView on /embed/map" .-> web
  api --> pg
  api --> r2
  api --> om
  api --> osm
  api --> dem
  api --> pics
  web --> base
  web --> dem
```

![The explore map](screenshots/product/explore-1400.png)

`packages/` holds the shared reasoning: `core` (types, zod schemas, difficulty and unit formulas,
the WebView protocol), `api` (tRPC routers, moderation, mobile token exchange, R2 signing), `db`
(Prisma schema — raw SQL confined to `spatial.ts`, the only file touching PostGIS columns), `geo`
(quadkeys, terrarium, Tobler, corridors, GPX/FIT, routing graph), `ingest` (Overpass, the tile
pipeline, the job queue and its admission control), `weather`, `busyness`, `ui` (one token source
for Tailwind and React Native). All source-only: no build step, no `dist/`.

## Lazy ingest: viewport to trails

The heart of the product. A viewport is covered with z9 quadkeys; tiles already in Postgres and
fresher than 30 days serve immediately, and the rest are queued while the request returns what we hold.

```mermaid
sequenceDiagram
  participant C as Client map
  participant B as trails.browse
  participant V as ensureCoverage
  participant DB as Postgres
  participant P as processTile
  participant O as Overpass

  C->>B: bbox
  B->>V: cover with z9 quadkeys (12 max per request)
  V->>DB: read ingest_tiles, upsert missing + deduped ingest_jobs
  V-->>B: ready / refreshing / pending / queued
  B->>DB: trails whose bbox overlaps the viewport
  B-->>C: partial results now + the pending quadkeys
  B->>P: waitUntil(drainIngest) — same handler the cron runs
  P->>O: one tile query, plus one tile-wide waypoint query
  O-->>P: ways and relations
  P->>DB: one transaction per trail, then tile status
  C->>B: re-ask every 2.5 s while anything is pending
```

Inside `processTile`, per tile:

```mermaid
flowchart LR
  A["Overpass<br/>tile query"] --> B["assemble<br/>members into ordered lines"]
  B --> C["elevate<br/>resample 25 m, terrarium z13"]
  C --> D["derive<br/>length, gain, grade, route type,<br/>difficulty, Tobler time"]
  D --> E["commit<br/>one transaction per trail"]
  E --> F["enqueue: enrich_trail for photographs,<br/>ingest_route for any parent superroute"]
```

Three properties make this safe to run unattended. Every trail is keyed by `(osmType, osmId)` and
every write is an upsert, so an at-least-once queue is harmless. Each trail commits in its own
transaction and its own `try`, so one broken geometry costs one row rather than forty. And a tile
reaches `ready` only when Overpass answered — a failed tile keeps its reason, so the next request
re-queues instead of serving an empty map as though the ground held no trails.

**Durability.** `waitUntil` buys latency and nothing else; a deploy or timeout mid-flight loses the
work. So every kick also writes an `IngestJob` row that a Vercel Cron drains, and both paths run the
same idempotent handler. Claims are a visibility timeout, never a transaction held open for minutes,
which would exhaust a serverless pool. Admission control (`ingest/backpressure.ts`) is asked inside
`queueTiles` — the choke point every writing path crosses — rather than at the one button that has a
person behind it.

**Progress is polled, not streamed.** The client re-asks `browse` every 2.5 s while tiles are
outstanding. An SSE stream was the plan; with a twelve-tile cap it would cost a long-lived connection
and a held-open function per open map to carry a few messages. Revisit past hundreds of tiles.

**Long-distance routes bypass tiles.** A bbox query never recurses into member relations, so no tile
can see the Pacific Crest Trail itself — only its sections, each committed under its own name and
length. `processRoute` walks the `type=superroute` hierarchy by id, flattens it in declared order and
hands the members to the same assembler.

## Along-trail weather

A trailhead forecast describes the warmest, most sheltered point of the hike at an hour you are not
there. This samples the route and asks about each point at its own predicted arrival hour.

```mermaid
sequenceDiagram
  participant T as Trail page
  participant W as alongRouteForecast
  participant G as geo
  participant M as Open-Meteo

  T->>W: profile, route type, length, start, pace
  W->>G: hikedProfile — mirror the return leg if there is one
  G-->>W: the journey as actually walked
  W->>W: planSamples — 8 points by cumulative distance,<br/>with start, finish and high point pinned
  W->>M: ONE request: comma-separated lat, lng and OUR DEM elevations
  M-->>W: hourly series per location, unixtime, + utc_offset
  W->>G: cumulativeTimeS — Tobler, pace and terrain factors
  G-->>W: arrival second per sample, each read at its own hour
  W-->>T: the strip, plus flags (dark, freezing, gusts, AQI)
```

![A trail, its section, and the weather along it](screenshots/product/trail-1400.png)

Three details carry the feature. Elevation is **sent**, not inferred — left alone Open-Meteo uses the
model cell's average, which over mountains can sit hundreds of metres below the summit; our own DEM
figure triggers its downscaling, and that is the difference between 8 °C and 1 °C. Timestamps come
back as `unixtime`, so matching an arrival to a forecast hour is integer comparison, not string
parsing across a DST boundary. And the plan is computed twice against the same pure function — once
to learn _where_ to ask, then again once the response has given us the trail's UTC offset and so what
"the next 07:00 local" means. No second call.

## Offline

Downloads are per trail and always user-initiated. The web unit of download is a **page**, not a data
blob — a trail page is server-rendered end to end, so keeping the HTML, the chunks it names, a
corridor of tiles and the photographs makes the offline page byte-for-byte the one you downloaded.

```mermaid
flowchart TB
  btn["Download on a trail page"]
  btn --> cch["sb-pages-v1 the rendered HTML · sb-assets-v1 the /_next/static it names<br/>sb-tiles-v1 corridor along the route z10-15 · sb-media-v1 photographs"]
  btn --> led[("IndexedDB ledger<br/>what is held, and how big")]
  cch --> swx["No signal: sw.js serves anything<br/>the app deliberately stored"]
  wrt["Report written / hike recorded offline"] --> q[("IndexedDB queue<br/>stamped with the writing reader")]
  q -->|"online, visibilitychange, or reader resolved"| fl["sync.tsx drains only the rows<br/>owned by the reader here NOW"]
  fl --> api["tRPC"]
```

![Managing downloads](screenshots/product/downloads-390.png)

The service worker owns no URL patterns and does not know what a tile is: the app decides what is
worth keeping and writes it into a named cache, and the worker's whole rule is "if it is in one of
our caches, serve it". Caches are versioned by name rather than cleared on upgrade, and split
deliberately — four carry a hand-bumped `-v1` because their contents belong to the reader and a
deploy must not throw away a download made for a trip somebody is on; only `sb-shell-<build id>` is
build-scoped. `apps/web/test/offline-caches.test.ts` fails the build if the worker's copy of any of
these strings drifts from `src/offline/caches.ts`.

On iOS the same feature stores JSON payloads fetched with the procedures and arguments the screens
use, and `hydrate.ts` seeds them into the React Query cache under the same keys — never over live
data. The basemap is not included and the control says so: under Expo Go nothing can sit between the
map's WebView and its tile requests.

## The activity heatmap

Every public recording, aggregated onto a fixed lattice. Every control lives in the SQL rather than
the renderer, because k-anonymity applied client-side is k-anonymity an attacker declines by reading
the response. No row leaves with fewer than `HEATMAP_MIN_HIKERS` contributors, and no coordinate
leaves at all — only lattice indices.

```mermaid
flowchart LR
  A["tracks<br/>public, synced, overlapping the viewport"] --> B["trim<br/>ST_LineSubstring, 250 m off each end"]
  B --> C["clip<br/>to the viewport"]
  C --> D["densify<br/>ST_Segmentize, never finer than a cell"]
  D --> E["group<br/>count DISTINCT people per cell"]
  E --> F["keep<br/>3 hikers or more, busiest first"]
```

**Trimming runs before clipping, and the order is load-bearing.** `ST_LineSubstring` takes fractions
of a line, so trimming the visible part rather than the whole track would move the censored zone as
the reader pans, and uncensor a front door the moment it sits mid-screen. Clipping second is also
what bounds the work, making cost track screen area rather than track length.

`packages/core/src/heatmap.ts` carries the numbered list of controls beside the constants they
justify, and records what was turned down: differential privacy, because noise sufficient to defeat
snapshot-differencing invents traffic on ground nobody has hiked.

## Authentication

Seven trust relationships. Four are identity-based and carry no secret at all; three still pass a
stored password, and moving those is the work in progress. This section is the single picture,
because until it existed the story lived in a Bicep comment, a workflow, a Vercel setting and two
people's memory.

### Who trusts whom

Solid edges are identity-based: the caller proves who it is and Entra issues a short-lived token.
Dashed edges still carry a stored password. There are three of them, and one — `sbadmin` — holds
full DDL.

```mermaid
graph LR
  subgraph People
    OWNER[Owner<br/>Mazen, Entra user]
    READER[Signed-in reader]
  end
  subgraph Machines
    VERCEL[Vercel functions<br/>id-switchback-vercel-publisher]
    FUNC[Function App<br/>system-assigned identity]
    GHA[GitHub Actions<br/>ci.yml, backup-production-db.yml]
    CI[GitHub Actions<br/>id-switchback-postgres-ci]
    SP[Deploying service principal]
  end
  subgraph Azure
    SB[(Service Bus<br/>ingest-jobs)]
    PG[(Postgres<br/>switchback)]
    RG[Resource group<br/>rg-switchback-prod-northcentralus]
  end

  VERCEL -->|Data Sender| SB
  FUNC -->|Data Receiver| SB
  VERCEL -.->|sbapp password| PG
  FUNC -.->|sbapp password| PG
  GHA -.->|sbadmin password, full DDL<br/>secrets.DIRECT_DATABASE_URL| PG
  VERCEL -->|sbapp_vercel<br/>role created, not yet used| PG
  FUNC -->|sbapp_func<br/>role created, not yet used| PG
  CI -->|Entra administrator<br/>proven, not yet consumed| PG
  OWNER -->|Entra administrator| PG
  OWNER -->|Owner| RG
  SP -->|Contributor| RG
  READER -->|session cookie| VERCEL
```

Read the two GitHub Actions boxes together, because the difference between them is the whole
point of this work. `id-switchback-postgres-ci` is an identity that reaches the database with no
password and is a working Entra administrator — but **nothing consumes it yet**. The schema push
in `.github/workflows/ci.yml` and the dump in `.github/workflows/backup-production-db.yml` both
still authenticate with `secrets.DIRECT_DATABASE_URL`, which is `sbadmin` and can create and drop
anything. That is the largest remaining credential in the system and it is a repository secret, so
its blast radius is everyone with write access to this repository.

The two unused solid edges are drawn from the object ids on both ends rather than from the names,
because a role mapped to the wrong principal fails only at first use. `sbapp_func` carries
`3db30cfd-…`, which is `func-switchback-ingest-37ywppu5p7fri`'s system-assigned identity;
`sbapp_vercel` carries `c9bfba39-…`, which is `id-switchback-vercel-publisher`, the same identity
Service Bus already trusts.

Two things the diagram is meant to make obvious. The deploying service principal holds
Contributor and therefore cannot reach the database at all — it writes ARM, not rows. And the CI
identity holds **no Azure RBAC whatsoever**: its entire authority is the Postgres administrator
grant, so a leak of it cannot touch the resource group, the queue or the billing.

`disableLocalAuth: true` on the Service Bus namespace and zero queue SAS rules are what make the
two Service Bus edges solid rather than dashed. Postgres still has `passwordAuth: Enabled`
because the two dashed edges are real; see _What is left_ below.

### The federated exchange

No secret is stored at either end. Vercel mints an OIDC token per invocation, Entra checks the
issuer, subject and audience against a federated credential declared in Bicep, and hands back an
access token.

```mermaid
sequenceDiagram
  participant V as Vercel function
  participant E as Microsoft Entra ID
  participant A as Azure resource

  Note over V: x-vercel-oidc-token header,<br/>minted per request
  V->>E: POST /oauth2/v2.0/token<br/>client_assertion = OIDC token
  Note over E: issuer https://oidc.vercel.com/mbahgattechs-projects<br/>subject owner:mbahgattechs-projects:project:switchback:environment:production<br/>(and :environment:preview)<br/>audience https://vercel.com/mbahgattechs-projects
  E-->>V: access token for the requested scope
  V->>A: request with Bearer token
  A-->>V: response
```

The same shape serves GitHub Actions, with issuer `https://token.actions.githubusercontent.com`
and subject `repo:mbahgatTech@81331884/switchback@1316632119:ref:refs/heads/master`. That subject
is GitHub's **immutable** form — account id and repository id rather than their names. It is not a
preference: this repository's OIDC tokens carry that form, so a credential written the readable
way is never matched and the exchange fails with `AADSTS700213`, quoting a subject that appears in
no template.

### The database token lifecycle

An access token is the _password_ on a Postgres connection, and it is short-lived. The design
below is what the pool has to do so that nothing ever needs restarting.

```mermaid
sequenceDiagram
  participant P as pg.Pool
  participant T as Token cache
  participant E as Entra ID
  participant DB as Postgres

  P->>T: password() — called per new connection
  alt cached, with more than the renewal margin left
    T-->>P: cached token
  else inside the renewal margin, or expired
    T->>E: acquire for ossrdbms-aad.database.windows.net
    E-->>T: token, exp 60 min (user) or 24 h (managed identity)
    T-->>P: fresh token
  end
  P->>DB: connect, token as password
  DB-->>P: session established

  Note over P,DB: the token is checked at connect and never again —<br/>measured, run 31062754668: a session survived 19 min past expiry
  P->>P: retired at maxLifetimeSeconds, on release
  P->>T: password() again for the replacement

  rect rgb(255, 240, 240)
    Note over T,E: renewal fails
    T-->>P: serve the cached token while it is still valid
    Note over P,DB: existing sessions keep working —<br/>an Entra outage is not a database outage
  end
```

Three properties, and the reason for each. The mechanism each rests on was measured against the
versions this repository now pins exactly — `pg` 8.22.0, `@prisma/adapter-pg` 6.19.3 — by
`infra/postgres-identity/pg-password-callback-probe.mjs`, which prints the `pg` version it
measured and runs under `npm test`, so a driver upgrade that breaks any of them fails a build:

- **Acquire per connection, not per process.** `pg` accepts `password` as a function returning a
  promise and calls it once per _physical_ connection — proven by standing up a server that speaks
  the authentication handshake and recording the bytes: three concurrent checkouts produced three
  invocations and three distinct passwords on the wire, and releasing then re-acquiring a live
  connection produced none. `PrismaPg`'s constructor at 6.19.3 is
  `constructor(poolOrConfig: pg.Pool | pg.PoolConfig, options?)`, so the pool carrying that
  callback can be handed to Prisma directly.
- **Retire connections, and budget for the checkout that outlives the timer.**
  `maxLifetimeSeconds` does **not** evict a connection that is currently checked out: pg-pool's
  timer moves the client to `_expired` and can only act in `release()`. Measured on the same
  harness — a connection held for 2.5× its lifetime stayed open and was replaced only after it
  was released. So a connection's real ceiling is `CONNECTION_LIFETIME_S` (20 min) plus one
  `MAX_CHECKOUT_S` (10 min, the Functions Consumption ceiling, above Vercel's 60s route cap and
  the 30s trail transaction).
- **Renew far enough ahead to cover both.** `RENEW_MARGIN_MS` is derived rather than chosen:
  `(CONNECTION_LIFETIME_S + MAX_CHECKOUT_S) * 1000 + CLOCK_SKEW_MS`, 35 minutes. A flat five
  minutes against a thirty-minute connection — what this file previously described — let a
  connection run up to 25 minutes on an expired token, which negated the whole reason for
  retiring connections at all. `packages/db/test/entra-token.test.ts` asserts the invariant
  behaviourally, by sampling the life left on every token handed out across a simulated day,
  rather than comparing two constants.

Two failure modes are handled rather than assumed away. A renewal that fails serves the cached
token while it is still valid and suppresses the next attempt for `RENEW_RETRY_BACKOFF_MS`, so a
fast-failing Entra does not turn into one token request per connection — including once the cached
token is genuinely dead, which is the outage the backoff exists for and the one an earlier version
left unprotected. A token issued shorter-lived than the margin — which an Entra token-lifetime
policy can impose — cannot satisfy the invariant at all; the cache halves its margin so it stays
useful and says so through `onTokenTooShort`, which logs at **error** level by default and names
how far past expiry a connection could then run. That is a weaker control than it should be: only
the Function App's logs reach an Azure alert rule, so on Vercel and in CI the log line is the whole
signal. It is not reachable with the tokens this system actually gets — 60 minutes for an app
registration, 24 hours for a managed identity, both comfortably over the 35-minute margin.

**What is wired, and what is switched on.** `packages/db/src/client.ts` builds both Prisma clients
through `createClient`, which reads `DATABASE_AUTH`. It defaults to `password` and behaves exactly
as it did before — so deploying this code changes nothing until a consumer is moved deliberately.
Set to `entra` or `entra-vercel` it builds a `pg.Pool` whose `password` is the token cache and
whose `maxLifetimeSeconds` is `CONNECTION_LIFETIME_S`, wraps it in `PrismaPg`, and hands that to
Prisma as `adapter`.

Three things had to move with it, because a driver adapter bypasses the connection string. Prisma
reads `connection_limit` and `pool_timeout` off the URL and `datasourceUrl` cannot be combined with
an adapter at all, so `BACKGROUND_POOL_SIZE` and the background pool's thirty-second wait are
restated as `pg.Pool`'s `max` and `connectionTimeoutMillis`; the request pool restates Prisma's own
default of `cores * 2 + 1`, which it would otherwise silently lose to `pg`'s default of ten. Losing
that sizing is the outage recorded in that file's own comment.
`packages/db/test/entra-pool.test.ts` asserts the constructed pool carries each of them.

The URL is split into discrete fields rather than passed through as `connectionString`, and that is
not a style choice. `pg` merges a parsed connection string **over** the explicit config, so a URL
carrying no password replaces the password callback with `null` — every connection would then
authenticate with nothing and the token would never be requested. Measured on `pg` 8.22.0 and
asserted in both directions. Splitting it also means `sslmode` is finally read: the deployed URLs
have carried `verify-full` all along and Prisma ignores parameters it does not recognise, so under
the adapter it becomes a real `rejectUnauthorized` plus hostname check for the first time.

**Where each consumer's token comes from.** `DATABASE_AUTH=entra` uses `DefaultAzureCredential`,
which covers the Function App's managed identity, a workload identity and an operator's `az login`
without naming any of them. `DATABASE_AUTH=entra-vercel` uses
`ClientAssertionCredential(tenantId, clientId, () => getVercelOidcToken())` from `@vercel/oidc`.
The callback is referenced and called later, never invoked at module level, because Vercel's OIDC
reference is explicit that on a deployed function the token is not in the environment at all — it
arrives as the `x-vercel-oidc-token` header of the request in scope. No custom audience is passed:
the deployed federated credentials trust Vercel's default,
`https://vercel.com/mbahgattechs-projects`.

**UNVERIFIED: none of this has run against the production database.** The code compiles, the pool
it constructs is asserted, and the driver behaviour underneath it is measured — but no consumer has
`DATABASE_AUTH` set anywhere, so no Entra-authenticated Prisma query has ever been executed. The
Vercel path in particular has never run in a Vercel runtime, and its named residual risk is
unchanged: a connection opened from the cron drain or from `waitUntil` work that outlives the
response has no request in scope, so `getVercelOidcToken()` has no header to read and that
connection fails. A warm cache needs no assertion at all, and the 35-minute margin means only one
connection in every 35 minutes of traffic asks for one, so the exposure is a deployment whose
_only_ traffic for that long is background work. Capturing each request's header into a
module-level holder closes even that, at the cost of holding a two-hour bearer token in memory.

The identity Vercel presents is `id-switchback-vercel-publisher`, principal id `c9bfba39-…` — the
same one already trusted for Service Bus, and the one carried by the `sbapp_vercel` database role.

Whether retiring connections is a correctness requirement or only hygiene turns on one question
nobody should answer from memory: **is the token checked only at connect, or is a live session
terminated when it expires?**

**It is checked only at connect. Measured, run 31062754668.** Two connections were opened with one
60-minute token and held for 79 minutes — 19 minutes past its expiry:

```
token_expires_at|2026-08-06T02:27:13.000Z
token_life_remaining_min|59.9
planned_hold_min|79
poll|59|past_expiry=-0.8min|ok
poll|60|past_expiry=0.2min|ok        <- the boundary
poll|79|past_expiry=19.2min|ok
idle-reuse|past_expiry=19.2min|pid=866503|ok
VERDICT|crossed_expiry|true
VERDICT|polled_survived|true|last_good_minute=79
VERDICT|idle_reuse_survived|true
```

Both shapes were covered deliberately. One connection was queried every minute, so it was never
idle and its survival cannot be confused with a reconnect — same backend throughout. The other sat
untouched for the whole 79 minutes and was queried for the first time 19 minutes _after_ the token
died, on backend pid 866503, which is the pooled-connection case the application actually has: a
connection that goes quiet for an hour and is then handed to a request.

**Three earlier rounds could not get this, and the reason is worth keeping.** The `soak` job used
the CI managed identity, and Azure issues managed-identity tokens with a 24-hour life while a
GitHub runner is capped at six — so it could not reach the boundary however long it held. A
token-lifetime policy does not close that: `configurable-token-lifetimes` states that "configuring
token lifetimes for managed identity service principals isn't supported". What does close it is a
**throwaway app registration**, whose token for this resource is exactly 60 minutes — measured,
`expires_in=3599`. `.github/workflows/token-expiry-probe.yml` federates one to this repository, has
the Entra administrator map it to a grantless database role, holds the two connections, drops the
role, and the Graph objects are deleted afterwards. It is a reproducible experiment rather than
part of the deployed system, and its header carries the two `az` commands to stand it up again.

Microsoft's own documentation never settles this, which is worth writing down so the next person
does not re-read it hoping. `security-entra-concepts` gives the lifetimes — "User tokens are valid
for up to 1 hour. Tokens for system-assigned managed identities are valid for up to 24 hours" — and
says a deleted principal "can still sign in until the token expires". Both are statements about
_establishing_ a connection. Neither says anything about a session already established. The
measurement above is what the prose could not give.

**What this changes.** Retiring connections at `maxLifetimeSeconds` is hygiene, not the only thing
standing between the app and an outage: a connection that outlives its token keeps working. The
renewal margin still matters, because every _new_ physical connection presents a token and that one
must be valid — which is exactly what the password callback provides. The claim the margin now
carries is the modest, arithmetic one: no connection is ever opened with a token that has less life
left than that connection can possibly consume. Bounding connection lifetime remains worth doing so
authority does not accumulate indefinitely in a long-lived pool, but it is defence in depth.

### Sign-in for people

Auth.js with the Prisma adapter and a **database** session strategy: a session row can be deleted,
so "sign out everywhere" and "this account was compromised" are one query, where a JWT cannot be
revoked before it expires. The cost is a read per request, which loading `ctx.user` needed anyway.
Apple sits behind a flag because its client secret is a JWT signed per use — hence the async
Auth.js factory. The iOS app borrows the website's sign-in: Expo Go hands out an `exp://…` redirect
no provider registers.

```mermaid
sequenceDiagram
  participant A as iOS app
  participant S as Our server
  participant P as Entra ID

  A->>A: verifier = random, challenge = sha256(verifier)
  A->>S: GET /start?redirect=&challenge=
  S-->>A: 302 to /signin, row created,<br/>browser secret set as a __Host- cookie
  S->>P: ordinary OIDC
  P-->>S: session cookie
  S->>S: browser returns to /complete?request=, its secret checked
  S-->>A: 302 to the app's scheme with code + state
  A->>S: POST /claim with request, code and verifier
  S-->>A: access + refresh token pair
```

The provider only ever sees our own registered `https://` redirect. Four properties hold it together:
the code is worthless without the verifier that never left the device (PKCE applied to our own leg,
because on iOS any app may claim a URL scheme); everything is single-use inside one transaction; the
redirect is allow-listed when stored, not when used; and the row is bound to the authorising browser
as well as the claiming device, so a cross-site GET to `/complete` cannot mint a token pair on
somebody else's account.

### What is left

The database roles exist, the refresh mechanism is proven at the pinned versions, and both Prisma
clients can now be built on it — but **no consumer has `DATABASE_AUTH` set**, so the path is still
password-authenticated end to end. Three passwords are live, and they come off in this order:

1. **The Function App.** The simplest, because it is a long-lived process with a system-assigned
   identity and no request scoping to solve: `DATABASE_AUTH=entra` and a `DATABASE_URL` with the
   password removed and the user set to `sbapp_func`. Its app setting still carries `sbapp`. Its
   code also lives on `feat/servicebus-ingest` (PR #42) rather than here, so it cannot be moved
   from this branch at all.
2. **Vercel.** `DATABASE_AUTH=entra-vercel`, plus `AZURE_TENANT_ID` and the client id of
   `id-switchback-vercel-publisher`. The code exists and has never run in a Vercel runtime; the
   cold-cache-outside-a-request risk above is real and unmitigated.
3. **CI and the backup workflow.** `id-switchback-postgres-ci` is a proven Entra administrator that
   nothing uses; `ci.yml` and `backup-production-db.yml` both still read
   `secrets.DIRECT_DATABASE_URL`, which is `sbadmin` with full DDL. Switching them cannot be
   rehearsed on a branch, because the federated credential trusts `refs/heads/master` alone. One
   thing will bite when it is tried: `prisma db push` would then run as a role that is not
   `sbadmin`, so new tables would be owned by it and `sbadmin`'s `ALTER DEFAULT PRIVILEGES` would
   not apply — `ALTER ROLE "id-switchback-postgres-ci" SET role = 'sbadmin'` is the cheap fix, and
   is untested.

`passwordAuth` stays `Enabled` until all three are moved, and `infra/azure/postgres.bicep`
hardcodes it rather than taking it as a parameter, so no deployment of that template can turn it
off by accident. Turning it off first would lock the application out of its own database with no
way back that does not involve a restore.

One more thing, measured rather than suspected: **this repository is public.** Everything below is
readable by anyone, and a workflow artifact is downloadable by any authenticated GitHub user. That
is how a 371 MiB production dump — containing `sessions.sessionToken` and the `accounts` OAuth
tokens in plaintext, alongside real accounts and real GPS tracks — came to be published by run 31043403970. It was deleted on 2026-08-05 and the backup workflow now withholds the dump unless the
repository is private, but the session and OAuth tokens it exposed should be treated as
compromised. Whether this repository should be public at all is an open owner decision, and every
risk judgement in this document assumes it is.

The certificate-verification gap that used to sit here is closed by the wiring above, but only on
the Entra path: under `DATABASE_AUTH=entra` the pool is given a real `rejectUnauthorized` and
hostname check. In `password` mode Prisma still receives `sslmode=verify-full` as a parameter it
does not read, so until a consumer moves, its TLS is unverified.

## Design decisions, recorded once

- **Trail data is lazy per tile, not bulk-imported.** A global OSM import is tens of gigabytes to
  store, re-import and keep fresh, most of it ground nobody will open. Fetching a z9 tile when
  someone looks at it makes the corpus exactly the places people use, and freshness a 30-day TTL per
  tile. The cost is a cold first visit — hence partial results now rather than blocking on Overpass.
- **Elevation is terrarium PNGs from AWS Terrain Tiles, not a hosted elevation API.** Hosted APIs bill
  or rate-limit per point, and a 17 km trail sampled every 25 m is 680 points. Terrarium tiles are
  static objects on S3 with no quota, and that trail touches perhaps four z13 tiles — four GETs
  whatever the sampling density. The same DEM renders the default basemap, so no key or vendor stands
  between a clone of this repo and a working map.
- **The service worker cannot import anything.** It lives under `public/`, outside the module graph,
  so cache names and the static-asset pattern exist in two files. The alternative was Workbox and a
  build step, for a file whose failure mode is "the app is bricked until site data is cleared". A
  test that reads the worker as text and compares character for character makes the duplication safe.
- **A handover keeps queued writes and drops cached pages.** When the account on a browser changes,
  everything cached under `sb-` was fetched with the previous reader's cookie and goes; their queued
  reports and hikes are stamped `heldAt` and kept — a download can be fetched again, a report written
  on a ridge cannot. Reader-specific shell pages go entry by entry, not by deleting the shell cache,
  which would take the offline fallback and this build's chunks with them.
- **The map is a WebView on iOS while everything else is native.** `@maplibre/maplibre-react-native`
  needs a development build, which needs a Mac, and a second cartography to keep in step. The phone
  loads `/embed/map` from the same origin instead, so `buildStyle` and the trail layers are one
  module serving both clients. The protocol is declared in `packages/core/src/map-bridge.ts` and
  `safeParse`d at both ends, because the halves deploy separately. The map runs `browse` itself and
  returns summaries with geometry stripped: polylines must not cross a string channel on every pan.
- **Route planning runs on its own cached network.** The catalogue keeps a relation's primary line and
  drops anything under 200 m — right for a catalogue, wrong for routing, where the 150 m unnamed
  connector is what makes a loop possible. `RoutingTile`/`PathSegmentRow` cache every foot-legal way
  lazily on the same on-demand pattern, and the graph is built in the browser.
- **Background work holds its own connection pool.** Three code paths start ingest drains, each
  guarded only against a second of its own kind. Sharing the request pool meant background commits
  taking every connection and Auth.js's session lookup losing — which presents as a signed-out header
  and an empty map, not as a busy ingest. `BACKGROUND_POOL_SIZE` in `packages/db/src/client.ts` is
  the ceiling; `COMMIT_CONCURRENCY` derives itself from it.
- **Photograph bytes go straight to R2 from the browser** with a presigned PUT: Vercel's body limit is
  4.5 MB and a proxied upload pays for the bandwidth twice. SigV4 is implemented in
  `packages/api/src/storage.ts` — the AWS SDK is ~1.5 MB of bundle to produce one string.
- **Viewport queries use indexed bbox columns, not `ST_Intersects`.** A plain Prisma `where` composes
  with facets and paginates properly; PostGIS would mean a capped candidate id list intersected with
  facets afterwards, silently dropping matches when the cap bites. False positives are the better bug.
- **The route planner's profile constants must stay equal to ingest's.** `PROFILE_SPACING_M` and
  `RENDER_SIMPLIFY_M` in `routers/routes.ts` are copies of module-private values in
  `ingest/pipeline.ts`. Gain is measured under a 10 m hysteresis threshold (`GAIN_THRESHOLD_M`), so a
  profile sampled at 25 m and one at 60 m differ in _answer_, not resolution — let the two drift and
  a planned route reports different numbers from an ingested trail of the same shape.
- **Mobile state lives at module scope, not in a hook.** The tab bar destroys screen-owned state, so
  a recorder or a ping loop owned by the Record screen stops the first time somebody switches tabs —
  silently, on a safety feature whose own panel would go on claiming it was running. `record/store.ts`
  and `record/lifeline.ts` argue it from that; `offline/store.ts` from three screens needing one
  index. React subscribes through `useSyncExternalStore`.
- **Page sizes live in `apps/mobile/src/api/pages.ts`.** A page size is part of a React Query key and
  the offline layer seeds those keys from disk, so a seeded key off by one number seeds nothing and
  the screen shows its empty state on a phone holding the whole trail.
- **The design has no z-axis.** Depth is plate colour and hairline rules, never a drop shadow. No
  type can express that, so it is held by `apps/web/test/conventions.test.ts` and
  `apps/mobile/test/conventions.test.ts` reading source for shadow utilities and React Native's
  shadow props — which makes it, today, discoverable only by breaking it.
- **Survey red means the reader or their safety, and nothing else.** [design.md](design.md) owns the
  palette; what belongs here is where the colour stops. It is right on the position dot, an off-route
  banner, an overdue Lifeline, and a confirmation throwing away the reader's own hike. It is wrong on
  the record button, and wrong on a moderator's takedown in somebody else's row, where red reads as
  an accusation against them.
- **`admitIngest`'s ceiling is deliberately soft.** tRPC starts every call in a batch concurrently
  and the depth check is a bare `groupBy` under no transaction and no advisory lock, so one request
  can overshoot by `MAX_BATCH_SIZE` × `MAX_TILES_PER_REQUEST`. The obvious fix — an advisory lock
  around the count and the enqueue loop — becomes a global mutex held across up to 96 tile upserts
  and 96 job enqueues on the deliberate-area path, on a serverless deploy, past Prisma's interactive
  transaction budget. A rate limiter in front is the prerequisite, and does not exist yet.
