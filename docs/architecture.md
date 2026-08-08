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
  participant SB as Service Bus
  participant W as Functions worker
  participant P as processTile
  participant O as Overpass

  C->>B: bbox
  B->>V: cover with z9 quadkeys, 12 max per request
  V->>DB: read ingest_tiles, upsert missing + deduped ingest_jobs
  V-->>B: ready / refreshing / pending / queued
  B->>DB: trails whose bbox overlaps the viewport
  B-->>C: partial results now + the pending quadkeys

  alt INGEST_QUEUE_DRIVER is servicebus
    B->>SB: waitUntil publish, one dedupeKey per queued tile
    W->>SB: queue trigger, one message at a time
    W->>P: drainIngest limit 1, scoped to that dedupeKey
  else postgres, the default
    B->>P: waitUntil drainIngest, the same handler the cron runs
  end

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

**One inline drain per instance, and a kick is carried rather than dropped.** The Overpass client
caps itself at two concurrent requests, so a second drain running alongside the first would only
pile claimed work behind it and sink the tile someone is waiting on. `api/inline-drain.ts`
serialises them and carries the tile keys of anything asked for meanwhile into a single follow-up
pass, because a drain is scoped to its caller's keys: dropped, the next reader's tile waits on a
poll or on the cron. Two edges of that: keys past `MAX_PENDING_KEYS` are left to the cron, and the
follow-up claims only its four oldest jobs, so a late key is asked for in the next pass and served
within a few. The cost is that every poll landing mid-drain now holds its invocation open until the
follow-up ends — 25 held invocations against 1 across a 60 s pass at the 2.5 s poll below — which is
what buys the follow-up enough `after()` budget to finish.

**Which queue drives it is `INGEST_QUEUE_DRIVER`**, read in `apps/web/src/env.ts` and branched on in
`kickIngest`, `kickNetwork` and the drain cron — **and, on the Azure side, by the worker's own timer
pump and queue trigger.** That last part is what makes the flag a rollback rather than a fan-out:
set it to `postgres` on both sides and Vercel drains `ingest_jobs` again while the pump stops
publishing and the trigger drops whatever is still in flight. Setting one side only leaves two
drainers on the same table, which is worse than either alone.

Unset or `postgres` is the original path, unchanged. On `servicebus` the request publishes one
`{dedupeKey}` message per queued tile and makes no Overpass call at all, and an Azure Functions
worker drains one job per message. `ingest_jobs` stays the queue of record either way — a message
names work, it never carries it, so a lost message costs a wait rather than a tile. A timer pump in
the worker re-derives the runnable head of `ingest_jobs` every two minutes and tops the queue back
up to eight, which is what keeps `priority DESC` meaningful behind a FIFO broker. The cron runs on
either driver and drains on neither by accident: it sweeps first and drains only when this side owns
the queue.

**Lease recovery does not depend on a drain happening.** It used to: `reclaimExpiredJobs` ran only
inside `drainJobs`, and a drain is a side effect of traffic on cold ground plus a cron that Hobby
allows to fire once a day. So a cron tick that claimed ten jobs at 04:51 UTC on 2026-08-07, then
died on Vercel's 60 s wall clock still holding them, left ten leases 5.9 h old against a 30-minute
lease — four of them at their last attempt, so the next reclaim would have buried them.
`sweepQueue` in `packages/ingest/src/maintenance.ts` is that reclaim plus the split-marker repair
below, run from three places that do not require a drain: the cron route unconditionally,
`trails.kickIngest` off any request traffic at most once per fifteen minutes per process, and
`drainSlotGate` inside the transaction that admits a drainer.

**A parent can claim a subdivision that has nothing behind it.** `splitTile` upserts four child
rows, enqueues four jobs and only then marks the parent, so the marker is the _last_ write and a
process that dies part-way leaves no marker at all — the split cannot produce this state, and
reading it as a crash window sends the next reader hunting for a window that does not exist. What
does produce it is a later deletion of the subtree: production's six marked parents were split,
their stranded z10 rows were cleared afterwards, and no z10 row remains anywhere in the table.
Anything that deletes a subtree must clear its parent's marker in the same pass. Nothing else
repairs the parent — `promoteFrom` needs four children to read, `queueStaleChildren` needs children
to queue, and `processTile` only reaches its roll-up branch when `childTiles` returns four. Six such
rows are in production, marked 2026-08-05 21:03 to 2026-08-06 00:54 UTC.
`reconcileOrphanedSplits` clears the marker and re-queues the parent, writing `status` and
`lastError` and nothing else: `trailCount`, `fetchedAt`, `fetchMs` and every trail the tile ever
produced are untouched, and a parent still serving trails keeps the status it is serving them
under. The predicate is the marker the repair removes, so a second pass finds nothing. The write
order is also what makes the repair safe beside a live split: a split that has written the marker
has already written its four children, so `childTiles` returns four and the parent is left alone.

The six do not all get the same number of tries. `enqueue` resets `attempts` only for a job in
`done`, `failed` or `dead`, so a parent whose job is already `queued` keeps its ladder — measured
on 2026-08-07, `ingest_tile:120221231` re-enters at 4 of 5 and has one attempt left, while
`ingest_tile:120230212` was `done` and starts again at 0. Preserving the ladder is the intent; the
consequence is that the densest of the six can reach `dead`, which `queueHealth` counts and the
distress rule reports.

**Turning it on. The order is the mirror of the rollback below, and it matters for the same
reason.** Vercel first, worker last:

```bash
# 1. Both environments, plus the three identifiers beside them.
vercel env add INGEST_QUEUE_DRIVER production --value servicebus --no-sensitive --yes
vercel env add INGEST_QUEUE_DRIVER preview "" --value servicebus --no-sensitive --yes

# 2. Promote a deployment built with it, then confirm that deployment is the one serving. Minutes.
vercel redeploy switchback-three.vercel.app --target production
curl -s https://switchback-three.vercel.app/api/version

# 3. The worker starts draining. Seconds.
az functionapp config appsettings set -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri --settings INGEST_QUEUE_DRIVER=servicebus -o none
```

**Two things about those two commands, both learned the hard way.** `--no-sensitive` is not
cosmetic: `vercel env add` marks Production and Preview values sensitive by default, and a sensitive
variable reads back from `vercel env pull` as `INGEST_QUEUE_DRIVER=""` — indistinguishable from
unset, and the exact failure this runbook exists to make visible. It does **not** change what
`vercel env ls` prints. On CLI 54.1.0 a `--no-sensitive` variable still lists as `Encrypted`,
measured on 2026-08-08 against `INGEST_TRAIL_IDENTITY` written with the flag and read back by
`env pull` as the literal `claim`, so `env pull` is the only check that distinguishes the two and
`env ls` answers presence alone. And the empty `""` positional in the Preview line is the
git-branch argument: without it the CLI answers `git_branch_required` and suggests the command you
just ran, in a loop. Passing the value on stdin instead of `--value` sets it to the empty string
silently.

**Both** Vercel environments, in step 1 — for `INGEST_QUEUE_DRIVER`, which Preview still carries.
The flag is per environment, and a Preview left on `postgres` (or, as it was until this branch, left
unset, which resolves to `postgres`) would be a second drainer against the same `ingest_jobs` with
its own `OverpassClient` on every warm preview lambda. `vercel env ls preview` is the check; the
absence of the variable is the failure mode, and it does not look like one.

Preview can no longer reach the production database at all: `DATABASE_URL`, `DIRECT_DATABASE_URL`
and `CRON_SECRET` were removed from that environment, and `apps/web/src/env.ts` refuses to start a
non-Production Vercel environment whose connection string names `psql-switchback-prod-37ywppu5p7fri`.
So a Preview on the wrong driver value cannot drain; it fails its environment check first. Set the
flag on both anyway — the day Preview gets a database of its own, the mismatch comes back.

Between 1 and 3 **nothing drains at all**, and it is worth being exact about that because the
reassuring version is wrong: the tiles do not wait for a pump tick, because the pump is the worker's
and returns early — `INGEST_QUEUE_DRIVER is not servicebus` — for as long as step 3 is outstanding.
Vercel has stopped draining and the worker has not started, so `ingest_jobs` accumulates and the
first thing to touch it is step 3. Rows are safe; the wait is however long step 3 takes. Doing 3
first is the state this design exists to prevent — Vercel still draining `ingest_jobs` inline while
the worker drains the same table — and it is worth naming that it happened here: the flag was set on
the Function App while production Vercel still served a commit whose `kickIngest` drained
unconditionally, and the first end-to-end run was collected in that state.

**At 3am.** The worker stands down first and Vercel picks the drain back up last, and **the order is
not arbitrary**:

```bash
# 1. Stop new work reaching the queue. Instant, and it does not touch either drain.
az functionapp config appsettings set -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri --settings INGEST_PUMP_ENABLED=false -o none

# 2. The worker stands down. Seconds — an app-settings write restarts the host.
az functionapp config appsettings set -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri --settings INGEST_QUEUE_DRIVER=postgres -o none

# 3. Vercel, both environments. `--no-sensitive` is what makes step 5 able to read the value
#    back with `env pull`; the `""` on the preview line is the git-branch positional. Both are
#    explained above.
vercel env rm INGEST_QUEUE_DRIVER production --yes
vercel env rm INGEST_QUEUE_DRIVER preview --yes
vercel env add INGEST_QUEUE_DRIVER production --value postgres --no-sensitive --yes
vercel env add INGEST_QUEUE_DRIVER preview "" --value postgres --no-sensitive --yes

# 4. Promote a deployment built with it. Vercel binds environment variables at build time, so
#    until this lands the running deployment still publishes and does not drain. Minutes.
#    Preview deployments are per-branch and carry the old value until each is rebuilt; redeploy
#    any that are still serving, by URL from the second command.
vercel redeploy switchback-three.vercel.app --target production
vercel ls --environment preview

# 5. Verify all three. The deployment check is the load-bearing one: the variable set is what
#    step 3 already wrote, so it reports success whether or not any deployment carrying the
#    change exists.
#
#    `env pull` rather than `env ls`: `ls` prints `Encrypted` for a `--no-sensitive` value too,
#    so it answers presence and never which driver. The file it writes holds every production
#    secret — put it outside this repository, which is public, and delete it.
vercel env pull /tmp/switchback.env --environment production --yes
grep '^INGEST_QUEUE_DRIVER=' /tmp/switchback.env && rm -f /tmp/switchback.env   # expect postgres
vercel ls --environment production                    # newest row's Age must be younger than step 3
az functionapp config appsettings list -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri \
  --query "[?name=='INGEST_QUEUE_DRIVER'].value | [0]" -o tsv              # expect postgres
```

**The rollback is also what makes the Vercel side readable.** Step 3 replaces a sensitive value with
a `--no-sensitive` one, which is why `env rm` precedes `env add` rather than the value being edited
in place, and why step 5's `env pull` can expect the literal `postgres` rather than `""`.

Step 1 is instant and reversible and stops the queue filling — but it stops _new_ publishes, not the
up-to-eight messages already on the queue, which the trigger keeps working. So the worker has to be
the side that stands down first. Its setting is an app-settings write that restarts the host in
seconds; Vercel's needs a redeploy of the project, minutes. Doing Vercel first means the interval
between the two has Vercel draining `ingest_jobs` inline while the worker is still on `servicebus`
and still finishing in-flight messages — the two-drainer state this flag exists to prevent, entered
by following the runbook. Doing the worker first means the interval has neither side draining, which
costs a wait and nothing else.

**"Seconds" means the queue trigger, not the timer.** An app-settings write restarts the host, but a
timer tick already scheduled on the outgoing process can still run once holding the old value.
Observed standing the worker down at 21:21:56Z on 2026-08-03: the 21:24:00 pump published seven more
signals while the restarted trigger, in the same second, logged
`INGEST_QUEUE_DRIVER is not servicebus — dropping the signal` for each. Harmless — a published
signal makes no Overpass request and the rows stay `queued` for Postgres — but it is why step 1
exists and why "the worker stands down in seconds" is a statement about the drain, not the pump.

Between steps 2 and 4 nothing drains either, for the mirror-image reason: the trigger drops the
message it receives and the Vercel cron does not drain until step 4's redeploy carries the new value
into `drainOrReclaim`. A message that arrives is discarded and its `ingest_jobs` row waits for step 4. Nothing is lost either way, because a message names work and never carries it. **Stopping after
step 3 is the one way to get this wrong**: the variable is written, `env ls` reports it, and no
deployment carries it — so neither process drains and the check says the rollback succeeded. That is
what step 4 is for and why step 5 reads the deployment rather than the variable.

**Do not re-flip to `servicebus` within ten minutes of rolling back.** The queue carries
`duplicateDetectionHistoryTimeWindow: PT10M` and the pump republishes the same `dedupeKey` as
`messageId`. Every signal dropped during the rollback was published under a `messageId` the broker
still remembers, so a re-flip inside that window has those republished signals silently discarded —
the rows are safe and the two-minute pump picks them up on the next tick, but the first tick after
the re-flip does nothing and looks like a broken worker. Wait out the window, or expect one dead
tick.

**The publisher holds no credential.** Vercel signs a short-lived OIDC token per deployment and puts
it on every function request as `x-vercel-oidc-token`; `publishIngestSignals` posts that to Entra as
a `client_assertion` and gets back an access token for Service Bus. What makes Entra accept it is a
federated identity credential on a user-assigned managed identity, declared in `ingest.bicep`,
pinned to issuer `https://oidc.vercel.com/<team>` and subject
`owner:<team>:project:<project>:environment:production` — a second credential covers `preview`,
because Entra matches those fields exactly and allows no wildcard. The namespace has
`disableLocalAuth: true`, so no SAS key would work even if one existed. The three variables Vercel
holds — namespace host, tenant id, client id — are identifiers, not secrets.

The access token is cached in module scope, so a warm lambda pays one exchange rather than one per
request and a cold one pays a single extra round trip before the send. When the exchange fails the
publisher logs and returns a failure count; it never throws. That is deliberate and load-bearing:
the `ingest_jobs` rows were written before the publish, so an Entra or Service Bus incident costs the
wake-up and the pump re-derives the same rows within two minutes. A broker outage must not empty the
map, and it cannot.

**Two concurrent Overpass requests, fleet-wide, and `packages/ingest/src/drain-slot.ts` is what
makes that true.** This paragraph is the one statement of the bound; everything else that quotes a
number points here.

Overpass allots slots per client IP and exceeding the allowance gets the IP blocked, which takes
ingest down for the product rather than for one job. So the bound is a correctness requirement, and
it is the product of two factors:

| Factor                                 | Value | Enforced by                                                            |
| -------------------------------------- | ----- | ---------------------------------------------------------------------- |
| Processes holding Overpass-making work | 1     | `INGEST_MAX_DRAINERS`, via a Postgres advisory lock in `drainSlotGate` |
| Requests in flight per process         | 2     | `OVERPASS_MAX_CONCURRENT`, inside one module-level `OverpassClient`    |
| **Concurrent Overpass requests**       | **2** |                                                                        |

The second factor alone was the whole argument until now, and it bounds a _process_. On the Function
App that is the fleet — `functionAppScaleLimit: 1` and
`WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT: 1` give one host instance,
`FUNCTIONS_WORKER_PROCESS_COUNT: 1` one Node process, and `getOverpass()` one client inside it, all
declared in `infra/azure/ingest.bicep`. On Vercel it is one lambda. The platform starts as many
lambdas as the traffic asks for, each with its own module scope and its own client, and they share
one egress IP — so a per-process singleton bounded a fraction of the drainer and nothing bounded the
fleet. `packages/ingest/src/config.ts` had said as much since it was written: _two clients at
`maxConcurrent: 2` are one client at 4_.

**Vercel is the drainer that runs.** `INGEST_QUEUE_DRIVER` is `postgres` in production, the Function
App's own log says `INGEST_QUEUE_DRIVER is not servicebus → Postgres owns the drain`, and
`ingestDrain`'s most recent invocation is 2026-08-06T00:44:04Z, the tail of the last flag-on proof.
The Azure clamp above therefore
bounds a process that performs no Overpass work. The first factor is what bounds the one that does.

The first factor is enforced where it has to be — across processes, in the database.
`drainSlotGate` takes `pg_advisory_xact_lock`, reclaims expired leases, counts
`count(distinct "lockedBy")` over `running` jobs, and claims, all in one transaction. Check and
claim cannot be two statements: under `READ COMMITTED` two lambdas both read "nobody is draining"
before either commits. Each caller's `workerId` is unique to its process, because a fleet sharing
the string `inline` counts as one drainer however many lambdas are running.

**`lockedBy` proves the bound only while a job is mid-drain, which is almost never observable.**
Every exit from `running` used to null it — a released lease must stop matching, or a stale
worker's write could overwrite a live one's — so a finished job named no process at all, and eight
samples over 70 s of production caught zero running rows. `writeOutcome` now fences on `status` as
well as `(lockedBy, lockedAt)`, so the status change alone releases the lease and the pair can
stay. No column was added: `lockedAt` and `completedAt` bound one drain and `lockedBy` names it,
which is more than a "which process" column could have given, because concurrency is a question
about overlapping intervals rather than about distinct names.

```sql
-- Peak concurrent drains in the last hour. Must not exceed INGEST_MAX_DRAINERS.
-- A sweep line over lease start and end, not a distinct count of names: two strictly serial cron
-- invocations use two ids and are not two drainers.
select max(concurrent) as peak from (
  select sum(delta) over (order by at, delta desc) as concurrent
    from (select "lockedAt" as at,  1 as delta from ingest_jobs
           where "completedAt" >= now() - interval '1 hour' and "lockedAt" is not null
          union all
          select "completedAt" as at, -1      from ingest_jobs
           where "completedAt" >= now() - interval '1 hour' and "lockedAt" is not null) edges
) swept;

-- Which processes, and how much each ran.
select "lockedBy", count(*), min("lockedAt"), max("completedAt") from ingest_jobs
 where "completedAt" >= now() - interval '1 day' group by 1 order by 2 desc;
```

`lockedBy` carries no index and `lockedAt` carries the one the lease sweep needs. The table is
45,225 rows, these are forensic queries rather than a hot path, and a second index would cost a
write on every job outcome to save a sequential scan nobody runs in a request.

**The gate is `drainIngest`'s default, not a call site's to remember.** Three entry points on
Vercel reach the queue — `trails.ts` for viewport tiles, `routes.ts` for the route planner's
network tiles, and the cron route — and `routes.ts` shipped without a gate for as long as passing
one was a caller's decision, which left the `ingest_network` path (a real Overpass query, reachable
from the public `routes.coverage` procedure) bounded by nothing. `drainIngest` now supplies
`drainSlotGate` unless the caller passes `gate: null`, and `packages/ingest/test/drain-slot.test.ts`
holds that: a caller that asks for no gate is still refused while another process holds the slot.

One caller opts out, and only one: `apps/ingest-worker/src/drain.ts`, where the process is the whole
fleet by Azure configuration and a cross-process lock would serialise invocations the platform has
already made safe. `scripts/ingest.ts` does not opt out — an operator draining from a laptop against
this database counts against the same slot, which is conservative rather than exact, since that run
leaves from a different egress IP.

The cost is honest and deliberate: a drainer that dies holding claims keeps the slot shut until its
lease expires. That is why the gate sweeps inside its own transaction, and why `sweepQueue` runs off
request traffic as well — `LEASE_TIMEOUT_MS`, not a day. Throughput is the thing traded, and an IP
block is the thing bought off.

The queue sets `requiresSession: false` so session count is not a third multiplier. Around a
Consumption instance replacement two host instances of the worker are briefly alive at once, so the
worker's own contribution can reach 4 for the seconds of a recycle — measured, and recorded under
the clamp section of `infra/azure/ingest.bicep`.

**"Vercel fetches nothing" was only ever a statement about `INGEST_QUEUE_DRIVER=servicebus`, and it
is per Vercel environment rather than per deployment.** Production and Preview hold the flag
independently and both point at the production database, so an environment left on `postgres` is a
second drainer against the same `ingest_jobs`. Measured at 2026-08-03T23:26Z, Production read
`postgres` and Preview had no `INGEST_QUEUE_DRIVER` at all (17 variables, and it was not among
them), which `ingestQueueDriver()` resolves to `postgres`. Both are now set explicitly, and
`vercel env ls <environment>` is how you check rather than assume. Under the drain slot a second
environment no longer multiplies the bound — it contends for the same slot against the same
database — but it does halve the drain rate, so it is still worth knowing. The residue is branches
cut before the flag existed: their code has no `ingestQueueDriver` call to make, and none has a
`drainSlotGate` either, so their previews drain inline and unbounded until they rebase onto master.

**The client's retry budget has to fit inside `functionTimeout` — and fitting it is not enough.**
Consumption ends an invocation at ten minutes and will not raise it; `OverpassClient`'s own worst
case on the defaults is six attempts of 190 s plus backoff — about 24 minutes for one query, and
`processTile` makes several. That is not theoretical: `ingest_tile:120221221` ran 600008 ms on
2026-08-03 and the host killed the worker mid-tile. Two numbers bound the Overpass part of it, both
set in `ingest.bicep`: `INGEST_OVERPASS_DEADLINE_MS` (300 s) is the last moment the worker will
_start_ a query, and `OVERPASS_MAX_TOTAL_MS` (240 s) is the most one query may then spend across
every retry — 540 s worst case inside 600 s. Past the deadline the Overpass view throws, `drainJobs`
catches it per job, writes `lastError` and releases the lease, which is a far cheaper failure than
the host killing the process. And the pump calls `reclaimExpiredJobs` on its two-minute tick, so a
lease that _is_ stranded comes back in minutes rather than waiting for the daily cron.

**540 s bounds Overpass. `INGEST_DEADLINE_MS` bounds the invocation, and it had to.** Overpass was
never the handler's only wall clock. `TerrainSource` fetched a terrarium tile per DEM sample with a
bare `fetch` — no signal, no per-request timeout, no budget — and the per-trail writes are their own
time; neither was inside the 540 s. Measured on 2026-08-03 with the flag on, five tiles through the
worker: 021212220 at 205 s, 031313102 at 415 s, 031313120 at 491 s — then 120221230 and 120221203,
both dense alpine tiles, killed at 612,947 ms and 615,938 ms. The same window has
`[HostMonitor] Host CPU threshold exceeded (99 >= 80)` repeating from 22:24 to 23:04 and
`ingestPump` ticks of 19,901 ms and 57,939 ms in the same process, so a saturated single instance
with the timer contending against the queue trigger is a second, independent term — and one
`maxConcurrentCalls: 1` does not cover, because the pump is not a queue message.

So there is now one wall clock rather than one per subsystem: `INGEST_DEADLINE_MS` (540 s) is passed
to every phase as `PipelineDeps.deadlineAt`. Past it terrain refuses to start a fetch, the commit
loop refuses to start a trail, and `processTile` marks the tile `failed` and throws — the same
cheap, caught, lease-releasing failure the Overpass deadline already produced, 60 s before the host
would kill the process. Each terrarium request also carries its own 20 s `AbortSignal.timeout`,
because Node's `fetch` imposes none and a stalled socket is how you reach 615,938 ms without any
phase ever _starting_ late.

**And it now alerts — on the job, which is where the failure actually lands.** A killed invocation
does not dead-letter: the redelivery finds the row still under the killed invocation's lease, logs
"nothing claimable" and _completes_ the message in ~165 ms, so `DeliveryCount` never reaches 2 and
`switchback-ingest-deadletter` — which fires on `DeadletteredMessages` — structurally cannot see it.
`deadLetterMessageCount` was 0 for the whole run while this happened twice.

The first version of `switchback-ingest-drain-failed` read `requests | where success == false`, and
that was blind to the failure mode it was written for. `drainJobs` catches every handler error,
writes it to the job row and returns normally, so the 2026-08-04 run was 14/14 successful
invocations while six Alps tiles were failing — the failure existed only as six `traces` lines. The
rule now unions the request arm with a `traces` arm keyed on the literal `ingest-job-failed` that
`runIngestSignal` logs beside every job-level failure. Matching a token rather than a sentence is
deliberate, and `apps/ingest-worker/test/drain.test.ts` asserts the code and the template still
agree on it. Severity 2, onto the same action group, `autoMitigate: false` — the condition is "this
happened", not "this is happening".

**Every arm of that rule reads telemetry the Function App emits, and the Function App is not the
drainer.** `INGEST_QUEUE_DRIVER` is `postgres`, its own log says `INGEST_QUEUE_DRIVER is not
servicebus — Postgres owns the drain`, and `ingestDrain`'s most recent invocation is
2026-08-06T00:44:04Z — the tail of the last flag-on experiment, and nothing since. The drain runs on
Vercel, which has no Application Insights, so a split marker, a stuck-subtree marker and a 429 from
a mirror all reach a console with no rule able to query it. "No 429s observed" was a statement about
what could be seen.

What closes that is `switchback-ingest-queue-distress`. Five of those conditions are a row —
a job buried inside the last hour, a lease past `LEASE_TIMEOUT_MS`, a `lastError` naming a 429, a
tile carrying a split marker with no children, a subtree marked stuck — and `ingestPump` runs inside
the alert's own subscription every two minutes and already reads that database.
`apps/ingest-worker/src/health.ts`
counts them and logs the token when any is non-zero, ahead of the pump's `INGEST_QUEUE_DRIVER`
guard, because `postgres` is exactly the setting under which it matters.
`apps/ingest-worker/test/health.test.ts` asserts the token, the query and that ordering. Severity 3
and `autoMitigate: true`, unlike the rule above: this is a gauge re-read every two minutes, so a
queue that has been repaired should clear it rather than leave a resolved condition open.

**The sixth condition is the absence of one.** A drain that has stopped writes no error, takes no
lease and marks no tile: jobs simply stay `queued`, which is what they do while a healthy drain
works through a backlog. All five row-shaped fields read zero and the pump keeps heartbeating, so a
`/api/cron/drain` returning 500, a cron entry dropped from `apps/web/vercel.json` or a bad deploy
would have presented as "tiles are slow" indefinitely — the same shape as a worker that had stopped
doing its job while looking identical to one doing it. `stalledDrain` is the field that names it:
1 when work is due _and_ nothing has reached a terminal state inside `DRAIN_SILENCE_MS`.

**A gauge that cannot reach zero is not a gauge, and three fields could not have been.** `failJob`
buries a
job as `dead` rather than deleting it and `pruneFinishedJobs` keeps that row for thirty days, so an
unwindowed count sits at production's twenty-five for a month and a new 429 — the signal the rule
exists to raise — changes nothing an operator can see. `DISTRESS_WINDOW_MS` bounds `dead` and
`rateLimited` to the last hour, longer than the rule's fifteen-minute window so nothing falls
between evaluations, and `orphanedSplits` counts parents whose children are actually absent rather
than every parent carrying a marker — a legitimate subdivision holds its marker for as long as its
four children take, and counting those would report dozens of wedged tiles on a healthy system.
`stalledDrain` is the third, and the trap there is subtler: the obvious implementation counts due
work, and `ingest_jobs` holds 44,884 `queued` rows overdue since 2026-07-30, which is a light left
on rather than a gauge. Silence is the signal instead. Over the 14 days to 2026-08-07 there were 341
terminal transitions, p95 gap 0.70 h and widest 27.90 h; `DRAIN_SILENCE_MS` is 36 h, which clears
that maximum and a whole missed daily cron, so a quiet weekend is not a page and a real stoppage is
named within a day and a half.

Measured read-only against production on 2026-08-07 17:50 UTC, every field reads zero:
`dead` 0 windowed against 25 unwindowed, `staleLeases` 0, `rateLimited` 0, and no `ingest_tiles` row
carries a split marker or a stuck-subtree marker. The gauge is clear and can fire on the next real 429.

**All three rules are deployed, and so is the code that arms them.**
`az resource list -g rg-switchback-prod-northcentralus --resource-type
Microsoft.Insights/scheduledqueryrules` returns `switchback-ingest-drain-failed`,
`switchback-ingest-queue-distress` and `switchback-ingest-worker-silent`. The Function App runs a
bundle published by `.github/scripts/deploy-worker.sh`, which is the file `ci.yml`'s `deploy ingest
worker` job will invoke on every push to master — and which refuses to report success until the
running host emits a heartbeat naming the commit it just pushed.

**The distress rule alone would still read a dead worker as a healthy estate**, because its whole
firing condition is a log line and a host that is down or serving an old bundle produces none.
`switchback-ingest-worker-silent` is the answer: `reportQueueHealth` logs
`switchback-ingest-queue-health` on _every_ reading, so fifteen lines per thirty-minute window is
the resting state and zero is alertable. That rule is the only one in this file whose firing
condition a stale build cannot suppress.

**Overpass strain reaches whichever platform log the drainer writes to, and no further.**
`packages/ingest/src/overpass.ts` emits `switchback-ingest-overpass-strain` on a retried 429, a
transport failure, a mirror failover and every breaker transition. Those events are not all
alertable and the reason is worth stating: a retry that eventually succeeds writes nothing to
`ingest_jobs`, so the only channel is the console — Vercel's, under `INGEST_QUEUE_DRIVER=postgres`.
What an alert can watch is the subset that outlives the retry budget and fails a job, which
`queueHealth`'s `rateLimited` counts from `lastError`. Etiquette is a correctness requirement here —
the failure mode is an IP block that takes the product down — so the line exists even where no rule
can read it, because previously this file contained no `console` call at all and a mirror
rate-limiting this client left no trace anywhere.

Retrieving them, which no rule can do for you:

```bash
vercel logs switchback-three.vercel.app --follow | grep switchback-ingest-overpass-strain
```

`--follow` is the flag that streams _runtime_ output; without it the command lists request lines
rather than what the handler printed. It is a live tail, so it answers "is a mirror refusing us
right now" and nothing about last week — a durable record would need a Vercel log drain, which is
not configured. Until it is, the part of this signal that survives is the `lastError` on a job that
exhausted its retries, which is what `queueHealth`'s `rateLimited` counts and
`switchback-ingest-queue-distress` alerts on.

**What the deadline does not do is make a dense tile ingestable, and the second flag-on run says so
plainly.** 2026-08-04T00:14Z-01:23Z, ten `ingestDrain` invocations, none killed — the longest was
543,653.9 ms against a 600,000 ms `functionTimeout`, where the previous run's longest was
615,938 ms and `FAILED`. Five of the ten were alpine z9 tiles (`120221203`, `120221212`,
`120221213`, `120221223`, `120213322`); every one of them spent its whole 540 s and ended on
`IngestDeadlineError`, written to `lastError`, lease released, retry scheduled off the backoff
ladder — and one job reached the end of that ladder and was `retired`. Two tiles finished:
`120221232` at 448,188.0 ms and `031313103` at 347,561.9 ms. The Consumption instance was over its
CPU threshold for the entire window (75 `[HostMonitor] Host CPU threshold exceeded` lines,
00:17:37Z to 01:22:19Z) with `ingestPump` ticks up to 30,941 ms in the same process, so the drain
was never running alone.

So the honest statement is: a z9 tile in dense alpine terrain does not fit in one Consumption
invocation, and no bound on the handler can change that — the bound only decides whether the
failure is clean and visible or a silent ten-minute kill loop.

### Subdivision: a tile that will not fit is replaced by its four children

A quadkey is a prefix code, so the four z10 tiles covering `120221203` are that string with `0`,
`1`, `2` and `3` appended, and `IngestTile` already stores `z`/`x`/`y` per row. Splitting therefore
needs no schema change and no new geometry — `childQuadkeys` in `packages/geo/src/tiles.ts` is the
whole of the maths.

```mermaid
stateDiagram-v2
  [*] --> running: claimed
  running --> ready: committed inside 540 s
  running --> pending: out of clock, z &lt; 11
  running --> failed: out of clock at z11, or Overpass unavailable
  pending --> pending: children outstanding
  pending --> ready: all four children ready
  note right of pending
    four child rows written at z+1,
    one ingest_tile job each
  end note
```

**Out of clock has two shapes and both split.** The commit loop can exhaust `deadlineAt`, which is
the failure the 2026-08-04 run measured; and the tile's own Overpass query can exhaust the Overpass
budget, in which case `processTile` never reaches the commit loop at all. Both mean the same thing —
this box cannot be served in one invocation — so both subdivide. Every other Overpass failure is
kept apart deliberately: a breaker that is open, a mirror answering 504 and a malformed query all
mean come back later, and subdividing on those would quadruple the load on a service already
refusing.

**Split on failure, not up front.** Pre-sizing every tile with an Overpass `out count` costs one
query per tile forever — measured at 3.2 s and one request for `120221203` — to save a wasted run on
the small minority that are dense. Deadline exhaustion is free and it is the exact signal: the tile
that could not be finished is the tile that has to be split. What a post-hoc split costs is one
ten-minute invocation per dense tile per TTL, and not even that is wasted, because every trail the
run committed before the clock ran out is already in `trails` and the children only re-upsert it.

**Splitting is a status, not a flag.** `splitTile` writes the four child rows, enqueues one
`ingest_tile` job each at viewport priority, and leaves the parent out of `readyTiles` while the
children run — `pending` for a parent with nothing to serve, and its existing `ready`/`empty` and
`fetchedAt` for one that was already serving trails, for the reason given four paragraphs down. What
it never writes is `failed`, because a split is no longer a failure. Admission control is
deliberately not consulted: this is ground already admitted and already paid for, and a refusal here
would strand a parent with no children and no route to ready.

**A parent is ready only when every descendant is.** `rollUp` takes the four child rows and returns
the parent's row or null; it returns null unless all four exist and all four are `ready` or `empty`.
`fetchedAt` is the _oldest_ child's, so the parent leaves the TTL when its stalest quarter does —
taking the freshest would let one child refreshed yesterday hold three stale ones out of the refresh
sweep for another month. `trailCount` sums. A parent whose children are all `empty` is `empty`; one
child with trails in it makes the parent `ready`, because that is a place worth re-querying.

**Nothing in `coverage.ts` changed, and that is the design.** `ensureCoverage` still covers a
viewport with z9 quadkeys and still reads the z9 row, so `readyTiles`, `pendingTiles` and the TTL
all keep working with no knowledge of the split — precisely because the roll-up writes the answer
onto the z9 row. A parent being ingested for the first time reads `pending` while children are
outstanding, the client keeps polling, and the trails the finished children committed are already on
the map: `browse` selects by bounding box, not by tile status, so three-quarters done looks like
three-quarters of the map.

**A parent that was already serving trails keeps serving them.** `splitTile` preserves a
`ready`/`empty` status and its `fetchedAt` instead of writing `pending`. `ensureCoverage` classifies
a settled-but-stale tile as ready-and-refreshing and everything else as pending, so demoting a tile
that split on a TTL refresh would flip a reader from "here are your trails" back to "still loading"
for however long four children sit in the drain queue — which is not a length anybody is watching.
A parent with no `fetchedAt` has nothing to serve and still reads `pending`.

**That status is passed in, not read back, and the difference was a live bug.** `processTile` writes
`running` to the parent before it fetches, so a `splitTile` that re-read the row saw `running` for
every caller, decided the parent had never served anything, and wrote `pending` — on every
production path. It passed its unit test because the test called `splitTile` directly with a
hand-built `ready` row that `processTile` cannot produce. `previous` is now a required parameter and
`packages/ingest/test/pipeline.test.ts` proves the behaviour through `processTile` against a fake
that stores rows rather than replaying a fixed answer.

Because coverage is unchanged, a viewport over split ground keeps queueing the z9 parent. That path
is cheap and useful rather than wasteful: `processTile` sees four child rows, makes no Overpass call
at all, re-queues any child that is not fresh, and promotes the parent if it can. It is also how a
split tile refreshes — the parent goes stale when its oldest child does, `ensureCoverage` queues the
parent, and the parent re-queues exactly the stale children.

**Whether to re-queue a child is a question about its job, not about its tile.** `IngestTile.status`
reads `failed` both for a child thirty seconds from its next attempt and for one that has given up,
and `enqueue` clears `attempts` — so deciding on the tile row resets the backoff ladder of a child
that was already coming back, on every viewport poll, which is how a rate-limited tile becomes one
we hammer once per render. `failJob` writes the _job_ `queued` with a future `runAfter` while
attempts remain and `dead` only when they are gone, and that is what `queueStaleChildren` reads: a
`queued` or `running` child is left alone, anything else is enqueued.

**A `dead` child is revived, because nothing else can revive it.** `splitTile` enqueues each child
exactly once, `ensureCoverage` covers z9 alone (`coverBBox(bbox, INGEST_ZOOM)`), `JobKind.refresh_tile`
has no producer, and `reclaimExpiredJobs` does not touch a dead row. Skipping dead children — which
an earlier revision of this section described as deliberate — left a subtree that could never finish
and a z9 ancestor permanently `pending`, with no documented manual recovery. Reviving from the
parent's drain restores exactly the recovery a z9 tile had before subdivision, where a viewport poll
revived a dead job through `ensureCoverage`, and it is bounded the same way: the revived child gets a
five-attempt ladder, and while it is `queued` the next drain leaves it alone.

**Five failed attempts is still worth a human, and it is reported once.** `queueStaleChildren`
returns the revived-from-dead children as `exhausted`; `rollUpSplitTile` writes them to the parent's
`lastError` and logs `switchback-ingest-subtree-stuck` — but only when that message differs from what
the row already says. Edge-triggering is load-bearing rather than tidy: a blocked parent is `pending`,
so `ensureCoverage` re-queues it on every viewport poll and `explore.tsx` polls _because_ it is
pending, and the alert is `Count > 0` over fifteen minutes with `autoMitigate` off. A line per drain
would page every quarter of an hour for as long as anyone left that map open, on the same rule as the
genuine failure signal — which trains an operator to ignore the signal round 5 was convened to create.
`promoteFrom` nulls `lastError` when the roll-up lands, so the edge re-arms itself.

**The floor is a parameter and it fails honestly at the bottom.** `INGEST_SUBDIVIDE_MAX_ZOOM` is the
deepest zoom a tile may reach; at the floor a tile that still exhausts its budget is marked `failed`
and throws, exactly as before. Sixteen z11 tiles cover one z9, and each level quadruples the fixed
per-tile cost — a region lookup and a tile-wide waypoint query that a smaller box does not make
cheaper — so deeper than z11 the overhead, not the work, is what fills the invocation.

**It ships off, and turning it on takes two settings, not one.** `ingest.bicepparam` resolves
`ingestSubdivideMaxZoom` to `9` — subdivision disabled — and `ingestTrailIdentity` to `osm-id`,
unless the deploying shell exports otherwise. The two are coupled in code as well as in the
template: `subdivideMaxZoom` returns `INGEST_ZOOM` whenever `INGEST_TRAIL_IDENTITY` is not `claim`,
whatever the ceiling says, so the combination that cuts fresh seam while trail identity is still
`min(wayId)` cannot be reached by setting one variable.

**Both settings have to be set on the process that is actually draining.** In the resting
configuration `INGEST_QUEUE_DRIVER` is `postgres`, the Function App drops every signal it receives,
and Vercel owns the drain — so setting either variable on the Function App alone changes nothing.
Both are declared in `apps/web/src/env.ts` as well as in `ingest.bicep`, each defaulting to off, so a
value set on one side and not the other is a difference an operator can see rather than a flag that
appears to be on and is not. The zod entries also turn a mistyped value into a startup error instead
of a silent fallback, which is why they exist at all: `@switchback/ingest` reads both from
`process.env` itself.

**And `claim` needs a database privilege the flag cannot grant.** `resolveTrail` reads `TrailWay`
before it decides anything, so a runtime role without SELECT on `trail_ways` fails every trail in
every tile with `42501` rather than falling back. Check it before flipping, not after:

```bash
# Expect four `t`. Anything else and the flag will empty the tiles it touches.
psql -Atc "select has_table_privilege('sbapp','trail_ways','SELECT'),
                  has_table_privilege('sbapp','trail_ways','INSERT'),
                  has_table_privilege('sbapp','trail_slug_aliases','SELECT'),
                  has_table_privilege('sbapp','trail_slug_aliases','INSERT')"
```

`scripts/converge-runtime-grants.ts` is what keeps that true — the migrate job runs it after every
push and fails on any application table the runtime role cannot use.

**The ceiling stays at 9 even though the seam is fixed, and the reason is arithmetic rather than
correctness.** Every split observed in production ran out of clock in the _commit_ phase, never the
query: four `switchback-ingest-tile-split` events, all `"phase":"commit"`, having already assembled
989–2,160 trails. Dividing each tile's own measured commit rate by four puts every z10 child between
554 s and 2,306 s against a 540 s wall, so no child of any observed tile fits; at z11 the densest
still needs 577 s with nowhere left to split. Subdivision spends Overpass — the one resource under a
hard etiquette bound — 4× and 16× over to relieve DEM and database time, which is under none.

**Turning it off takes both processes, and it does not undo a split that has already happened.** The
full procedure, with what each control's rollback actually costs, is in _Rolling a control back_
below. The asymmetry worth stating here: an absent or unusable value resolves to `INGEST_ZOOM`, not
to the ceiling, and the committed parameter is `9`, so a forgotten `export` and a routine template
deploy both land on off. `ingestQueueDriver` has no default at all for the same reason and the
opposite polarity — both of its values are dangerous if guessed, whereas the only dangerous direction
here is _on_. Turning subdivision on for an experiment is therefore a hand-set app setting that the
next deploy revokes, which is the correct asymmetry.

**A split is a deferral and must not read as a success.** Before subdivision a tile that exhausted
its deadline threw, `drainJobs` recorded a failure, and the drain-failure alert armed. Now it
returns normally and `report()` logs `done`, so an operator would read 8/8 tiles succeeded while
two of them ingested nothing. `switchback-ingest-drain-failed` therefore has a third arm matching
`switchback-ingest-tile-split` and `switchback-ingest-subtree-stuck`.

That alert is scoped to `appi-switchback-ingest`, which is the Function App drainer. In the resting
configuration `INGEST_QUEUE_DRIVER` is `postgres`, so Vercel drains, and Vercel has no Application
Insights — `packages/api/src/routers/trails.ts` and `apps/web/app/api/cron/drain/route.ts` both send
the markers to `console` because there is nowhere else for them to go. Both subdivision flags are
declared in `apps/web/src/env.ts`, so subdivision _can_ be turned on for that drainer, and on that
drainer nothing is watching — including `switchback-ingest-subtree-stuck`, which is the
edge-triggered "five failures, a human is needed" signal. Enabling subdivision therefore means
either moving the drain to the worker first, or accepting that the split and stuck markers land only
in the Vercel log stream. There is no Vercel log drain in the estate or in any template.

**The split gate is unattempted work, not the clock.** `forEachConcurrent` visits every assembled
trail, so a tile is only short when the deadline _refused_ one — `processTile` counts
`IngestDeadlineError` separately from ordinary per-trail failures and splits on that count alone. A
tile whose last commit lands a millisecond past the wall is finished; splitting it would throw away
the `ready` write and queue four children over rows already in `trails`.

**Children wait for the backlog, and that is the pump's shape rather than subdivision's.** They are
enqueued at `SPLIT_PRIORITY` — level with a live viewport — but the pump only refills the broker
when fewer than `INGEST_PUMP_LOW_WATER` (4) messages are in flight, and at equal priority
`claimJobs` and the pump both order by `runAfter ASC`, so a child created now sorts behind every
tile already queued. With eight dense tiles ahead of it and one message worked at a time, a child
can wait the better part of an hour before its signal is published. Nothing is lost — the row is
durable and the parent stays `pending` — but "the tile splits" and "the tile is ready" are separated
by the queue, not by the split.

**Overpass budget.** A split z9 costs four tile queries, four waypoint queries and four region
lookups where it cost one of each, so roughly 4x for the tiles that split and nothing at all for the
tiles that do not. The 2-concurrent bound is untouched: children are ordinary jobs, the host takes
one message at a time, and the ceiling is the shared `OverpassClient`'s queue, not the number of
tiles in play.

**Boundary trails cost a duplicate fetch, not a duplicate row.** A way crossing a child seam is
returned by both children's bbox queries: `buildTileQuery` filters per statement and declares no
global `[bbox:]`, so Overpass returns each intersecting way whole to both tiles rather than clipped.
That shared way is what makes identity recoverable.

**A multi-way trail spanning a seam keeps one row, because `trail_ways` decides identity.**
`assembleTrails` still labels a standalone way-trail `Math.min(...line.wayIds)` over only the ways
that tile's query returned, so the same trail cut by a seam still arrives under two different labels
— ways 10/20/30/40 become `(way, 10)` in one child and `(way, 30)` in the other. What changed is that
the label is no longer the identity. Every commit claims its member ways in `trail_ways`, whose
primary key is the way id; the second tile's assembly finds its ways already claimed and resolves
onto the existing row instead of creating a second one.

The two fragments overlap rather than butt-join, so the halves are unioned geometrically —
`ST_LineMerge(ST_UnaryUnion(ST_Collect(…)))` in `mergeTrailGeometry` — and never concatenated.
Across the 269 fragmented pairs measurable in production today, concatenation overstates length by a
mean 4,358 m; on `Hastings Heritage Trail` it overstates by 13,138 m against a true union of 62,110 m.
The union happens before `elevateLine`, because every statistic, the elevation profile and each
waypoint's `distM` are derived from the coordinate array — a merge applied at the write would leave
all of them describing one fragment.

**A union that is still a MultiLineString is refused, and the whole resolution goes with it.** 53 of
those 269 pairs fork or do not touch, and `Trail.geom` is `geometry(LineString, 4326)`, so no single
line represents them. The assembly therefore keeps its own row, its own line and the member ways
nobody else holds, exactly as the `osm-id` default would give it — `resolveIdentity` returns the
unresolved fallback rather than the winner's id.

Adopting the winner on a refusal is what the earlier shape of this code did, and it is not a no-op:
the winner's stored line comes back unchanged, so the incoming arm is written nowhere, while its ways
are still claimed for the winner — after which no later ingest can restore it, because resolution
keeps finding those ways claimed and keeps refusing the same union. Standing down leaves that trail
fragmented across two rows, which is a worse corpus than one row but a strictly better one than a
trail that has been deleted with no way back. `packages/ingest/test/identity.db.test.ts` asserts both
halves against a real PostGIS: the arm's northern tip is on the arm's own line, and way `900005` is
claimed by the arm rather than by the ridge.

Where two rows already exist, the older wins and the younger is folded into it: reviews, photos,
activities, completions, list items, lifeline sessions and way claims are re-pointed. Two of those
carry a uniqueness that spans `trailId`, and a collision there is a duplicate rather than a loss — a
`(source, sourceId)` photo is the same upstream photograph attached to both halves, and a list must
not hold the merged trail twice — so the loser's row is dropped. Busyness buckets are a derived prior
recomputed from activity, so the losers' are dropped whole. A `Review` collision is none of those: it
is one person who reported both halves, and `canMergeTrails` refuses the entire merge rather than
delete either report. The retired slug is written to `trail_slug_aliases`, and `trails.bySlug` falls
back to it, so the public URL the loser was indexed under keeps answering.

Relation-derived trails never resolve through claims — a relation id is the same in every tile, so
`(osmType, osmId)` already identifies them — but they do claim their member ways, which is how a
way-assembly in a neighbouring tile learns to stand down rather than shadow the route. It stands down
only when it also carries the relation's name: both halves of the rule `assembleTrails` applies
inside one tile. A way a relation claims under a _different_ name — the Mist Trail inside the John
Muir Trail — is a trail in its own right, keeps its own row, and yields the contested way rather than
fighting for it on every ingest.

**The primary key on `trail_ways.wayId` is the concurrency control.** Two tiles racing for one way is
the expected case: `COMMIT_CONCURRENCY` is 6 inside each drainer and there are two drainers. The
loser's insert raises P2002, which unwinds the whole commit — not just the transaction, because the
line and every statistic derived from it were built on a resolution that is now stale — and the
retry re-reads the claims and adopts the row the winner created.

**The rollback is one setting, and it is a rollback of behaviour, not of state.** `osm-id` never
writes `trail_ways` or `trail_slug_aliases` and never reads `trail_ways`, so the default path
depends on neither table's contents. It does read `trail_slug_aliases` — `uniqueSlug` and
`trails.bySlug` both consult it in every mode, which is what keeps a retired URL answering after the
flag goes off — but both tolerate `P2021` and treat a missing table as no aliases, so a runtime that
reaches a database where the DDL has not been applied still ingests and still serves. That mattered
while Vercel Preview builds ran branch code against the production database; Preview no longer holds
a connection string, and `ci.yml`'s `migrate` job still only runs on a push to `master`, so the
tolerance is what covers the window between a merge and that job.
Setting the flag to `claim` needs no backfill: claims fill in as tiles re-ingest on the 30-day TTL,
and until a trail's ways are claimed it resolves exactly as it does today. Setting it back to
`osm-id` returns behaviour to the `(osmType, osmId)` upsert with `trail_ways` sitting unread.

What it does not do is un-merge: a merge that has already run has deleted the loser `Trail` row, and
no setting brings it back. The merge is built so that this costs nothing a reader wrote — everything
user-authored moves, and the one case that cannot move refuses the merge — but an operator turning
the flag off is stopping future merges, not reversing past ones. `trail_slug_aliases` is the residue
that says a merge happened, and `processTile` logs `identity resolved` per tile with a count for each
of `adopted`, `merged`, `refused-geometry`, `refused-review` and `yielded-to-relation`, so the
irreversible half is measurable while it is happening rather than only afterwards. Existing fragments
heal on their own as tiles re-ingest — no Overpass backfill run, no hours of mirror load.

**Observed in production, 2026-08-06**, and re-read from App Insights on 2026-08-07. Subdivision
fires, and the trace that says so is the one this round wired. Four dense alpine z9 tiles reached the
wall and split rather than failing. `appi-switchback-ingest` retains `traces` for 90 days, so this
table stops being reproducible after 2026-11-04 — the rows below are the record after that.

| tile        | at (UTC) | elapsed    | committed | unattempted | children      |
| ----------- | -------- | ---------- | --------- | ----------- | ------------- |
| `120230202` | 00:00:25 | 542,349 ms | 127       | 2,032       | `1202302020…` |
| `120230220` | 00:09:25 | 540,513 ms | 160       | 1,488       | `1202302200…` |
| `120230203` | 00:21:45 | 540,582 ms | 196       | 793         | `1202302030…` |
| `120230212` | 00:37:11 | 540,244 ms | 241       | 748         | `1202302120…` |

```
switchback-ingest-tile-split 120230202: ran out of clock with 2032 trail(s) unattempted
  {"phase":"commit","committed":127,"failed":2033,"refused":2032,
   "children":["1202302020","1202302021","1202302022","1202302023"],"fetchMs":542349}
```

All four are the commit-loop shape: the tile query returned, the deadline refused the rest,
`refused > 0` selected the split, and each invocation returned normally between 540,244 ms and
542,349 ms against a 540,000 ms budget — inside the host's 600,000 ms, which is what round 5 bought.
Two thousand unattempted trails is the size of the problem stated plainly: these boxes are an order
of magnitude past what one invocation can commit. Overpass was healthy throughout: no 429, no
`Retry-After`, no breaker trip in `traces` between 23:00Z and 00:45Z, and `ingest-jobs` held 0
dead-lettered messages.

**No child ran, and the reason is the queue rather than the split.** Children are enqueued at
`SPLIT_PRIORITY`, level with a live viewport, but `claimJobs` and the pump break a priority tie on
`runAfter ASC` — so a child created at 00:00 sorts behind every tile queued before it, and the
alpine backlog ahead of these was itself made of nine-minute tiles. Twenty-four z10 rows across six
parents were `pending` with durable jobs behind them; none was ever claimed. **So the chain is
proven as far as the split and no further: no `done` at z10, no roll-up, and no z9 that
`trails.browse` calls ready because it subdivided.** The deepest zoom reached is z10, as rows, not as
work.

**Earlier rounds' account of this is now settled, and both halves of it were wrong.** Round 1 said
`splitTile` was never reached; a reviewer said subdivision had fired twice on 2026-08-05. Neither was
supported then and neither is now: the 2026-08-05 over-deadline invocations logged `done` with no
token, and the token could not have been emitted because `PipelineDeps.logger` was set on no deployed
path. What is known is what is above — the first observed split in this system is 2026-08-06T00:00:25Z.

**The seam baseline, measured against the tiles that actually split.** Re-taken 2026-08-07. It is
still a true "before": no tile below z9 exists, no trail is owned by a quadkey longer than nine
characters, and neither parent has a `fetchedAt`, so nothing beneath either tile has ever ingested.

| tile        | trails | distinct names | way / relation | total `lengthM` |
| ----------- | ------ | -------------- | -------------- | --------------- |
| `120230203` | 477    | 425            | 289 / 188      | 2,901,784       |
| `120230212` | 232    | 231            | 6 / 226        | 2,644,035       |

Two names already span the seam between those two tiles. Corpus-wide, 503 way-trails — 1.1% of
47,279 — have a same-name way-trail in another quadkey whose line comes within 50 m of their own.
That proximity test is the point: a shared name alone puts 6,296 rows (13.3%) in the set, and most of
those are unrelated "Ridge Trail"s in different ranges that share no way and no claim table will ever
merge. `scripts/baseline-228.sql` reports both figures side by side, the second labelled as the upper
bound it is; the 50 m predicate is the one `scripts/verify-merge.sql` uses to select the pairs the
merge primitive was measured on. Re-run it to watch the first number fall as tiles re-ingest.

**Direct Postgres is reachable from a maintainer workstation with ProtonVPN disconnected**, using an
Entra access token as the password — `scripts/pgenv.sh` assembles the session and never prints the
token. The earlier finding that only HTTPS egress was permitted described the sandbox of the day, not
the server.

**How this was run before the branch was merged, and what it cost.** The worker is deployed from a
zip, so it can carry this branch's `processTile` while Vercel still serves `master`. Setting
`INGEST_QUEUE_DRIVER=servicebus` on the worker alone therefore gets subdivision into production
without a merge — but it leaves two drainers on one `ingest_jobs` table, because `master` has no
such flag. That is survivable for a bounded experiment and wrong as a resting state:

- `claimJobs` uses `FOR UPDATE SKIP LOCKED`, so the two never work the same row.
- `master`'s inline drain is scoped to `coverage.queued`, which is `coverBBox(bbox, INGEST_ZOOM)` —
  z9 keys only. It structurally cannot claim a z10 child, which is what makes the arrangement safe
  enough to try. `master`'s daily `/api/cron/drain` at 04:17 UTC is not scoped and can.
- The Overpass ceiling during the window is 2 per drainer, not 2 overall.
- Reviving one of the six failed tiles needs `ensureCoverage`, which only `trails.browse` reaches —
  and the same request kicks `master`'s inline drain, which claims the tile for the full 30-minute
  `LEASE_TIMEOUT_MS` and dies at Vercel's function limit with nothing written. The tile is then
  invisible until `reclaimExpiredJobs`. Budget half an hour for that before the worker sees it.

Merging removes all four, which is the argument for merging before the next run rather than a reason
the run cannot happen.

**Live production state, 2026-08-06.** `INGEST_QUEUE_DRIVER` is back to `postgres` and
`INGEST_SUBDIVIDE_MAX_ZOOM` back to `9` on the worker: the worker drops every signal it receives,
Vercel owns the drain, and no further tile can split. Six z9 tiles had split — `031313112`,
`120221231`, `120230202`, `120230203`, `120230212` and `120230220` — leaving twenty-four z10 child
rows and twenty-four queued `ingest_tile` jobs.

**Those children are retired, not finished, and the reason is the arithmetic above.** None had ever
run: every row was `pending` with `fetchedAt` NULL, `attempts` 0 and `trailCount` 0, and no trail in
the corpus was ever owned by a z10 quadkey. They could not have finished either — each sits between
554 s and 2,306 s of commit work against a 540 s wall — and nothing would have rolled them up, since
the ceiling stays at `9`. Leaving twenty-four claimable jobs pointed at work that cannot complete
spends Overpass, which is the one budget under a hard etiquette bound. `scripts/retire-244.sql`
deletes them in one transaction, guarded on the never-ingested predicate so a child that had really
run would survive and show up in the after-count. The six parents keep their own rows and their own
jobs, and `childTiles` now reports zero for each, so each re-fetches at z9 exactly as it did before
subdivision existed.

Two residues are left deliberately, because neither is debris subdivision created and repairing
production state by hand is not a rollback anybody could audit. `120230212`'s tile row is `pending`
while its `ingest_tile` job is `done`; it predates the splits. And three of the six parents —
`120221231`, `120230202`, `120230203` — read `running` with `fetchedAt` NULL and no lease holder,
which is what a tile row looks like after an invocation was killed mid-write. Neither state is
visible to a reader: `isTileFresh` refuses `pending` and `running` alike, so both areas serve as cold
and are re-queried, which is the correct outcome for a tile that never finished. Until they are
re-attempted, what each of the six serves is every trail carrying its quadkey, accumulated over all
of its attempts — 38, 134, 119, 477, 232 and 158 for `031313112`, `120221231`, `120230202`,
`120230203`, `120230212` and `120230220`, read on 2026-08-07. The 127, 160, 196 and 241 in the split
table above are what each _split run_ committed before the wall, which is a smaller and different
number; do not read either as the other.

**Say "no scale-out", not "deployment-wide ceiling of 2".** `functionAppScaleLimit` caps how many
instances the scale controller adds; it does not stop Consumption _replacing_ an instance, and for a
few seconds around a recycle two host instances of the same app are alive. Telemetry from
2026-08-03T17:32 shows exactly that: `0--f7e39076-13` took sequence 1 at 17:32:00.884, `0--3f3e4037-7d`
logged "Starting Host" at 17:32:13.797 and took sequence 2 at 17:32:15.175. Nothing in the telemetry
proves the first instance's Overpass client had quiesced, so the honest ceiling during a recycle
window is 4, not 2. It is brief, it is not sustained, and Overpass's fair-use limit is about sustained
load — but the number to put in a review is "2 per instance, one instance except across a recycle".

The same trace exposes the cost of a mid-drain recycle, which is worth knowing before you see it: the
evicted instance never releases its message lock, so the message sits invisible for the full `PT5M`
`lockDuration` and then redelivers with `DeliveryCount 2` — and the `ingest_jobs` row it names is
still under the dead lease it took on the first attempt, so the redelivery logs "nothing claimable"
and the tile waits for `reclaimExpiredJobs`. That is a slower path than #172 promised, and it is the
argument for keeping the cron's `reclaimExpiredJobs` call on the `servicebus` branch rather than
skipping the cron entirely.

**Least privilege on the queue.** Three role assignments, all queue-scoped, all in the template: the
worker holds Data Sender and Data Receiver, and the publisher holds Data Sender alone. Data Owner
was the earlier choice because reading the queue depth looked like an administration operation — it
is, for `ServiceBusAdministrationClient`, but both data roles already carry the control-plane
`queues/read` action and ARM exposes `countDetails.activeMessageCount`, so the pump reads the depth
through ARM and the role is unnecessary. At queue scope Data Owner would have let the worker rewrite
or delete the queue it drains.

The publisher's asymmetry — Sender but not Receiver — is deliberate, and it is the answer to who can
drain the production ingest queue. `id-switchback-vercel-publisher` is the shared runtime identity
that every Vercel deployment carries, previews included, so a Receiver grant on it would reach all
of them over the same REST surface `packages/ingest/src/publish.ts` already uses to send. Assignment
`0090d328-0cee-592f-8359-e4cc64940694` was exactly that grant and was **revoked on 2026-08-08**,
with the resource-group lock lifted; the queue now carries three assignments. The declaration
mattered as much as the assignment: incremental ARM does not delete what a template stops declaring,
but it does re-create what a template still names, so `ingest.bicep` had to stop declaring it too.
The worker is unaffected: its trigger binding sets no `__clientId`, so the host receives as the
Function App's own system-assigned principal.

**Progress is polled, not streamed.** The client re-asks `browse` every 2.5 s while tiles are
outstanding. An SSE stream was the plan; with a twelve-tile cap it would cost a long-lived connection
and a held-open function per open map to carry a few messages. Revisit past hundreds of tiles.

**Long-distance routes bypass tiles.** A bbox query never recurses into member relations, so no tile
can see the Pacific Crest Trail itself — only its sections, each committed under its own name and
length. `processRoute` walks the `type=superroute` hierarchy by id, flattens it in declared order and
hands the members to the same assembler.

## Deploying the ingest worker

**The Function App's code arrives by a path outside `infra/azure/ingest.bicep`, and that is
deliberate.** `WEBSITE_RUN_FROM_PACKAGE` is what Linux Consumption runs from, and an ARM
application-settings write replaces the collection whole — so a template that declared it would
fight the package push, and a template that does not declare it erases whatever the last push wrote.
Both facts are load-bearing:

| Step | Command                                                                 | Why the order                                                                                                            |
| ---- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| 1    | `az deployment group create … --template-file infra/azure/ingest.bicep` | Writes the app settings, and in doing so removes `WEBSITE_RUN_FROM_PACKAGE`. The app is codeless from here until step 2. |
| 2    | `bash .github/scripts/deploy-worker.sh <bundle>.zip <commit>`           | Uploads the package, points the setting at it, syncs the trigger cache, and waits for a heartbeat naming `<commit>`.     |

Step 2 alone is the routine case; step 1 is only needed when the template changes.

**Step 2 uploads the blob itself rather than calling `az functionapp deployment source config-zip`.**
That command chooses between the blob path and a Kudu `/api/zipdeploy` by reading the plan to see
whether it is Consumption, inside a bare `except:`. The deploy identity is Website Contributor on the
_site_, which does not carry read on the plan resource, so the lookup fails, is swallowed, and the
app is treated as non-Consumption — and the Kudu fallback is refused with **409**, because a site
already running from an external package URL cannot also be extracted into. The command succeeds for
an operator who can read the plan and fails for CI, which is how a deploy path that only a
workstation had ever exercised came to look sound.

**Nothing in the setting is a credential.** `config-zip` writes a SAS with a 520-week expiry; the
script writes a bare `https://…/function-releases/<commit>-<utc>.zip` and the host authenticates with
its own system-assigned identity, which `ingest.bicep` grants Storage Blob Data Reader on that
container. This is the mechanism Microsoft documents for external package URLs and recommends over a
SAS, and it is what lets the deploy log name the package it just shipped.

**Nothing in the storage account is a credential either.** `allowSharedKeyAccess` is `false`, so the
two account keys authorise no data-plane request whatever their value — `az storage blob list
--auth-mode key` answers `Key based authentication is not permitted on this storage account`. The
host reads its own leases, keys and diagnostics through `AzureWebJobsStorage__blobServiceUri`,
`__queueServiceUri`, `__tableServiceUri` and `__credential=managedidentity`, backed by Storage Blob
Data Owner and Storage Table Data Contributor at account scope. Owner reaches `function-releases`
as well as the host's own containers, which means the worker's identity can rewrite the package it
runs from; that is not a new way in, because the token is only obtainable from inside the app, and
the alternative it replaces was an account key sitting in an application setting. Separating host
storage from the release container into two accounts is what would remove the residue.

The Azure Files content share went with the key: Azure Files has no identity-based connection, so
`WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` is a key by construction. Linux Consumption does not need
it — the content root is the package URL. Windows Consumption and Elastic Premium do, and could not
make this trade.

**The script does not trust its own exit codes.** An exit code says a blob was uploaded, which is a
statement about the deploy and not about the host — and a package setting that still names last
month's blob passes every check built from exit codes alone. So it asserts three independent things
and fails on any: the uploaded blob is the same length as the bundle on disk, the live setting names
that blob, and `switchback-ingest-queue-health build=<commit>` appears in Application Insights with a
timestamp after the push began. The last is behaviour, not a version string: that line is emitted
by the first statement of the `ingestPump` handler, on a two-minute timer, ahead of the
`INGEST_QUEUE_DRIVER` guard, and the commit in it is substituted into the bundle by
`apps/ingest-worker/scripts/bundle.ts`, so it travels inside the zip. A bare marker would have been
weaker than it looks: from the second deploy onward any build already carrying the current
`health.ts` satisfies one, so a package that failed to mount would pass on the previous build's
telemetry. An application setting would have been weaker still — it survives a package that never
loaded.

**`ci.yml`'s `deploy ingest worker` job is what will run that script on every push to master**,
under `id-switchback-worker-deploy` — Website Contributor on the one site, Monitoring Reader on the
one Application Insights component, federated to `refs/heads/master` only. If either of the two
repository variables it needs is unset the job **fails rather than skips**, because a deploy job
that silently skips is exactly the failure it exists to prevent wearing a green tick.

It has not run yet, and saying so matters: the job is gated on pushes to master and this branch is
not master, so the first execution is the merge. What has been exercised is everything a branch can
exercise — the script itself, run by hand against production, and the federated credential's
subject, which `.github/scripts/assert-oidc-subject.sh` compares against a freshly minted token on
every push including this one.

**The credential's subject is not `repo:<owner>/<repo>`.** GitHub issues an immutable subject built
from numeric account and repository ids — `gh api repos/<owner>/<repo>/actions/oidc/customization/sub`
returns the prefix — and a federated credential written against the human-readable form matches
nothing, failing `azure/login` with AADSTS70021. The suffix is the job's to determine: naming a
GitHub `environment` replaces `:ref:refs/heads/master` with `:environment:<name>`, so `worker-deploy`
deliberately declares none. `infra/azure/ingest.bicep` carries the prefix as a parameter and the
check above reads it back out of that file, so the template and the token cannot drift apart
unobserved.

**The trigger sync is not optional.** After the package changes, a Consumption app whose scale
controller still holds the old trigger set comes back reporting `0 functions loaded`,
`az functionapp function list` returns nothing, and a restart does not fix it — there is no trigger
left to scale on.

## Rolling a control back

Three environment variables change what ingest does. **All three are read by two processes** — the
Vercel deployment and the Function App — because `@switchback/ingest` reads `process.env` and both
runtimes load it. Setting one on the Function App alone changes nothing while `INGEST_QUEUE_DRIVER`
is `postgres`, because then Vercel owns the drain. Every rollback below therefore names both sides.

Two of the three are **not fully reversible**, and the table says which part is not. Reversing the
setting is never the same as reversing what happened while it was on.

| Control                     | Setting rolls back         | What does not roll back                                                                                                                         | Reversal for that                                                                                                                          |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `INGEST_QUEUE_DRIVER`       | fully                      | nothing                                                                                                                                         | —                                                                                                                                          |
| `INGEST_SUBDIVIDE_MAX_ZOOM` | new splits only            | a tile already split never fetches again — `processTile` routes any tile with four children to the roll-up with no flag to read                 | `npm run ingest:unsplit -- <quadkey>`, which restores the pre-split state including its failure — read the outcome below before running it |
| `INGEST_TRAIL_IDENTITY`     | new claims and merges only | a merge is permanent: the losing trail's row is gone and its reviews, activities, lifeline sessions and photographs are repointed at the winner | none — the retired slug keeps answering through `trail_slug_aliases`, which `trails.bySlug` and `uniqueSlug` both read in every mode       |

### Before any of them: the Vercel CLI has to be pointed at the project

`vercel env ls`, `env add`, `env rm` and `redeploy` all fail with
`Your codebase isn't linked to a project on Vercel` from a fresh checkout, and that failure is loud.
`vercel ls` is the exception — it reads the whole team scope and works unlinked. Link once, from
anywhere:

```bash
npm i -g vercel && vercel login
vercel link --yes --project switchback
```

Every `vercel` invocation in this section is written for the flags available in **CLI 54.1.0**, the
version these were exercised against. Newer releases add shorthands that older ones reject —
`vercel ls --limit 1 --json` is one, and it errors with `unknown or unexpected option` here — so the
checks use the plain `--environment` form, whose newest row carries the `Age` the verification
turns on.

### And for `npm run ingest:unsplit`: a `DATABASE_URL` with no password in it

`npm run ingest:unsplit` is the one command here that reaches Postgres rather than a control plane,
and the only one that needs `DATABASE_URL`. `DATABASE_AUTH=entra` is what makes that URL
credential-free: `entraPoolConfig` in `packages/db/src/entra-pool.ts` refuses a `DATABASE_URL` that
carries a password, and `DefaultAzureCredential` supplies an access token from your `az login` at
connect time instead. There is no stored secret to fetch, and no token is placed in the URL or in
your shell history.

```bash
# From a fresh clone, once: npm ci && npm run db:generate
az login

export DATABASE_AUTH=entra
db_user="$(node -p 'encodeURIComponent(process.argv[1])' \
  "$(az ad signed-in-user show --query userPrincipalName -o tsv)")"
export DATABASE_URL="postgresql://${db_user}@psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com:5432/switchback?sslmode=verify-full"
```

The username is your own UPN, percent-encoded. The database role's _name_ is the UPN — Azure matches
the token to the role by object id, but `pg` sends the name — and a guest account's carries `#EXT#@`,
either character of which ends the authority component early if it goes in raw. `sslmode=verify-full`
is honoured on this path by `pg` against Node's own trust store, so the `PGSSLROOTCERT` a libpq
client needs has no part in it. An exported `DATABASE_URL` wins over any `.env` in the working tree,
which `--env-file-if-exists` would otherwise supply.

Disconnect ProtonVPN first: its `ProTUN` adapter lets the TCP connection establish and then tears the
Postgres session down, which reads as a rejected credential. That and the rest of the break-glass
diagnosis — in `PG*` form, for `psql` and `pg_dump` — are in
[infra/azure/README.md](../infra/azure/README.md#connecting-by-hand-with-no-password).

### `INGEST_QUEUE_DRIVER` → `postgres`

Worker first, Vercel second. Reversing that order has both sides draining `ingest_jobs` at once. The
five steps and the reasoning are in the **At 3am** block under _Which queue drives it_ above, and the
check that matters is the same one the other two controls use: `vercel ls --environment production`,
because writing the variable is not the same as running a deployment built from it. Stopping at the
write leaves nothing draining while `vercel env ls` reports success.

### `INGEST_SUBDIVIDE_MAX_ZOOM` → `9`

```bash
# 1. Vercel, both environments — this is the side that drains, so this is the side that splits.
vercel env rm INGEST_SUBDIVIDE_MAX_ZOOM production --yes
vercel env rm INGEST_SUBDIVIDE_MAX_ZOOM preview --yes

# 2. Promote a deployment built without it. Vercel binds environment variables at build time, so
#    until this lands the running deployment still splits under the old ceiling. Takes minutes.
vercel redeploy switchback-three.vercel.app --target production

# 3. The Function App, which honours it whenever INGEST_QUEUE_DRIVER is servicebus.
az functionapp config appsettings set -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri --settings INGEST_SUBDIVIDE_MAX_ZOOM=9 -o none

# 4. Verify all three. The first two are separate questions and the second is the load-bearing one:
#    `env ls` reads the project's variable set, which step 1 already emptied, so it reports success
#    whether or not any deployment carrying the change exists.
vercel env ls production | grep INGEST_SUBDIVIDE_MAX_ZOOM   # expect no output
vercel ls --environment production                          # newest row's Age younger than step 1
az functionapp config appsettings list -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri \
  --query "[?name=='INGEST_SUBDIVIDE_MAX_ZOOM'].value | [0]" -o tsv                # expect 9
```

Removing the Vercel variable rather than setting it to `9` is deliberate: an absent value resolves to
`INGEST_ZOOM`, so the two spellings mean the same thing and the absent one cannot be misread as a
ceiling somebody chose.

**Tiles already split stay split.** To put one back, delete its subtree and clear its marker in the
same operation:

```bash
npm run ingest:unsplit -- 120230202
```

**What this gets you is the pre-subdivision state, including the pre-subdivision breakage — say it
out loud before running it.** The tiles this exists for are by construction too dense for one
invocation: the four that split in production refused 2,032, 1,488, 793 and 748 trails unattempted
against 127, 160, 196 and 241 committed. Unsplit one with the ceiling down and the re-queued parent
takes the ordinary fetch path, runs out of clock exactly as it did before, and
`processTile` writes it `failed` and throws `IngestDeadlineError` — consuming the retry ladder until
the row is `dead`. The subtree's rows are gone and an area that was rolling up to `ready` no longer
serves as `ready`. Failing is what a too-dense z9 did before subdivision existed; this restores that,
not a working tile. Run it when a split itself is the problem, not when the split area is.

**Run it after the ceiling is actually down, not before.** `unsplitTile` re-queues the parent, and
`processTile` routes on child count — so a parent with its subtree removed takes the ordinary fetch
path and `canSubdivide` splits it straight back if the drainer is still on the old value. That is
what step 2 above is for, and why step 4 checks the deployment rather than the variable.

Doing that by hand is what wedges a tile: a parent whose `lastError` still starts `split into ` with
no children on the ground is a row claiming a subdivision that is not there, and only
`reconcileOrphanedSplits` — which runs off request traffic and the daily cron — repairs it, on its
own schedule rather than yours. `unsplitTile` does both halves in one transaction, and it takes the
same advisory lock the drain holds, so a descendant job cannot start between the check and the
delete and write its tile row back afterwards. It refuses outright while one is already `running`;
wait out the lease (30 minutes at most) and run it again.

### `INGEST_TRAIL_IDENTITY` → `osm-id`

```bash
# 1. Vercel. Production carries the variable; Preview does not, and `env rm` on an absent name
#    exits non-zero — check before removing rather than removing blind.
vercel env ls production | grep INGEST_TRAIL_IDENTITY && \
  vercel env rm INGEST_TRAIL_IDENTITY production --yes

# 2. Promote a deployment built without it, or merges continue on the running one.
vercel redeploy switchback-three.vercel.app --target production

# 3. The Function App. `ingest.bicep` declares this setting explicitly, so set it rather than
#    delete it — a deleted setting is re-asserted as `osm-id` by the next template deploy, and the
#    two states would otherwise read as drift.
az functionapp config appsettings set -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri --settings INGEST_TRAIL_IDENTITY=osm-id -o none

# 4. Verify. Anything other than the exact string `claim` is osm-id, but say it explicitly.
vercel env ls production | grep INGEST_TRAIL_IDENTITY       # expect no output
vercel ls --environment production                          # newest row's Age younger than step 1
az functionapp config appsettings list -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri \
  --query "[?name=='INGEST_TRAIL_IDENTITY'].value | [0]" -o tsv                     # expect osm-id
```

This also drops `INGEST_SUBDIVIDE_MAX_ZOOM` to `INGEST_ZOOM` wherever it is set, because
`subdivideMaxZoom` clamps to `INGEST_ZOOM` unless identity is `claim` — the two cannot be flipped
independently into the combination that cuts fresh seam under `min(wayId)` identity.

**Merges are not undone.** `mergeTrails` deletes the losing trail row after moving its user content
to the winner, so there is nothing to restore from. What survives the rollback is the retired public
URL: `trails.bySlug` falls through to `trail_slug_aliases` on every identity mode, and `uniqueSlug`
consults the same table on every mode before handing a slug to a different trail. Gating either read
on the flag — which both were — would have made the rollback strictly worse for readers than never
flipping it: every merge kept, every redirect withdrawn, and a retired URL free to be taken by an
unrelated trail on the next ingest.

**Recovering a merge needs the backup.** `psql-switchback-prod-37ywppu5p7fri` carries 14 days of
point-in-time retention (LRS), restored to a _new_ server; there is no in-place undo. That is the
whole procedure that exists, and it is a data-recovery exercise, not a flag flip.

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

### Where it all runs

![Switchback production estate: deployment boundaries, the credentials that cross them, and the absent network boundary](diagrams/estate.svg)

The boundary to notice is the one that is not there. Nothing in Azure sits on a virtual network:
`publicNetworkAccess` is Enabled and the Postgres firewall is a single rule spanning all of IPv4,
because Vercel serverless has no static egress address to allow-list. Identity and the credential
are the whole perimeter. `docs/diagrams/README.md` covers why that diagram is a committed SVG rather
than Mermaid.

### Who trusts whom

Solid edges are identity-based: the caller proves who it is and Entra issues a short-lived token.
Dashed edges are not. Two of the three carry the stored `sbapp` password; the third is a move not
yet made and carries no credential at all. `sbadmin`, which holds full DDL, is not drawn: it
reaches this server by password too, but the secret holding that password has no consumer left.

```mermaid
graph LR
  subgraph People
    OWNER[Owner<br/>Mazen, Entra user]
    READER[Signed-in reader]
  end
  subgraph Machines
    VERCEL[Vercel functions<br/>production and preview]
    FUNC[Function App<br/>system-assigned identity]
    RUNTIME[id-switchback-vercel-publisher<br/>shared runtime identity]
    CI[GitHub Actions<br/>id-switchback-postgres-ci]
    SP[Deploying service principal]
  end
  subgraph Azure
    SB[(Service Bus<br/>ingest-jobs)]
    PG[(Postgres<br/>switchback)]
    RG[Resource group<br/>rg-switchback-prod-northcentralus]
  end

  VERCEL -->|FIC, both environments| RUNTIME
  RUNTIME -->|Data Sender only<br/>Receiver revoked 2026-08-08| SB
  FUNC -->|Data Sender, Data Receiver| SB
  VERCEL -.->|sbapp password| PG
  FUNC -.->|sbapp password| PG
  RUNTIME -->|sbapp_vercel<br/>mapped, unused, renamed on cutover| PG
  FUNC -->|sbapp_func<br/>mapped, ready, awaiting databaseAuth=entra| PG
  CI -->|Entra administrator<br/>ci.yml migrate, postgres-entra.yml| PG
  OWNER -->|Entra administrator| PG
  OWNER -->|Owner| RG
  SP -->|Contributor| RG
  READER -->|session cookie| VERCEL
```

**One identity for every runtime client.** `id-switchback-vercel-publisher` is what Vercel
production, Vercel preview and the ingest worker are all intended to authenticate as — one
principal, one Postgres role, one grant set. Its two federated credentials distinguish the Vercel
environments to Entra and to nothing else: the access token carries the identity's object id, so
Postgres, Azure RBAC and every policy downstream see one caller. **That is the objection to this
design, and it is now sharper than when it was written.** Preview holds no connection string, so a
preview deployment cannot reach production Postgres today; consolidating onto this identity would
give it back, by being a preview deployment rather than by holding a secret. The consolidation also
removes the ability to revoke one consumer without the others. The two roles it replaces hold
identical privileges, so nothing that was ever differentiated is lost in _privilege_; what is lost
there is attribution, and `application_name` is what restores it. Attribution, not a boundary: any
client can set it to anything.

**What does change is how the credential is obtained, and that is the part worth deciding on.**
A preview deployment used to reach production Postgres by holding a secret — `DATABASE_URL`
carrying `sbapp`'s password, scoped by Vercel to the Preview environment. That variable is gone.
After the cutover it would reach production by being a preview deployment: the OIDC assertion is
injected by the platform as the `x-vercel-oidc-token` request header, not as an environment
variable, so it is **not** subject to Vercel's env-var scoping, and the other three inputs — client
id `cd074036-4c63-4d1e-8ebb-72f448bb95a2`,
the tenant id and the server hostname — are public identifiers that appear in this repository. The
failure scenario therefore changes shape rather than size: an actor who gets attacker-controlled
code into any preview deployment no longer needs to extract a scoped secret to read and write
production rows. Whether a fork's pull request can produce such a deployment depends on the Vercel
project's `gitForkProtection` setting, which is **UNVERIFIED** here — the API returned 403 to the
token available.

**The cheapest mitigation, if that is judged unacceptable: move the preview credential, not the
architecture.** Delete the `vercel-switchback-preview` federated credential from this identity and
place it on a second UAMI with its own Postgres role — `SELECT`-only, or its own database. That is
one identity, one credential move and one role, and it costs nothing per month. It deliberately
re-opens the multiplicity this change exists to remove, so it is worth doing only on its own merits.
The cheaper half, worth doing regardless, is to stop preview pointing at the production database at
all; that is a decision this change does not make, because folding it in would let a real question
ride along unexamined. What is **not** a mitigation, in principle rather than in practice: no
Postgres role, `pg_hba` entry or RLS predicate can tell the two Vercel environments apart, because
the FIC subject does not survive the token exchange — only the identity's object id does. Entra's
sign-in logs can, which makes it forensics, not enforcement.

**The consolidation is declared, not yet performed, and the diagram says so.** What is deployed is
the identity and its two federated credentials. What is not:

- `sbapp_runtime` does not exist. Read from the live catalog on 2026-08-06 as the owner's Entra
  administrator, `pg_roles` holds `sbapp`, `sbapp_func`, `sbapp_vercel` and `sbadmin`, and
  `pgaadauth_list_principals` maps `sbapp_vercel` to `c9bfba39-…` and `sbapp_func` to
  `3db30cfd-…` — the two-role topology this change replaces. `infra/postgres-identity/roles.sql`
  carries the `ALTER ROLE sbapp_vercel RENAME TO sbapp_runtime` that creates it, and that has run
  nowhere: the CI identity's federated credential trusts `refs/heads/master` alone, so the
  provisioning workflow cannot execute from a branch.
- The ingest worker still runs on its own system-assigned identity, `3db30cfd-…`, and holds both
  Service Bus grants under it. It also already has a working Entra path to Postgres: `sbapp_func` is
  mapped to that principal and is a member of `sbapp`, so removing the worker's password does not
  require moving it onto the shared identity.
- The shared identity's Data Receiver on `ingest-jobs` was **revoked on 2026-08-08** — assignment
  `0090d328-0cee-592f-8359-e4cc64940694`, deleted after lifting `switchback-prod-no-delete` and
  restoring it. It was standing authority to drain the production ingest queue on an identity every
  Vercel deployment carries, previews included. `ingest.bicep` no longer declares it, so no deploy
  recreates it; the identity keeps Data Sender (`f1b97f59-263a-5e18-a1c0-40ce18436d52`), which is
  what Vercel actually needs. Dropping the declaration mattered as much as deleting the assignment:
  incremental ARM does not delete what a template stops declaring, but it does re-create what a
  template still names.

  Worth keeping: a `CanNotDelete` lock on a resource group refuses `DELETE` on **extension**
  resources inside it, role assignments included. The refusal is `ScopeLocked` and it names the
  group, not the assignment, which reads like the wrong error until you know that.

The solid Postgres edges are drawn from the object ids on both ends rather than from the names,
because a role mapped to the wrong principal fails only at first use. `roles.sql` asserts the
mapping against the live catalog after the rename rather than assuming the rename carried it.

Two things the diagram is meant to make obvious. The deploying service principal holds Contributor
at subscription scope and Role Based Access Control Administrator on the production resource group,
and neither reaches the database — it writes ARM, not rows. And the CI identity holds **no Azure
RBAC whatsoever**: its entire authority is the Postgres administrator grant, so a leak of it cannot
touch the resource group, the queue or the billing.

The second grant is unconditioned, which makes the deploying principal able to assign itself Owner
on that resource group. `infra/azure/main.bicepparam` measures it and says what constraining it
would take; the resource group's delete lock is a control against accident, not against this
principal.

`disableLocalAuth: true` on the Service Bus namespace and zero queue SAS rules are what make the
Service Bus edges solid. Postgres still has `passwordAuth: Enabled` because the two dashed edges are
real; see _What is left_ below.

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
- **Retire connections on a revocation budget, not a credential one.** `maxLifetimeSeconds` does
  **not** evict a connection that is currently checked out: pg-pool's timer moves the client to
  `_expired` and can only act in `release()`. Measured on the same harness — a connection held for
  2.5× its lifetime stayed open and was replaced only after it was released. `CONNECTION_LIFETIME_S`
  is 20 minutes, and what that number buys is a ceiling on how long a connection authenticated by a
  since-revoked identity keeps serving. With the firewall spanning the whole IPv4 internet, identity
  is the only boundary here, so that window is a security parameter.
- **Renew on the issuer's own hint, and never later than one handshake before expiry.** The renewal
  point is `refreshAfterTimestamp` — Entra's `refresh_in`, roughly half-life, which
  `@azure/identity` populates on both the client-assertion and managed-identity paths — bounded by
  `RENEW_MARGIN_MS`, which is `CLOCK_SKEW_MS + CONNECT_BUDGET_MS`, 5.5 minutes. The margin is that
  small because a session is not re-validated after connect (below), so it only has to cover the
  handshake plus skew.

  A larger margin would buy nothing, and this is the constraint that decides the design.
  `credential.getToken()` answers from MSAL's cache, and MSAL treats a token as expired only inside
  its own five-minute offset (`DEFAULT_TOKEN_RENEWAL_OFFSET_SEC`), so no request made earlier than
  that can return a fresher token than the one already held. Past `refresh_in` it refreshes in the
  background and returns the stale token meanwhile — which the cache detects by unchanged expiry and
  answers with a backoff rather than an alarm, because it is the normal path.

**Whether a session outlives its token: no, it is never re-checked.** Measured against the live
server, workflow run 31062754668. One connection polled every minute and one left idle both kept
serving 19.2 minutes past their token's expiry, on the same backend pid. Microsoft's documentation
speaks only about sign-in and does not answer this, so the measurement is the only evidence — and it
is load-bearing, because a margin sized for the handshake alone is only safe while it holds. Any
change to `RENEW_MARGIN_MS` needs it re-established.

Two failure modes are handled rather than assumed away. A renewal that fails serves the cached token
while it is still valid and suppresses the next attempt for `RENEW_RETRY_BACKOFF_MS`, so a
fast-failing Entra does not turn into one token request per connection — including once the cached
token is genuinely dead, which is the outage the backoff exists for. And a token served with less
life left than a connection attempt may take says so through `onTokenNearlyExpired`, which logs at
**error** level. That is a weaker control than it should be: only the Function App's logs reach an
Azure alert rule, so on Vercel and in CI the log line is the whole signal. It is unreachable on
either healthy path, which is what makes it worth reading — an earlier margin derived from
connection lifetime instead fired it 28 times per 12 hours against a 60-minute token while handing
out tokens with 9 minutes of life left.

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
asserted in both directions. Splitting it also means `sslmode` is finally honoured: the deployed
URLs have carried `verify-full` all along, but Prisma's engines understand only
`disable`/`prefer`/`require` for that key, so the value leaves them at their default. Under the
adapter it becomes a real `rejectUnauthorized` plus hostname check for the first time.

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
connection fails. A warm cache needs no assertion at all — the provider renews on the issuer's
`refresh_in`, roughly half-life, so a busy instance asks perhaps twice an hour — and the exposure
is a deployment whose _only_ traffic across a renewal is background work. Capturing each request's
header into a module-level holder closes even that, at the cost of holding a bearer token in
memory.

The identity Vercel presents is `id-switchback-vercel-publisher`, principal id `c9bfba39-…` — the
same one already trusted for Service Bus, and the one the `sbapp_vercel` database role carries
until the rename in _What is left_ makes it `sbapp_runtime`.

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

The refresh mechanism is proven at the pinned versions and both Prisma clients can be built on it,
but **no consumer has `DATABASE_AUTH` set**, so the path is password-authenticated end to end and
no Entra-authenticated Prisma query has ever run against production. Four things come off in this
order, each proved with passwords still enabled:

1. **The database role.** `sbapp_runtime` does not exist yet; `infra/postgres-identity/roles.sql`
   renames `sbapp_vercel` into it and then asserts the Entra security label survived the rename.
   That assertion is the gate, because the label follows the role's oid and a rename not carrying
   it would leave a role mapped to nothing — recoverable by the inverse rename, since nothing is
   dropped. It cannot run from a branch: the CI identity's federated credential trusts
   `refs/heads/master` alone, so this executes on merge.
2. **The Function App.** `databaseAuth: 'entra'` in `ingest.bicepparam`, and a `databaseUrl` naming
   `sbapp_func` with no password in it — `entraPoolConfig` refuses a URL that still carries one, so
   the half-done version fails at connect rather than quietly preferring the password. Nothing needs
   creating first: `sbapp_func` is Entra-mapped to this app's own **system-assigned** principal
   `3db30cfd-ea61-47ce-9b03-8b34ebc420b0` and is a member of `sbapp`, so it inherits the same table
   grants the password role has.

   **Do not move this app onto the shared identity to get there.** The trigger binding sets no
   `__clientId`, so the host receives Service Bus messages as whatever principal the site runs
   under; an app running as `id-switchback-vercel-publisher` would need Data Receiver on
   `ingest-jobs` put back on it — the grant that was revoked precisely because that identity rides
   on every Vercel preview. `ingest.bicep` declares the queue and its three role assignments. Two
   principals with two Postgres roles is the cheaper arrangement and it is what is deployed.

3. **Vercel.** `DATABASE_AUTH=entra-vercel`, plus `AZURE_TENANT_ID` and the client id of
   `id-switchback-vercel-publisher`. The code exists and has never run in a Vercel runtime; the
   cold-cache-outside-a-request risk above is real and unmitigated.
4. **CI.** `ci.yml`'s `migrate` job composes a connection string from a freshly minted token for
   `id-switchback-postgres-ci` rather than reading a stored password. That path has never
   executed — it fires only when `packages/db/prisma/` changes — so it is written but unproven,
   and proving it means a no-op schema commit while passwords still work. One thing will bite
   when it is tried: `prisma db push` then runs as a role that is not `sbadmin`, so new tables
   would be owned by it and `sbadmin`'s `ALTER DEFAULT PRIVILEGES` would not apply.
   `ALTER ROLE "id-switchback-postgres-ci" SET role = 'sbadmin'` is the cheap fix, and is untested.

`passwordAuth` is a parameter — `passwordAuthEnabled` in `main.bicep`, defaulting true — so the
flip is a reviewable deployment of its own rather than an edit to a template. It is gated on all
four of the above and on both administrator doors being re-proved in the same hour. Turning it off
first would lock the application out of its own database, and the way back is an ARM write that
itself authenticates against Entra.

The parameter also governs the admin password. `postgres.bicep` writes
`administratorLoginPassword` only when password authentication is on _and_ a value was supplied,
so a deployment that supplies nothing leaves the live credential untouched, and the flip ends with
no password in the deployment path at all.

One more thing, measured rather than suspected: **this repository is public.** Everything here is
readable by anyone, and a workflow artifact is downloadable by any authenticated GitHub user. That
is how a 371 MiB production dump — containing `sessions.sessionToken` and the `accounts` OAuth
tokens in plaintext, alongside real accounts and real GPS tracks — came to be published by run 31043403970. It was deleted on 2026-08-05, and the workflow that produced it is gone, but the
session and OAuth tokens it exposed should be treated as compromised. Whether this repository
should be public at all is an open owner decision, and every risk judgement in this document
assumes it is.

The certificate-verification gap that used to sit here is closed on two paths and open on one.
Under `DATABASE_AUTH=entra` the pool is given a real `rejectUnauthorized` and hostname check, and
CI's schema push gets `sslaccept=strict` alongside `sslmode=verify-full` from
`.github/scripts/pg-token-url.sh` — both parameters, because the two readers honour different
ones. `sslaccept=strict` is Prisma's half and is what verifies the chain and the hostname;
`sslmode=verify-full` is node-postgres's — the `pg.Client` that proves the token in the same job
reads it and verifies chain and hostname on it — and is inert for Prisma, whose engines understand
only `disable`/`prefer`/`require` for that key. In `password` mode Prisma still receives
`sslmode=verify-full` alone — a key it reads at a value it does not recognise, which leaves it at
the default — so until a consumer moves its TLS is unverified. Measured against Prisma 6.19.3 and
node-postgres 8.22.0; the full matrix is at the foot of `infra/azure/postgres.bicep`.

**Claim identity is writing, and one data condition is open. Measured against production
2026-08-08.**

`trail_ways` holds the claims; `trail_slug_aliases` is empty because no merge has retired a slug yet.
`sbapp` holds all four table privileges on both.

```sql
select relname, n_live_tup, n_tup_ins from pg_stat_user_tables
 where relname in ('trail_ways', 'trail_slug_aliases');
-- trail_ways          25238  26592     n_tup_ins exceeds the row count where a re-ingest re-claimed
-- trail_slug_aliases      0      0

select p, has_table_privilege('sbapp', 'trail_ways', p)
  from unnest(array['SELECT','INSERT','UPDATE','DELETE']) p;   -- t  t  t  t
```

**Those grants had to be placed explicitly, and the reason still binds for the next table.**
`ALTER DEFAULT PRIVILEGES` is registered per creating role, and the only registration in this
database is `FOR ROLE sbadmin`. The migrate job pushes as `id-switchback-postgres-ci`, so a table
arriving by that route is owned by it — `pg_tables` puts these two under that owner against 24 under
`sbadmin` — and inherits no grant at all. A table in that state is not merely unwritten: `resolveTrail`
reads `TrailWay` before it does anything else, so `42501 permission denied for table trail_ways`
unwinds the whole per-trail commit and the tile records as covered with nothing in it.
`scripts/converge-runtime-grants.ts` runs after every push, registers the missing default privileges,
grants over the tables already on the ground, and fails the job if any application table is short.

**102 groups — 204 trail rows — share byte-identical geometry**, by `md5(st_asbinary(geom))`, and 85
of those pairs are a relation against a way. Kibbie Lake Trail is one: way `162652736` and relation
`19086356`, same hash, same 634 points, both measuring 13,472.3 m geodesic, two live slugs both
serving 200. The stored `lengthM` disagrees across that pair — 13,473 on the relation, 13,064 on the
way — so the two pages a reader can open today differ by 409 m on a geometry that is the same bytes,
and the eventual backfill cannot take the stored column as its tiebreak. This is
exactly the duplication claim identity exists to prevent, and it predates that work — the rows were
written under `(osmType, osmId)` upserts, which cannot see that two ids describe one trail. With
`INGEST_TRAIL_IDENTITY` on `claim` no new pairs form; the existing ones are untouched, and merging
them needs a backfill that picks a winner per hash, moves user content onto it and retires the
loser's slug through `trail_slug_aliases`. Both tables are writable, so what blocks the backfill is
that nobody has written it.

`INGEST_TRAIL_IDENTITY` reads `claim` on the Function App and in Vercel **Production**, and is
**absent in Vercel Preview** — `identity.ts` resolves anything that is not exactly `claim`, absence
included, to `osm-id`. Preview carries no `DATABASE_URL`, so nothing there ingests and the asymmetry
changes no behaviour; it starts to matter the day Preview is given a database of its own.

| Surface      | Read it back with                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Function App | `az functionapp config appsettings list -g rg-switchback-prod-northcentralus -n func-switchback-ingest-37ywppu5p7fri -o json` |
| Vercel       | `vercel env pull` — **not** `vercel env ls`, which answers presence alone (see the runbook note on `--no-sensitive`)          |

**A deploy of `ingest.bicep` from a shell that has not exported the flag turns it off.**
`ingest.bicepparam` resolves `ingestTrailIdentity` through
`readEnvironmentVariable('INGEST_TRAIL_IDENTITY', 'osm-id')`, and an ARM application-settings write
replaces the collection whole. The fallback is deliberately the safe direction for subdivision — but
with identity now live, safe and current have diverged, and the export is a step in the deployment,
not an optional one.

**No workflow deploys `infra/azure/ingest.bicep`.** `infrastructure.yml` builds every template and
deploys only `main.bicep` and `runtime-identity.bicep`, so a change to the ingest template reaches
Azure on a human-run `az deployment group create` — and that deployment must be followed by
`.github/scripts/deploy-worker.sh`, because an ARM application-settings write erases
`WEBSITE_RUN_FROM_PACKAGE` and leaves the app codeless until the next package push.

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
