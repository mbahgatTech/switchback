# @switchback/ingest-worker

An Azure Functions app that drains `ingest_jobs`. A Service Bus message names one job by its
`dedupeKey`; the handler calls `drainIngest` from `@switchback/ingest`, which is the same code the
Vercel cron and the tRPC kick run. Nothing about the pipeline, the Overpass etiquette or the retry
policy is reimplemented here.

## The concurrency clamp

**`extensions.serviceBus.maxConcurrentCalls: 1` in `host.json` is the setting, and it is `1`
because one instance × one Node process × one shared `OverpassClient` at 2 concurrent = 2, which
is what the public Overpass instances allow.**

The full chain, so it can be checked rather than believed:

| Factor                        | Value | Where                                                |
| ----------------------------- | ----- | ---------------------------------------------------- |
| host instances                | 1     | `siteConfig.functionAppScaleLimit`                   |
| Node processes per instance   | 1     | `FUNCTIONS_WORKER_PROCESS_COUNT`                     |
| `OverpassClient`s per process | 1     | `getOverpass()` in `packages/ingest/src/config.ts`   |
| requests per client           | 2     | `OVERPASS_MAX_CONCURRENT`, unset or mistyped means 2 |

`test/drain.test.ts` reads all four out of `infra/azure/ingest.bicep` and asserts them, so the table
is checked rather than believed — the failure of any row costs the egress IP, not one invocation.

**Four rows about this app, which drains nothing while `INGEST_QUEUE_DRIVER` is `postgres`.** The
drainer that runs is Vercel, where every lambda is a process with its own client, so rows one to
three do not apply to it and row four bounds a fraction of it. `INGEST_MAX_DRAINERS = 1`, enforced
across processes by an advisory lock in `packages/ingest/src/drain-slot.ts`, is what makes the
fleet-wide figure true; `docs/architecture.md` is the one place that states it.

The first two rows are a template property and an app setting that this workspace does not own —
both live in `infra/azure/ingest.bicep`, alongside
`WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT: 1`. Changing either breaks the arithmetic, which is
why they are written down here next to the setting that assumes them.

Row one says "1" because `functionAppScaleLimit` stops the scale controller adding an instance for
load. It does not stop Consumption **replacing** one, and around a replacement two hosts run at
once with a client each — observed at 2026-08-03T17:32, where `0--f7e39076-13` took sequence 1 and
`0--3f3e4037-7d` started 13 s later and took sequence 2. So the number to quote is 2 sustained, up
to 4 for the seconds of a recycle. Overpass fair use is about sustained load, but a review that
reads "2, always" from this table would be reading something the configuration does not say.

The last two rows are the ones that actually hold. `maxConcurrentCalls` is documented as being
multiplied by the instance's core count, so a guarantee resting on it alone would rest on "a
Consumption instance is typically one CPU" — and it does not need to, because however many
invocations the host starts, they run in one process and share one client whose own queue is the
ceiling. `maxConcurrentCalls: 1` is set for separate and smaller reasons: one 10-30 s tile should
not compete with another for a 1.5 GB instance or for the ten-connection `backgroundPrisma` pool,
and `maxAutoLockRenewalDuration` does not apply to batched messages.

Two more settings exist only to stop something raising that number behind us.
`concurrency.dynamicConcurrencyEnabled: false`, because dynamic concurrency tunes
`maxConcurrentCalls` upward at runtime. `maxConcurrentSessions: 1`, because it is what takes over
from `maxConcurrentCalls` if the queue is ever given `requiresSession: true`.

`maxAutoLockRenewalDuration: 00:30:00` matches `LEASE_TIMEOUT_MS`, so the broker's lock and the
database's lease expire together rather than one silently first. `prefetchCount: 0` because a
prefetched message holds a lock nobody is renewing.

## What each outcome does to the message

**Job claimed and run** — the message completes.

**Nothing claimable**, because the tile is already ready, was superseded, is running elsewhere, or
a failure pushed `runAfter` into the future — the message completes and the reason is logged at
info. The row is the truth; a signal for work that no longer needs doing is not a failure, and it
costs one indexed statement that returns no rows.

**A handler threw** — the message still completes, logged at error. `drainJobs` has already caught
it, written `lastError` and taken the next `runAfter` from the backoff ladder. Throwing on to the
host would redeliver immediately, with no backoff to offer and a second `attempts` increment.

**The body cannot be read** — throws, and dead-letters after `maxDeliveryCount`. It will not parse
on a redelivery either, and completing it quietly would leave a job queued with nothing to wake
it.

**Postgres cannot be reached** — throws, and dead-letters after `maxDeliveryCount`. The one
genuinely retryable failure, and the reason a dead-lettered message means either that or a body
nobody can read. Both want a person.

**The tile is bigger than the deadline** — `INGEST_DEADLINE_MS` (540 s) strikes first and the tile
fails cleanly: terrain refuses to start a fetch, the commit loop refuses to start a trail,
`processTile` writes `failed` with the reason and throws, `drainJobs` records `lastError` and
releases the lease, and the message completes with the retry already scheduled. Sixty seconds of the
host's ten minutes are left over for whichever phase was mid-flight when it struck.

This is where a dense z9 tile ends up, and it ends up there every time. Flag on 2026-08-04T00:14Z
to 01:23Z, ten invocations, none killed, longest 543,653.9 ms against `functionTimeout` 600,000 ms:
five alpine tiles (`120221203`, `120221212`, `120221213`, `120221223`, `120213322`) each spent the
whole budget and failed, one of them exhausting the backoff ladder and being `retired`;
`120221232` and `031313103` finished at 448,188.0 ms and 347,561.9 ms. **The deadline decides
whether the failure is clean and audible, not whether the tile fits.** Making it fit means splitting
the tile — `INGEST_ZOOM` — and that is a data-shape change, not a timeout.

**The tile is bigger than `functionTimeout`** — what happened before that deadline existed, and the
failure it is for. The host kills the invocation at ten minutes and
the message redelivers. Seen in production on 2026-08-03: `ingest_tile:120221221` ran to
`Duration=600008ms`, preceded by Prisma `Transaction already closed` errors as individual trail
transactions expired under the load; then `120221230` at 612,947 ms and `120221203` at 615,938 ms,
with Overpass inside its own budget throughout — elevation had no per-request timeout and no budget,
and the instance was pinned at 99-100% CPU (`[HostMonitor] Host CPU threshold exceeded`) from 22:24
to 23:04 with `ingestPump` ticks of 19,901 ms and 57,939 ms competing in the same process. The
redelivery finds the `ingest_jobs` row still under the
lease the killed invocation took, logs "nothing claimable", and the tile waits for the lease sweep
— which is the same recovery path as an instance recycle.

**A host kill does not dead-letter, which is why it has an alert of its own.** The redelivery
_completes_ the
message (~165 ms), so `DeliveryCount` never climbs, nothing reaches `maxDeliveryCount`, and
`switchback-ingest-deadletter` — a `DeadletteredMessages` metric alert — structurally cannot fire
for it. The tile comes back on the lease sweep and is killed
again — an indefinite loop costing one wasted ten-minute invocation per turn. Two of five
tiles did this on 2026-08-03 with `deadLetterMessageCount` at 0 throughout, and the only signal was
`requests | where name == "ingestDrain" and success == false` in Application Insights, which nobody
was running. `switchback-ingest-drain-failed` in `infra/azure/ingest.bicep` is that query as a
scheduled query rule on `appi-switchback-ingest`: severity 2, same action group,
`autoMitigate: false`. `INGEST_DEADLINE_MS` should mean it never fires — which is the reason to keep
it, because a deadline that stops working looks exactly like this and nothing else would say so.

Nothing is passed over: `failed`, `deferred`, `lost`, `requeued` and `retired` each get their own
line, because `lost` — work that finished after its lease was given away — is recorded nowhere
else at all.

## The pump

Service Bus is FIFO and has no priority; `priority DESC, "runAfter" ASC` lives in `ingest_jobs`.
So a timer function re-derives the top of the queue every two minutes and publishes at most
`PUMP_QUEUE_DEPTH` signals, rather than publishing the backlog once and freezing its order for
weeks. It makes no Overpass request and so does not enter the arithmetic above.

`INGEST_PUMP_ENABLED=false` stops it within seconds and needs no deploy — the fast brake, next to
`az functionapp stop`. Messages already in flight still finish, because each one is idempotent.

`INGEST_QUEUE_DRIVER=postgres` is the other brake and a different one: it stands the whole worker
down, pump and trigger both, so a rollback that turns Vercel's inline drain back on does not leave
two drainers claiming from `ingest_jobs` at once. The trigger drops the messages it reads rather
than abandoning them — the row stays `queued` and Postgres runs the work — so nothing accumulates
in the dead-letter queue while the flag is off.

Two instances can disagree across the host restart, and the observed cutover did: the drain rejected
the flag from 23:04:52 (`INGEST_QUEUE_DRIVER is not servicebus - dropping the signal`) while a
surviving instance's pump published seven more signals at 23:06:08, about 74 s later. The drops are
safe. What is not free is re-flipping to `servicebus` inside ten minutes: the queue carries
`duplicateDetectionHistoryTimeWindow: PT10M` and the pump republishes the same `dedupeKey` as
`messageId`, so those republished signals are silently swallowed and the first tick after the
re-flip does nothing. The rows are still there and the next tick picks them up — but it looks like a
dead worker, so wait the window out or expect one empty tick.

## Configuration

| Setting                                         | Default       | Read by                                        |
| ----------------------------------------------- | ------------- | ---------------------------------------------- |
| `ServiceBusConnection__fullyQualifiedNamespace` | —             | the trigger, and `src/service-bus.ts`          |
| `SERVICE_BUS_QUEUE`                             | `ingest-jobs` | both                                           |
| `SERVICE_BUS_QUEUE_RESOURCE_ID`                 | —             | the pump, to read queue depth through ARM      |
| `INGEST_QUEUE_DRIVER`                           | `postgres`    | the pump and the trigger                       |
| `INGEST_PUMP_ENABLED`                           | `true`        | the pump                                       |
| `DATABASE_URL`                                  | —             | `backgroundPrisma`, as the web app connects    |
| `INGEST_DEADLINE_MS`                            | `540000`      | `runIngestSignal`, and every phase under it    |
| `INGEST_OVERPASS_DEADLINE_MS`                   | `300000`      | `runIngestSignal`, for the Overpass view only  |
| `OVERPASS_MAX_TOTAL_MS`                         | `240000`      | `getOverpass`, per query                       |
| `OVERPASS_MAX_CONCURRENT`                       | `2`           | `getOverpass`, per client                      |
| `INGEST_MAX_DRAINERS`                           | `1`           | `drainSlotGate`, per fleet                     |
| `OVERPASS_USER_AGENT`                           | —             | required — `OverpassClient` refuses without it |

Managed identity carries the Service Bus connection, and the grant is **Data Sender + Data
Receiver** on the queue — not Data Owner. Reading the depth is why Data Owner looked necessary;
`ServiceBusAdministrationClient` does need it, but both data roles already carry the control-plane
`queues/read` action, so `src/service-bus.ts` asks ARM for `countDetails` instead. At queue scope
Data Owner would also have allowed rewriting or deleting the queue.

Identity reaches Postgres too, and the door is already open. The server has `activeDirectoryAuth:
Enabled`, and role `sbapp_func` is Entra-mapped to this app's own system-assigned principal
`3db30cfd-ea61-47ce-9b03-8b34ebc420b0` and is a member of `sbapp`, so it inherits the table grants
the password role holds. The worker connects by password only because `DATABASE_AUTH` is unset.

Flipping it is **two application settings on this Function App and no write to the server**:
`databaseAuth: 'entra'` in `ingest.bicepparam`, which emits `DATABASE_AUTH=entra`, and a
`databaseUrl` naming `sbapp_func` with no password in it — `entraPoolConfig` refuses a URL that
still carries one, so a half-done flip fails at connect rather than quietly preferring the
password. Nothing is provisioned and no `Microsoft.DBforPostgreSQL` resource is touched, so the
server restart that enabling Entra authentication once required is not in this path.

## Building

`npm run build --workspace=@switchback/ingest-worker` writes `dist/`, which is the zip root:
`index.js`, `host.json`, a `package.json` naming only the runtime externals, `node_modules` from an
`--omit=dev` install, and the generated Prisma client copied out of the workspace's `node_modules`.
`npm run db:generate` must have run first.

**The install happens inside the build script, before the Prisma copy, and the order is not
cosmetic.** `--omit=dev` prunes anything `dist/package.json` does not declare; `@prisma/client`
cannot be declared, because npm would then fetch the published package over the generated one. Run
the install afterwards and npm deletes it — which is exactly what shipped once: the artefact carried
an empty `node_modules/@prisma/` (npm leaves `.prisma/` alone, being a dot-directory) and the host
logged `Cannot find module '@prisma/client'` then `0 functions found`. CI proves the fix against an
extracted copy of the real zip, in a directory with no `node_modules` above it, because the earlier
guard ran inside the monorepo and resolved every external from the workspace root.

## Not covered by the tests

`test/` exercises the message format, the outcome-to-broker mapping and the pump's planning,
against fakes. Everything needing a deployed namespace is untested here and belongs to the
end-to-end phase: that the trigger binds with an identity-based connection, that duplicate
detection collapses a re-published `messageId`, that lock auto-renewal holds a ten-minute tile,
that `maxDeliveryCount` dead-letters where expected, and that the scale limit holds under load.
