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

| Factor                        | Value | Where                                              |
| ----------------------------- | ----- | -------------------------------------------------- |
| host instances                | 1     | `siteConfig.functionAppScaleLimit`                 |
| Node processes per instance   | 1     | `FUNCTIONS_WORKER_PROCESS_COUNT`                   |
| `OverpassClient`s per process | 1     | `getOverpass()` in `packages/ingest/src/config.ts` |
| requests per client           | 2     | `OVERPASS_MAX_CONCURRENT`, unset means 2           |

The first two rows are a template property and an app setting that this workspace does not own —
both live in `infra/azure/ingest.bicep`, alongside
`WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT: 1`. Changing either breaks the arithmetic, which is
why they are written down here next to the setting that assumes them.

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

## Configuration

| Setting                                         | Default       | Read by                                        |
| ----------------------------------------------- | ------------- | ---------------------------------------------- |
| `ServiceBusConnection__fullyQualifiedNamespace` | —             | the trigger, and `src/service-bus.ts`          |
| `SERVICE_BUS_QUEUE`                             | `ingest-jobs` | both                                           |
| `INGEST_PUMP_ENABLED`                           | `true`        | the pump                                       |
| `DATABASE_URL`                                  | —             | `backgroundPrisma`, as the web app connects    |
| `OVERPASS_USER_AGENT`                           | —             | required — `OverpassClient` refuses without it |

Managed identity carries the Service Bus connection. It does **not** carry Postgres: the server
has `activeDirectoryAuth: Disabled`, and enabling it is a write to the server resource, which
rotates the admin password. `infra/azure/README.md` records what doing that deliberately would
take.

## Building

`npm run build --workspace=@switchback/ingest-worker` writes `dist/`, which is the zip root:
`index.js`, `host.json`, a `package.json` naming only the runtime externals, and the generated
Prisma client copied out of `node_modules`. `npm run db:generate` must have run first. The deploy
step installs the three `@azure/*` externals into `dist/` and zips it.

## Not covered by the tests

`test/` exercises the message format, the outcome-to-broker mapping and the pump's planning,
against fakes. Everything needing a deployed namespace is untested here and belongs to the
end-to-end phase: that the trigger binds with an identity-based connection, that duplicate
detection collapses a re-published `messageId`, that lock auto-renewal holds a ten-minute tile,
that `maxDeliveryCount` dead-letters where expected, and that the scale limit holds under load.
