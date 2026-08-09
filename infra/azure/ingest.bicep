// The ingest queue and the worker that drains it: Service Bus, a Consumption Function App, and
// the storage, telemetry and RBAC they need.
//
// **A separate template, at resource-group scope, on purpose.** It deploys into the resource
// group `main.bicep` already created and never declares the Postgres server, its database, its
// firewall rules or its parameters. `administratorLoginPassword` is `@secure()` with no default
// and ARM cannot read the current value back, so any deployment that includes `postgres.bicep`
// writes whatever it is handed. The live value is recorded outside the repository — see
// infra/azure/README.md, "Read this first" — but ARM cannot consult that record, so handing the
// wrong value to a template that declares the server rotates the production credential. Adding
// these resources to `main.bicep` would have made shipping a queue and rotating the production
// database password the same operation. This file cannot do that: `main.bicep` is not touched and
// is never redeployed by this work.
//
// It also declares no management lock. The group already carries `switchback-prod-no-delete`,
// placed from `main.bicep`; a lock resource here would need `Microsoft.Authorization/locks/write`
// on every run and stop a Contributor deploying anything at all. Locks do not block creates, so
// the existing one is no obstacle to this template.

targetScope = 'resourceGroup'

@description('Region for everything here. Same group, same region as the server.')
param location string = resourceGroup().location

@description('Prefix for the Service Bus namespace; the deployed name appends uniqueString(rg.id).')
param namespacePrefix string = 'sb-switchback-prod'

@description('The one queue. Also the value of SERVICE_BUS_QUEUE on both the publisher and the worker.')
param queueName string = 'ingest-jobs'

@description('Function App name prefix; the deployed name appends uniqueString(rg.id) for global uniqueness.')
param functionAppPrefix string = 'func-switchback-ingest'

@description('Existing workspace from monitoring.bicep. Referenced, never redeployed.')
param logAnalyticsWorkspaceName string = 'log-switchback-prod'

@description('Existing action group from monitoring.bicep. Referenced, never redeployed.')
param alertActionGroupName string = 'ag-switchback-prod'

@description('''
Postgres connection string for the worker, written to the Function App's application settings.

`@secure()` with no default so a deployment that forgets it fails loudly rather than publishing a
worker that cannot reach the database. Read from the environment in `ingest.bicepparam`, the same
shape `PGADMIN_PASSWORD` uses — see that file's header.

This is the application login, not the administrator. Under the deployed `databaseAuth='entra'` it
names `sbapp_func` and carries **no password**, so it is not a credential at all — `entraPoolConfig`
refuses a URL that still holds one. Under `databaseAuth='password'` it is the same secret string
Vercel holds, which is why the parameter is `@secure()` either way.
''')
@secure()
param databaseUrl string

@description('''
How the worker authenticates to Postgres. `password` reads `databaseUrl` as-is. `entra` — the
deployed value — emits `DATABASE_AUTH=entra`, which makes `packages/db/src/client.ts`
take a token from `DefaultAzureCredential` — the Function App's system-assigned identity — instead
of the password in the URL.

**Flipping this requires a `databaseUrl` with no password in it**, naming `sbapp_func`.
`entraPoolConfig` in `packages/db/src/entra-pool.ts` refuses a URL that still carries one, so the
mismatch fails at connect rather than silently preferring the password.

The role is already provisioned: `sbapp_func` is Entra-mapped to this app's system-assigned
principal `3db30cfd-ea61-47ce-9b03-8b34ebc420b0` and is a member of `sbapp`, so it inherits the same
table grants the password role has. The server already has `activeDirectoryAuth: Enabled`.

**The flip therefore writes two application settings on this Function App and nothing else.**
`DATABASE_AUTH` appears and `DATABASE_URL` changes; no `Microsoft.DBforPostgreSQL` resource is in
the change set, so neither the server restart that enabling Entra authentication costs nor any
handling of the administrator password is in this path.

**The deployed value is `entra`**, set 2026-08-08T17:27:04Z. `password` remains the parameter
default so that deploying this template from a shell that has not decided cannot silently move a
consumer; a rollback is the same one-word change in the other direction, and `passwordAuth` on the
server is still `Enabled`, so that door is open.
''')
@allowed(['password', 'entra'])
param databaseAuth string = 'password'

@description('''
Value of `OVERPASS_USER_AGENT`. Required, not defaulted, because `OverpassClient` throws on a blank
one — Overpass fair use asks that an automated client identify itself with a contact address, and a
worker that runs unattended is exactly the client that rule is about.
''')
param overpassUserAgent string

@description('Terrain tile URL template. Empty leaves the setting off and the code falls back to its default source.')
param terrainTileUrl string = ''

@description('Mapillary API token for photo enrichment. Empty leaves the setting off.')
@secure()
param mapillaryToken string = ''

@description('''
The package the Function App runs from, written to `WEBSITE_RUN_FROM_PACKAGE`.

**Declared here because an application-settings write replaces the collection whole.** Linux
Consumption mounts its code from this URL and `.github/scripts/deploy-worker.sh` writes it into the
same collection an ARM deployment replaces — so omitting it from the template left every deployment
that ran on its own with a codeless app until the next package push. Declaring it makes a
template-only deploy write back the URL that is already live.

No default, for the reason `ingestTrailIdentity` has none: a fallback would silently point the app
at some other build, while an unset variable fails the build with `BCP427` before anything reaches
Azure. `infra/azure/README.md` documents reading the live value into `INGEST_PACKAGE_URL` first,
which is one `az functionapp config appsettings list` away.

`BUILD_COMMIT` is stamped into the bundle by `apps/ingest-worker/scripts/bundle.ts`, so the
`switchback-ingest-queue-health build=<sha>` heartbeat — not this URL — is what proves which build
is actually mounted.
''')
param packageUrl string

@description('''
How deep a tile that outruns `INGEST_DEADLINE_MS` may be subdivided. `9` is off: no tile splits,
a dense one fails exactly as it did before, and children already created still finish and still
roll up. `11` allows two levels — six Alps tiles hit the 540 s wall on 2026-08-04, and `120221203`
measures 6,440 Overpass elements at z9 against 1,641 in its first z10 child, so one level is
expected to be enough and the second is margin. **The live app holds `11`.**

**A parameter with no default, on either side.** An ARM application-settings write replaces the
collection whole, so a literal in the template would re-enable subdivision on the next routine
deploy after an operator had turned it off. A *fallback* in `ingest.bicepparam` is the same defect
pointing the other way: the live value is `11`, so a deploy from a shell that forgot to export it
would silently write `9` and turn subdivision off. `9` is not the safe direction once the ceiling is
live — `canSubdivide(9, 9)` is false, so a dense z9 tile is failed rather than split, which is the
540 s overrun class subdivision exists to bound. An unset variable therefore fails the build with
`BCP427` before anything reaches Azure, exactly as `INGEST_TRAIL_IDENTITY` does.

Subdivision stays paired with `INGEST_TRAIL_IDENTITY` being `claim`. A new interior seam fragments a
multi-way trail that crosses it — `assembleTrails` keys a way-trail by the lowest way id *it saw*,
and `commitTrail` only ever upserts — so a split writes damage into `trails` that turning the flag
back off does not undo. `subdivideMaxZoom` enforces the pairing in code as well: with identity on
`osm-id` the ceiling reads as `9` whatever is deployed here.
''')
@allowed([
  '9'
  '10'
  '11'
])
param ingestSubdivideMaxZoom string

@description('''
How a way-derived trail is identified. `claim` resolves it through the `trail_ways` table, which is
what keeps one trail one row when two tiles each assemble part of it. `osm-id` keeps the
`(osmType, osmId)` upsert, where the id is the lowest way id the tile happened to see.

`osm-id` never writes `trail_ways` or `trail_slug_aliases` and never reads `trail_ways`, so
switching to it stops every future merge and restores the previous behaviour on the next tile. It
still reads `trail_slug_aliases`, so a slug a merge retired is not handed to some other trail, and
tolerates that table being absent. It does not undo a merge that has already run: that deleted the
loser `Trail` row, and no setting brings it back. Turning this on is reversible; the rows it has
already retired are not.

`claim` requires both tables to exist. Apply the schema before deploying a worker package that can
run with this set — CI's `migrate` job does that on a push to `master` only.
''')
@allowed([
  'osm-id'
  'claim'
])
param ingestTrailIdentity string

@description('Vercel team slug. Half of the OIDC issuer and subject the publisher credential trusts.')
param vercelTeamSlug string = 'mbahgattechs-projects'

@description('Vercel project name. The other half of the subject; a project rename invalidates it.')
param vercelProjectName string = 'switchback'

@description('Tags, matching main.bicep with a component so this deployment is separable in cost views.')
param tags object = {
  app: 'switchback'
  env: 'production'
  managedBy: 'bicep'
  repo: 'mbahgatTech/switchback'
  sourcePath: 'infra/azure'
  costCenter: 'vs-enterprise-monthly-credit'
  dataClassification: 'user-content'
  component: 'ingest-worker'
}

// ---------------------------------------------------------------------------------------

var namespaceName = '${namespacePrefix}-${uniqueString(resourceGroup().id)}'
var functionAppName = '${functionAppPrefix}-${uniqueString(resourceGroup().id)}'

// Storage account names are 3-24 characters, lowercase alphanumeric, and globally unique.
var storageAccountName = 'stsbingest${uniqueString(resourceGroup().id)}'

// Every role assignment here is one of these two, queue-scoped, and nothing holds Data *Owner*.
//
// Data Owner was the earlier choice, on the argument that reading the queue depth is an
// administration operation the data roles do not carry. That is true of
// `ServiceBusAdministrationClient`, which talks the data-plane management protocol — but not of
// the question. Both roles below already carry the control-plane action `queues/read`, and the
// ARM representation of a queue exposes `countDetails.activeMessageCount`, so the pump reads the
// depth through ARM instead (`apps/ingest-worker/src/service-bus.ts`) and the role goes away.
//
// What that buys, concretely: Data Owner at queue scope is a wildcard over `Microsoft.ServiceBus`
// in both `actions` and `dataActions`, so it would let the worker rewrite `lockDuration` or delete
// the very queue it drains. Sender and Receiver cannot.
var serviceBusDataSenderRoleId = '69a216fc-b8fb-44d8-bc22-1f3c2cd27a39'
var serviceBusDataReceiverRoleId = '4f6d3b9b-027b-4f4c-9142-0e5a2a2247e0'

// Website Contributor and Monitoring Reader — the two grants `.github/scripts/deploy-worker.sh`
// needs, and the ceiling on what a compromised CI run could do with them. Website Contributor
// carries `Microsoft.Web/sites/*`, which is the package push and the trigger sync; it reaches no
// other resource type. Monitoring Reader is read-only across the component it is scoped to.
var websiteContributorRoleId = 'de139f84-1756-47ae-9be6-808fbbe84772'
var monitoringReaderRoleId = '43d0d8ad-25c7-4714-9337-8ba259a9fe05'

// The package container, from both ends: the host fetches its own code with the first, CI uploads
// it with the second. Both are scoped to `function-releases` alone — see the assignments.
var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'
var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'

// Host storage, at **account** scope, because the Functions host creates its own containers —
// `azure-webjobs-hosts` for leases and `azure-webjobs-secrets` for function keys — and a grant
// cannot name a container that does not exist yet. Owner rather than Contributor is Microsoft's
// documented minimum for `AzureWebJobsStorage`: the host sets blob ACLs when it takes a singleton
// lease. Table Data Contributor is the second half of that minimum, for the diagnostic events the
// host writes when it cannot start.
//
// **This subsumes the container-scoped Reader below, and the trade is deliberate.** Blob Data
// Owner over the account includes write on `function-releases`, so the worker's identity can
// overwrite the package it runs from. That is not a new way in: the token is only obtainable from
// inside the app, so reaching it already requires execution there. What it replaces is an account
// key in an application setting, which anyone who could read settings or a log could use from
// anywhere. Separating host storage from the release container into two accounts is what would
// remove the residue; it is not needed to close the key.
var storageBlobDataOwnerRoleId = 'b7e6dc6d-f1e8-4753-8033-0f276bb0955b'
var storageTableDataContributorRoleId = '0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3'

@description('''
The `sub` prefix GitHub actually stamps on this repository's OIDC tokens.

**Not `repo:<owner>/<repo>`.** GitHub issues an immutable subject built from the numeric account
and repository ids, and a credential written against the human-readable form matches nothing —
`azure/login` fails with AADSTS70021 and the deploy job that was meant to close the stale-build
loop reopens it. Read the live value back with:

    gh api repos/<owner>/<repo>/actions/oidc/customization/sub --jq .sub_claim_prefix

`id-switchback-postgres-ci` — the one federated credential in this estate observed to work, in
CI run 31183187247 — carries exactly this prefix.
''')
param workerDeploySubjectPrefix string = 'repo:mbahgatTech@81331884/switchback@1316632119'

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' existing = {
  name: logAnalyticsWorkspaceName
}

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' existing = {
  name: alertActionGroupName
}

// ---------------------------------------------------------------------------------------
// Service Bus
// ---------------------------------------------------------------------------------------

@description('''
**Standard, not Basic**, and not for the $10.

Basic has no duplicate detection. The pump re-derives the runnable head of `ingest_jobs` every two
minutes and will re-publish rows whose message is still unconsumed; `messageId = dedupeKey` plus
server-side dedupe collapses those at the broker instead of spending a Postgres claim on each.
Standard also leaves topics and sessions available if derived work ever wants its own consumer.

Basic is a legitimate downgrade if the credit tightens — the only change is the publisher dropping
`messageId`, because correctness has never rested on broker dedupe.

`disableLocalAuth: true` is what makes the **Service Bus path** keyless: both sides authenticate with
an Entra identity — the worker with the Function App's system-assigned one, Vercel with the federated
user-assigned one below — and with local auth off no SAS key would work even if one leaked. Turning
it back on is a one-line revert. There is no longer a flag that bypasses the broker: Service Bus is
the only route a tile takes. That makes the broker a hard dependency for *latency* but not for
durability — `ensureCoverage` writes the `ingest_jobs` row before anything publishes, and
`publishIngestSignals` logs a failed send and returns rather than throwing. What the row then waits
on is `ingestPump` reaching it from the head of `priority DESC, "runAfter" ASC`, which is the
backlog's cadence and not the pump's.

It is not a claim about this file, but this file is now close to it. **One** long-lived credential
is deployed from here and a maintainer needs to know it is there to rotate: `DATABASE_URL`, passed
in as a secure parameter and held as an application setting. The storage account key used to be a
second — minted into `AzureWebJobsStorage` and `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` — and is
now neither read nor accepted: `allowSharedKeyAccess` is false and the host authenticates as itself.
`WEBSITE_RUN_FROM_PACKAGE` was a third, a ten-year blob SAS, and is now a bare URL the host reads
with the same identity.
''')
resource namespace 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: namespaceName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
    tier: 'Standard'
  }
  properties: {
    minimumTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true
    zoneRedundant: false
  }
}

@description('''
The single queue. Every message body is just `{"dedupeKey":"..."}` — a wake-up signal, not the work.
`ingest_jobs` stays the queue of record and keeps admission control, priority, backoff and revival,
so a message and a row can never disagree about what to do.

The two settings that carry an argument:

`lockDuration: PT5M` is the service maximum, and what matters about it is how it composes with the
handler's clock and the database lease. `host.json` kills the handler at `functionTimeout`
(`00:10:00`) and `LEASE_TIMEOUT_MS` (packages/ingest/src/jobs.ts) derives twelve minutes from it.

The **lower** bound stops a live handler's lease expiring underneath it while it is still working —
another process would claim the tile and the two would commit the same trails twice:

  lockDuration (300 s) < functionTimeout (600 s) < LEASE_TIMEOUT_MS (720 s)

**There is no upper bound that makes a redelivery the repair, and that is a property of the
service, not a tuning mistake.** Auto-renewal stops the instant the process dies, and an eviction
can kill it before the first renewal, so the redelivery gap starts at one whole `lockDuration` —
not at `functionTimeout + lockDuration`. Measured over 2026-08-08's six redeliveries: 299.9, 300.0,
455.0, 592.8, 708.1 and 1012.7 s. Five of the six arrived while the lease was still live, and the
two at the floor came back at exactly `lockDuration`. For a redelivery to always find an expired
lease the lease would have to be shorter than `lockDuration`; to be safe under a live handler it
must be longer than `functionTimeout`. Since `PT5M` is the service maximum and `functionTimeout` is
ten minutes, no value satisfies both.

So the repair is the reaper, not the broker. `reclaimExpiredJobs` returns an expired lease to
`queued` at `RECLAIM_PRIORITY`, above every band `enqueue` assigns, and `ingestPump` sweeps before
it selects — so the row clears the ordinary backlog, whatever any delivery decided, instead of
rejoining the tail of its own priority band and waiting for that backlog to drain. It does not
clear the reclaimed band: reclaimed rows share one fixed priority and are published at the pump's
per-tick window like any other, so recovery costs one tick while that band fits in a tick and the
band's own drain when it does not. The relation that makes the republish durable is the dedupe
window below: it has to be shorter than the lease, or the republish is discarded as a duplicate of
the message a redelivery already completed, and the tile is lost with nothing logged.

All of these numbers live in different files, so `apps/ingest-worker/test/drain.test.ts` reads
`lockDuration`, `duplicateDetectionHistoryTimeWindow` and `defaultMessageTimeToLive` from this
template and `functionTimeout` and `maxAutoLockRenewalDuration` from `host.json`, and asserts the
chain. That the elevated row is the one the pump reaches is asserted in
`apps/ingest-worker/test/pump.test.ts`, which runs `runPump` against an ordered backlog.

`maxAutoLockRenewalDuration` in `host.json` is `00:30:00`, well past `functionTimeout`, so a running
handler never loses its lock to renewal expiry.

`maxDeliveryCount: 5` with `deadLetteringOnMessageExpiration: false` gives the dead-letter queue one
meaning: **the worker could not reach Postgres five times**. Work errors never redeliver — `drainJobs`
catches per job and routes to `failJob`, and retry semantics for the work itself are `RETRY_DELAYS_MS`,
`maxAttempts` and the `dead` status in Postgres, none of which Service Bus can express. Dead-lettering
expired messages would fill the DLQ with stale wake-up signals and hide the one thing it should mean.

**`defaultMessageTimeToLive: PT1H` does expire messages, and both it and the dead-lettering flag
are load-bearing at the values above — moving either in the direction that looks safer makes
recovery worse.** Measured over the 50 `ingestDrain` invocations of 2026-08-08: mean 126,245 ms, p90
540,111 ms, max 548,954 ms, 20 of 50 past 30 s. At `maxConcurrentCalls: 1` a queue eight deep is
~15 minutes of dwell at the mean and over an hour at p90, so both the 10-minute dedupe window and
this TTL are exceeded in the tail. Neither loses work: the queue carries a wake-up signal and
`ingest_jobs` carries the record, so an expired message leaves a `queued` row that the next pump
tick republishes. `PUMP_LOW_WATER` is what stops the republishes stacking up behind a slow tile.

Expiry is therefore the mechanism that *restores* the pump rather than a leak in it. `runPump`
publishes nothing while `activeMessageCount` is at or above `PUMP_LOW_WATER`, and
`apps/ingest-worker/src/service-bus.ts` reads that count from the queue's ARM `countDetails`, where
an expired message no longer appears. A longer TTL would hold stale signals in the active count and
suppress the one process that can re-derive the work; `deadLetteringOnMessageExpiration: true` would
clear the active count but route every stale doorbell to the DLQ, whose alert exists to mean one
thing. A worker stopped for maintenance loses wake-up signals and no work, which is the trade these
two values are chosen for. `apps/ingest-worker/test/drain.test.ts` pins both against that argument.

The dedupe window is 10 minutes for one reason only — it must be *shorter* than `LEASE_TIMEOUT_MS`
(720 s), or the pump's republish of a reclaimed job is discarded as a duplicate of the message a
redelivery already completed, and the tile is lost with nothing logged. 120 s of margin.
''')
resource queue 'Microsoft.ServiceBus/namespaces/queues@2024-01-01' = {
  parent: namespace
  name: queueName
  properties: {
    lockDuration: 'PT5M'
    maxDeliveryCount: 5
    deadLetteringOnMessageExpiration: false
    defaultMessageTimeToLive: 'PT1H'
    requiresDuplicateDetection: true
    duplicateDetectionHistoryTimeWindow: 'PT10M'
    // Sessions would impose per-key ordering nobody asked for and add maxConcurrentSessions as a
    // second multiplier in the concurrency argument below.
    requiresSession: false
    // A tripwire, not a target: the pump holds the queue at eight messages by design.
    maxSizeInMegabytes: 1024
    enablePartitioning: false
    enableBatchedOperations: true
  }
}

@description('''
The identity Vercel publishes as. **This replaces the queue-scoped SAS key**, and with it the only
long-lived secret the publisher path ever held — Vercel now stores three identifiers and nothing that
authenticates on its own. It is not the last key in this file; see the note on the namespace above.

A *user-assigned managed identity* rather than an app registration, for two reasons that both
matter here. It is an ARM resource, so it and its federated credentials are declared in this file
and deployed by the same run as everything else — an app registration lives in Microsoft Graph,
which Bicep can only reach through a preview extension and a directory permission the deploying
service principal does not hold, and creating one by hand is exactly the portal click this work is
meant to remove. And Vercel's own Azure guide documents the managed-identity path.

The exchange, end to end: Vercel signs a short-lived OIDC token per deployment and puts it on every
function request as `x-vercel-oidc-token`; the publisher posts it to Entra as a `client_assertion`
in a `client_credentials` grant; Entra checks it against the credentials below and returns an access
token for `https://servicebus.azure.net`, which is what the send actually carries. Nothing durable
is stored on either side. See `packages/ingest/src/publish.ts`.
''')
resource publisher 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-switchback-vercel-publisher'
  location: location
  tags: tags
}

@description('''
Production deployments of this Vercel project, and nothing else.

Every field is matched by Entra **exactly and case-sensitively**; wildcards are not supported in any
of them, which is why preview needs its own credential below rather than a pattern covering both.
The limit is 20 federated credentials per identity, so two is not close to a constraint.

`subject` is Vercel's `sub` claim verbatim — `owner:<team>:project:<project>:environment:<env>` —
and it is worth saying out loud that **renaming the Vercel team or project silently breaks this**:
the claim follows the new name, the credential does not, and the exchange then fails with no error
anywhere except the publisher's own log line.

`audiences` is the token's default `aud`, `https://vercel.com/<team>`, deliberately rather than the
`api://AzureADTokenExchange` Azure suggests. Both are accepted; the difference is that the default
is the token already on the request, while a custom audience makes the function call Vercel to mint
a second token before it can call Entra at all — a third network round trip on the path behind the
map, on every cold start, to gain nothing this deployment can point at. The credential is pinned to
one issuer and one subject either way.
''')
resource publisherProduction 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: publisher
  name: 'vercel-switchback-production'
  properties: {
    issuer: 'https://oidc.vercel.com/${vercelTeamSlug}'
    subject: 'owner:${vercelTeamSlug}:project:${vercelProjectName}:environment:production'
    audiences: [
      'https://vercel.com/${vercelTeamSlug}'
    ]
  }
}

@description('''
Preview deployments. Separate because `sub` differs only in its last segment and no wildcard is
allowed there.

It is granted the same Send on the same queue on purpose: a preview publishes signals for tiles it
has already written to the same `ingest_jobs`, so refusing it would leave preview deployments
enqueueing work nothing wakes. Send is the whole grant — a preview cannot read, drain or alter the
queue.

`dependsOn` is not decorative. Federated credentials under one identity are created sequentially or
ARM's concurrency detection fails the deployment with a 409.
''')
resource publisherPreview 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: publisher
  name: 'vercel-switchback-preview'
  properties: {
    issuer: 'https://oidc.vercel.com/${vercelTeamSlug}'
    subject: 'owner:${vercelTeamSlug}:project:${vercelProjectName}:environment:preview'
    audiences: [
      'https://vercel.com/${vercelTeamSlug}'
    ]
  }
  dependsOn: [
    publisherProduction
  ]
}

@description('''
Namespace operational logs into the existing workspace.

Cheap, and worth it: `OperationalLogs` records management-plane operations on the namespace and its
entities — entity created, updated, deleted — not message traffic, so its volume is a handful of
records per deployment rather than one per tile. It answers "did something change the queue" for a
queue whose settings are the concurrency argument.

Data-plane telemetry is deliberately not here. Message counts arrive as metrics (`AllMetrics`, which
the dead-letter alert reads), and the worker's own traces go to Application Insights, which is
workspace-based and lands in this same workspace. A `Microsoft.Web/sites` diagnostic setting would
bill a second copy of what App Insights already ships, so there is none.
''')
resource namespaceDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  scope: namespace
  name: 'to-log-switchback-prod'
  properties: {
    workspaceId: workspace.id
    logs: [
      {
        category: 'OperationalLogs'
        enabled: true
      }
    ]
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

@description('''
The dead-letter alert, onto the existing action group.

Because of the queue policy above this fires for exactly one condition — a message the worker failed
to process five times, which in this design means it could not reach Postgres. That is an operator
signal, not noise, so the threshold is zero and the severity is 2.

**`autoMitigate` is off, and that is forced by the metric.** `DeadletteredMessages` is the *depth*
of the dead-letter queue, and nothing drains it: a dead-lettered message sits there until a person
removes it. So the gauge never returns to zero on its own, and an auto-mitigating rule on it would
stay fired until somebody acted anyway. Edge-triggered is the honest reading: the alert means "a
message was dead-lettered", the operator drains the queue, and closing the alert is part of that
work rather than something the platform guesses at.

`Maximum` because it is the only aggregation that is both accepted and correct here. Service Bus
publishes `DeadletteredMessages` with `supportedAggregationTypes` of Average, Minimum and Maximum —
`Total` is not among them. It is also the wrong reading on a depth gauge: summing a window conflates
depth with duration, so one message sitting for fifteen minutes and fifteen messages arriving in one
read identically. `Maximum` moves 1 → 2 on the second dead letter, which is the thing to see.

Draining it is `infra/azure/README.md`, "A message dead-lettered".
''')
resource deadLetterAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'switchback-ingest-deadletter'
  location: 'global'
  tags: tags
  properties: {
    description: 'A message on ingest-jobs was dead-lettered: the worker could not process it in ${queue.properties.maxDeliveryCount} deliveries. Nothing drains the dead-letter queue, so this stays open until an operator does.'
    severity: 2
    enabled: true
    scopes: [
      namespace.id
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'DeadLetteredMessages'
          metricNamespace: 'Microsoft.ServiceBus/namespaces'
          metricName: 'DeadletteredMessages'
          dimensions: [
            {
              name: 'EntityName'
              operator: 'Include'
              values: [
                queueName
              ]
            }
          ]
          operator: 'GreaterThan'
          threshold: 0
          timeAggregation: 'Maximum'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    autoMitigate: false
    actions: [
      {
        actionGroupId: actionGroup.id
      }
    ]
  }
}

// ---------------------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------------------

@description('''
The storage account the Functions host requires for leases, keys and the deployment package.

**No key leaves this template, because none is minted.** `allowSharedKeyAccess: false` turns the
two account keys off at the account: they still exist and `listKeys` still returns them, and
neither one authorises a single data-plane request. The host reads blobs, queues and tables with
its own system-assigned identity through the `AzureWebJobsStorage__*` settings below, and
`.github/scripts/deploy-worker.sh` uploads the package with `--auth-mode login`.

The Azure Files content share is gone with it. Azure Files has no identity-based connection, so
`WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` is a key by construction; Linux Consumption does not
need it, because the app runs from the external package URL that `WEBSITE_RUN_FROM_PACKAGE` names.
Windows Consumption and Elastic Premium do need it and could not make this trade.

`Standard_LRS` because nothing durable lives here: lose the account and the fix is a redeploy plus a
zip push.
''')
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageAccountName
  location: location
  tags: tags
  sku: {
    name: 'Standard_LRS'
  }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    defaultToOAuthAuthentication: true
    accessTier: 'Hot'
  }
}

@description('''
The container `WEBSITE_RUN_FROM_PACKAGE` points at, and the scope of the two grants below.

Declared here rather than left to the deploy tool, because it is what the two role assignments are
scoped to: a container ARM does not know about cannot be named as a scope, and granting at the
account instead would hand the same principals `azure-webjobs-secrets`, where the host keys live.
`publicAccess` is unset — identity-based fetch requires the blob to be private.
''')
resource releases 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  name: '${storage.name}/default/function-releases'
  properties: {
    publicAccess: 'None'
  }
}

@description('''
**How the host reads its own code, and why no SAS appears anywhere.**

Linux Consumption runs from an external package URL — it is the only deployment technology the plan
supports — and that URL can be authorised two ways. A SAS is the default because
`az functionapp deployment source config-zip` mints one, with a **520-week** expiry: a ten-year
bearer credential for the package, living in an application setting, in a repository that is public.
This grant is the alternative Microsoft documents and recommends: the host presents its own
system-assigned identity, `WEBSITE_RUN_FROM_PACKAGE` carries a bare `https://…/function-releases/
<commit>-<utc>.zip`, and there is nothing in the setting to leak, rotate or outlive its usefulness.

Reader, not Contributor: the host only ever fetches.
''')
resource functionAppPackageRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: releases
  name: guid(releases.id, functionApp.id, storageBlobDataReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataReaderRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// The third grant `.github/scripts/deploy-worker.sh` needs: uploading the package over Entra, with
// `--auth-mode login`, which is the only mode the account accepts. Contributor because the script
// writes; scoped to this container, so it reaches neither the host keys nor the lease blobs beside
// it — which is a narrower reach than the host's own account-scoped grant below.
resource workerDeployerPackageWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: releases
  name: guid(releases.id, workerDeployer.id, storageBlobDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataContributorRoleId
    )
    principalId: workerDeployer.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

@description('''
What replaces the account key: the host reading its own storage as itself.

Account scope, not container scope, because the containers the host uses — `azure-webjobs-hosts`,
`azure-webjobs-secrets` — are created by the host at start-up and a role assignment cannot name a
resource that does not exist. See the note beside the two role ids for why Owner is the minimum
and what the account-wide reach costs.
''')
resource functionAppHostStorageBlobs 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, storageBlobDataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageBlobDataOwnerRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// Diagnostic events. The host writes them to Table storage precisely when it cannot start, so
// without this the one signal that would explain a dead app is the one it cannot record.
resource functionAppHostStorageTables 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: storage
  name: guid(storage.id, functionApp.id, storageTableDataContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      storageTableDataContributorRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

@description('''
Consumption (Y1 Dynamic), Linux. Two alternatives were live and both lost on something other than
price:

**Flex Consumption** scales each non-HTTP function on its own instances, and `maximumInstanceCount`
is an app-wide total — so the queue worker and the timer pump contend at 1 and the worker can take
two instances at 2. Consumption is documented the opposite way: one host instance runs the entire
function app, and all functions in it share that instance's resources. That property is what makes
the concurrency argument below hold.

**Premium EP1** is ~$150/month against a $150 credit on a subscription whose spending limit is on;
exceeding it deallocates the Postgres server. That is an outage risk rather than a line item.

The cost of Consumption is a hard 10-minute `functionTimeout`. That is a 10x improvement on the
60-second Vercel `maxDuration` this replaces, but it is a real ceiling: EP1 is the named escape
hatch if a route job ever proves to need more.
''')
resource plan 'Microsoft.Web/serverfarms@2023-12-01' = {
  name: 'plan-switchback-ingest'
  location: location
  tags: tags
  kind: 'functionapp'
  sku: {
    name: 'Y1'
    tier: 'Dynamic'
  }
  properties: {
    reserved: true
  }
}

@description('Workspace-based, pointed at the existing log-switchback-prod so worker telemetry lands beside everything else.')
resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: 'appi-switchback-ingest'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

var optionalWorkerSettings = concat(
  databaseAuth == 'password'
    ? []
    : [
        {
          name: 'DATABASE_AUTH'
          value: databaseAuth
        }
      ],
  empty(terrainTileUrl)
    ? []
    : [
        {
          name: 'TERRAIN_TILE_URL'
          value: terrainTileUrl
        }
      ],
  empty(mapillaryToken)
    ? []
    : [
        {
          name: 'MAPILLARY_TOKEN'
          value: mapillaryToken
        }
      ]
)

@description('''
The worker: one Service Bus queue trigger and one timer pump, in one app, on one instance.

---

**The Overpass clamp, and what it does and does not bound.** The one statement of the fleet-wide
bound is `docs/architecture.md`; this is the Azure half of it.

`packages/ingest/src/overpass.ts` serializes at `maxConcurrent: 2` because Overpass allots slots per
client IP, and exceeding that is what gets an egress IP blocked — taking ingest down for the product,
not just for one job. Consumption auto-scales, which fights that directly: left alone it runs many
instances, each with its own client at 2. The chain that stops it, every link traceable from config:

      1  host instance          siteConfig.functionAppScaleLimit = 1  (below)
                                WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT = 1  (below)
    x 1  Node worker process    FUNCTIONS_WORKER_PROCESS_COUNT = 1  (below)
    x 1  OverpassClient         module singleton, packages/ingest/src/config.ts getOverpass()
    x 2  requests per client    OVERPASS_MAX_CONCURRENT = 2  (below)
    = 2  concurrent Overpass requests per host instance

**This app is now the only thing that performs Overpass work, so every line of that arithmetic is
load-bearing.** It used to be advisory: the drain ran on Vercel, where a lambda is a process and the
platform starts as many as traffic asks for, so the singleton on the fourth line bounded a fraction
of the fleet and the first three lines applied to nothing. With the Vercel path deleted the chain
above is the deployment, and `INGEST_MAX_DRAINERS` below — enforced by an advisory lock in
`packages/ingest/src/drain-slot.ts` — is what holds it across host instances rather than within one.

The first two lines are the ones doing the work here, and the fourth is why: however many
invocations the host starts, they run in one Node process and share one `OverpassClient`, whose own
queue is the ceiling. `host.json`'s `maxConcurrentCalls: 1` is set too, but the argument deliberately
does not rest on it — the host multiplies that value by the instance's core count, and "a
Consumption instance is typically one core" is not a sentence to build a correctness claim on.

**Read the first line precisely: `functionAppScaleLimit` caps scale-*out*, not instance count.** It
stops the scale controller adding a second instance for load. It does not stop Consumption replacing
an instance, and around a replacement two host instances of this app are alive at once, each with its
own `OverpassClient`. Observed, not theorised: at 2026-08-03T17:32 instance `0--f7e39076-13` took
sequence 1 at :00.884, instance `0--3f3e4037-7d` logged "Starting Host" at :13.797 and took sequence
2 at :15.175, and the first instance never emitted a result — its lock expired unreleased and
sequence 1 redelivered at 17:37:28 with `DeliveryCount 2`. So the ceiling is 2 sustained and up to 4
for the seconds of a recycle. Overpass's fair use is about sustained load, so that is acceptable; a
claim of "2, deployment-wide, always" would not have been true.

That trace also shows what a mid-drain recycle costs: the evicted instance strands its message for
the full `PT5M` `lockDuration`, and when it redelivers, the `ingest_jobs` row is still under the dead
lease from the first attempt, so the handler logs "nothing claimable" and the tile waits for
`reclaimExpiredJobs`. That reclaim no longer waits on a drain happening: `sweepQueue` runs it from
the Vercel cron and off request traffic, and `drainSlotGate` runs it again inside the transaction
that admits a drainer.

`OVERPASS_MAX_CONCURRENT` is set explicitly to `2` rather than left to the code default so the number
is visible in the portal alongside the scale limit. **Raising it, or `INGEST_MAX_DRAINERS`, breaks
the fair-use guarantee.** They are not throughput knobs.

Vercel makes zero Overpass requests, and that is now a property of the deployment rather than of a
setting. The three call sites that used to reach Overpass from a Vercel process are deleted, not
gated: the cron route's `drainIfOwned`, `trails.ts`'s `kickIngest` and `routes.ts`'s `kickNetwork`.
A Vercel process enqueues and publishes; it has no drain to run and no code path that could start
one. `kickNetwork` is the reason the distinction matters — it drained `ingest_network` inline from a
public procedure the planner fires on every viewport settle, so that kind had two drainers while the
prose here asserted it had one. Deleting the path is what makes the claim checkable instead of
conditional.

**The host's 10-minute `functionTimeout` bounds the handler, so the client has to be bounded too.**
`OverpassClient`'s own worst case on the defaults is `maxAttempts` 6 x `requestTimeoutMs` 190 s plus
backoff — roughly 24 minutes for *one* query, and `processTile` issues several. Left alone the host
wins that race: it kills the process mid-tile, which strands the `ingest_jobs` lease and redelivers
the message. `OVERPASS_MAX_TOTAL_MS` below, and the start-by moment `overpassDeadlineMs` derives
from it, are the two numbers that make it fit; the arithmetic is beside them.

---

**Managed identity, and where it stops.** The Service Bus connection is identity-based — a fully
qualified namespace, no key, backed by the role assignment below. The binding carries no
`__clientId`, so the host authenticates the trigger as this app's **system-assigned** principal,
which is why the queue's Receiver grant is held by `3db30cfd-…` and not by the shared runtime
identity. Moving this app onto the shared identity would therefore need that grant put back on an
identity every Vercel preview carries — which is the grant revoked on 2026-08-08. Two principals is
the cheaper arrangement.

Postgres is reachable by identity, and that is how the worker reaches it: role `sbapp_func` is
mapped to `3db30cfd-…`, inherits `sbapp`'s table grants, and `databaseAuth` is `entra`, so
`DATABASE_URL` here carries no password. See that parameter for what the flip requires and how to
put it back.

---

**`WEBSITE_RUN_FROM_PACKAGE` is declared here, from the `packageUrl` parameter.** Linux Consumption
runs the code from a package URL that `.github/scripts/deploy-worker.sh` writes into this same
collection — and an ARM application-settings write replaces the collection whole. Leaving it out of
the template therefore left the app codeless after any deployment that ran without a package push;
declaring it means a template-only deploy writes back the URL that is already live, provided
`INGEST_PACKAGE_URL` names it. A `syncfunctiontriggers` POST is still required whenever the package
*changes* — otherwise the host comes back with `0 functions loaded`, `az functionapp function list`
returns nothing, and a Consumption app with no registered triggers has nothing to scale on, so it
never runs again and a restart does not fix it. See infra/azure/README.md for the command. Anything
the worker needs from the environment belongs in this list for the same reason: a setting added by
hand in the portal is erased by the next deployment.
''')
resource functionApp 'Microsoft.Web/sites@2023-12-01' = {
  name: functionAppName
  location: location
  tags: tags
  kind: 'functionapp,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    siteConfig: {
      linuxFxVersion: 'Node|22'
      // The clamp. No scale-out; see the note above for why that is not the same as "one instance".
      functionAppScaleLimit: 1
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      use32BitWorkerProcess: false
      appSettings: concat(
        [
          {
            name: 'WEBSITE_RUN_FROM_PACKAGE'
            value: packageUrl
          }
          // Host storage as the app's own identity. The double underscore is read at runtime as a
          // colon, so these four are properties of one `AzureWebJobsStorage` object rather than
          // four settings; a plain `AzureWebJobsStorage` value alongside them would win, which is
          // why it is absent rather than emptied. All three service URIs are named because the
          // host resolves blob, queue and table independently and falls back to a connection
          // string for any it cannot build.
          {
            name: 'AzureWebJobsStorage__blobServiceUri'
            value: storage.properties.primaryEndpoints.blob
          }
          {
            name: 'AzureWebJobsStorage__queueServiceUri'
            value: storage.properties.primaryEndpoints.queue
          }
          {
            name: 'AzureWebJobsStorage__tableServiceUri'
            value: storage.properties.primaryEndpoints.table
          }
          // System-assigned: no `clientId`, which is what selects a user-assigned identity.
          {
            name: 'AzureWebJobsStorage__credential'
            value: 'managedidentity'
          }
          // `WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` and `WEBSITE_CONTENTSHARE` are deliberately
          // absent. They name an Azure Files share, Azure Files authenticates only with the
          // account key, and Linux Consumption does not use the share at all — the content root
          // is the package `WEBSITE_RUN_FROM_PACKAGE` names. Adding them back re-introduces the
          // key this template exists to have removed.
          {
            name: 'FUNCTIONS_EXTENSION_VERSION'
            value: '~4'
          }
          {
            name: 'FUNCTIONS_WORKER_RUNTIME'
            value: 'node'
          }
          // The v4 Node programming model registers its triggers by running the entry point named
          // in package.json `main`, not by shipping a function.json per function. Without this the
          // host falls back to scanning for function.json directories, finds none, and reports
          // "0 functions found" against a package that mounted perfectly.
          {
            name: 'AzureWebJobsFeatureFlags'
            value: 'EnableWorkerIndexing'
          }
          {
            name: 'WEBSITE_NODE_DEFAULT_VERSION'
            value: '~22'
          }
          {
            name: 'FUNCTIONS_WORKER_PROCESS_COUNT'
            value: '1'
          }
          {
            name: 'WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT'
            value: '1'
          }
          {
            name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
            value: appInsights.properties.ConnectionString
          }
          // Identity-based Service Bus connection. The binding's connection name is
          // `ServiceBusConnection`; the host reads the `__fullyQualifiedNamespace` suffix as
          // "use the app's identity" and never looks for a key.
          {
            name: 'ServiceBusConnection__fullyQualifiedNamespace'
            value: '${namespace.name}.servicebus.windows.net'
          }
          {
            name: 'SERVICE_BUS_QUEUE'
            value: queueName
          }
          // The queue's ARM id, which is how the pump reads its depth. See the note beside the
          // role ids: `countDetails` through the control plane is what lets the worker hold
          // Sender + Receiver instead of Data Owner.
          {
            name: 'SERVICE_BUS_QUEUE_RESOURCE_ID'
            value: queue.id
          }
          // The instant brake. Setting this to false stops new work reaching the queue in seconds
          // with no deploy anywhere. It does not stop the drain, and it does not stop the pump
          // republishing a lease the sweep has just reclaimed — `classifyDisposition` completes a
          // message on the strength of that republish and cannot take the completion back, so a
          // brake that suppressed it would leave the row `queued` with nothing to carry it to the
          // broker until an operator lifted the brake. Nothing is lost either way; what the
          // republish buys is a bound on when it comes back. What keeps that exception narrow is
          // `enqueue` resetting `priority` on a revived row: a reclaimed tile requested again
          // re-enters at its own band, so the brake holds it like any other new work.
          {
            name: 'INGEST_PUMP_ENABLED'
            value: 'true'
          }
          // Do nothing while at least this many messages are still unhandled, then top the queue
          // back up to INGEST_PUMP_MAX_DEPTH. Holding it shallow is what keeps `priority DESC` in
          // Postgres meaningful: Service Bus is FIFO and has no priority, so a deep queue would
          // park a tile someone is looking at behind the backlog.
          {
            name: 'INGEST_PUMP_LOW_WATER'
            value: '4'
          }
          {
            name: 'INGEST_PUMP_MAX_DEPTH'
            value: '8'
          }
          {
            name: 'DATABASE_URL'
            value: databaseUrl
          }
          {
            name: 'OVERPASS_USER_AGENT'
            value: overpassUserAgent
          }
          {
            name: 'OVERPASS_MAX_CONCURRENT'
            value: '2'
          }
          // The Overpass budget's two halves are `OVERPASS_MAX_TOTAL_MS` — the most one query may
          // spend across every retry — and the start-by moment, which is *derived* rather than set.
          // `overpassDeadlineMs` computes INGEST_DEADLINE_MS - OVERPASS_MAX_TOTAL_MS -
          // INGEST_COMMIT_RESERVE_MS, so the three numbers below cannot fail to add up. Before any
          // of this, one query's own budget was six attempts of 190 s plus backoff — about 24
          // minutes — and `ingest_tile:120221221` duly ran 600008 ms and was killed mid-tile.
          //
          // `INGEST_OVERPASS_DEADLINE_MS` is deliberately absent. The code still reads it and takes
          // whichever is lower, so an operator can tighten the clamp in an incident; a template
          // value could only ever be inert or a loosening, and `test/drain.test.ts` fails if one
          // reappears here.
          // Wall clock held back for the commit loop. Without it the two Overpass queries could
          // consume the whole handler budget, every trail threw `IngestDeadlineError`, and the
          // tile subdivided into four children that repeated the exercise — measured 2026-08-08 as
          // six invocations running 540,111 ms to 548,954 ms past a 540,000 ms bound. 150,000 is
          // measured too: the work after `assembled` on the 23 invocations that finished inside the
          // budget between 2026-08-05 and 2026-08-08 ran 32.9 s to 381.2 s, median ~133 s.
          {
            name: 'INGEST_COMMIT_RESERVE_MS'
            value: '150000'
          }
          // 190,000 is `OverpassClient.requestTimeoutMs`: one full attempt. Budget above that can
          // only fund a retry that starts too late to finish a query whose server-side `[timeout:]`
          // is up to 180 s, and every millisecond of it comes out of the start-by. The 240,000 it
          // replaces pushed the start-by to 150 s, which refused five of five parent-route lookups
          // on 2026-08-08 between 22:34 and 22:48 UTC and would have refused the feature query on
          // the tile that reached `assembled` at 168.4 s (quadkey 133002102, 17:02:11 UTC).
          {
            name: 'OVERPASS_MAX_TOTAL_MS'
            value: '190000'
          }
          // The outer wall clock, covering every phase rather than only Overpass — terrain and
          // the per-trail commits included, through `PipelineDeps.deadlineAt`. Past 540 s no
          // phase may begin, which leaves 60 s of the host's 600 s for whichever phase was
          // already running. Bounding only Overpass was not enough and measurement said so:
          // with the flag on 2026-08-03, 120221230 and 120221203 were killed at 612,947 ms and
          // 615,938 ms while Overpass stayed inside its budget the whole time, because
          // `TerrainSource` had neither a per-request timeout nor a budget. See drain.ts.
          {
            name: 'INGEST_DEADLINE_MS'
            value: '540000'
          }
          // How deep a tile that outruns that budget may be subdivided, from the parameter above
          // rather than a literal — an application-settings write replaces the collection whole,
          // so a value baked in here would re-enable subdivision on the next deploy after an
          // operator had turned it off.
          {
            name: 'INGEST_SUBDIVIDE_MAX_ZOOM'
            value: ingestSubdivideMaxZoom
          }
          // Paired with the ceiling above, and for the same reason: a ceiling above 9 without
          // this on `claim` is the combination that fragments trails across the new seam.
          //
          // Live value is `claim`, and `ingest.bicepparam` reads INGEST_TRAIL_IDENTITY with no
          // fallback, so a deploy from a shell that has not exported it fails the build rather than
          // writing `osm-id` over a control that is on. Read it back after every deployment with
          // `az functionapp config appsettings list`: `identity.ts` treats an absent variable and
          // `osm-id` identically, so an app whose settings collection was replaced without this
          // entry looks unchanged and is not.
          {
            name: 'INGEST_TRAIL_IDENTITY'
            value: ingestTrailIdentity
          }
          // How many processes may hold Overpass-making work at once, fleet-wide. One, and
          // `packages/ingest/src/drain-slot.ts` enforces it in Postgres rather than in a
          // per-process singleton — which is what `OVERPASS_MAX_CONCURRENT` above is, and why it
          // bounded this app (one instance, one process) and not Vercel (as many lambdas as the
          // traffic asks for, one Overpass allowance between them).
          {
            name: 'INGEST_MAX_DRAINERS'
            value: '1'
          }
          {
            name: 'NODE_ENV'
            value: 'production'
          }
        ],
        optionalWorkerSettings
      )
    }
  }
}

@description('''
**Every role assignment this design needs is here, and none of them is a runbook step.**

They used to be conditional on `deployRoleAssignments`, and there was a real reason: writing a role
assignment needs `Microsoft.Authorization/roleAssignments/write`, which built-in Contributor puts in
its `notActions`, and the deploying service principal held nothing else. That is no longer true. The
principal `cf940ed6-1527-47be-9168-3406ef977827` was granted **Role Based Access Control
Administrator** (`f58310d9-a9f6-439a-9e8d-f62e7b41a168`), unconditioned, scoped to this resource
group, on 2026-08-03. So the parameter, the fallback and the `az role assignment create` in
README.md are all gone: the template is the only thing that grants anything.

Three assignments here, all **scoped to the queue** rather than the namespace, so nothing has
standing on an entity created later:

  worker    Data Sender    the pump publishes a wake-up signal per runnable row
  worker    Data Receiver  the trigger receives, completes, and dead-letters
  publisher Data Sender    Vercel publishes

The worker's pair replaces a single Data Owner; see the note beside the role ids above for what
that was buying and why it is not needed. The publisher gets Sender and nothing else:
`id-switchback-vercel-publisher` is the shared runtime identity every Vercel deployment carries,
previews included, so anything granted to it is reachable from an unreviewed branch build over the
same REST surface `packages/ingest/src/publish.ts` uses to send.

Assignment `0090d328-0cee-592f-8359-e4cc64940694` was the publisher's Receiver and was revoked on
2026-08-08. The worker never depended on it: its Service Bus binding carries no `__clientId`, so the
host authenticates the trigger with the Function App's system-assigned principal, whose own Receiver
grant is `workerReceiver` below.

Two more, on the storage account and its `function-releases` container, are declared beside the
storage resources above because that is where their argument lives.
''')
resource workerSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: queue
  name: guid(queue.id, functionApp.id, serviceBusDataSenderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      serviceBusDataSenderRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource workerReceiver 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: queue
  name: guid(queue.id, functionApp.id, serviceBusDataReceiverRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      serviceBusDataReceiverRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource publisherSender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: queue
  name: guid(queue.id, publisher.id, serviceBusDataSenderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      serviceBusDataSenderRoleId
    )
    principalId: publisher.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

/*
 * `0090d328-0cee-592f-8359-e4cc64940694` — the publisher identity's Data Receiver on this queue —
 * used to be declared here, on the argument that a template must describe the estate that exists.
 * It no longer exists: the resource-group lock was lifted and the assignment deleted. Declaring it
 * now would re-create it on the next deployment, handing Receive on `ingest-jobs` back to the one
 * identity every Vercel deployment carries, previews included. What is not declared is not granted.
 */

@description('''
**The identity that publishes the worker bundle, and the reason there is one at all.**

`WEBSITE_RUN_FROM_PACKAGE` is declared in this template, from `packageUrl` — but what it names is a
per-commit blob, `function-releases/<commit>-<utc>.zip`, and uploading that blob is not something a
template can do. So the setting is declared here and the *package* arrives from somewhere else. That
somewhere was a workstation, which is to say it was one person remembering. Master then moves and
the site does not, with every CI gate green, because the gates describe a build and nothing was
asserting anything about production.

This identity is what lets `.github/workflows/ci.yml` close that loop on every push to master. Its
`workerDeployerClientId` output is the `AZURE_WORKER_DEPLOY_CLIENT_ID` repository variable; without
it the deploy job fails rather than skips, on the principle that a skipped deploy is the failure it
exists to prevent wearing a green tick.

**Two narrow grants, both below.** Website Contributor scoped to the one site, Monitoring Reader
scoped to the one Application Insights component — enough to push a package, sync the trigger cache
and read back whether the host is running it. Neither reaches Postgres, Service Bus, storage or any
other resource group. The infrastructure identity in `infra-identity.bicep` is Contributor on
everything and is deliberately *not* reused here: this credential is exercised by every merge, so it
is the one whose blast radius is worth minimising.
''')
resource workerDeployer 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-switchback-worker-deploy'
  location: location
  tags: tags
}

@description('''
The `master` branch of this repository, and nothing else.

Every field is matched exactly and case-sensitively, so a pull request — whose subject ends
`:pull_request` — cannot assume this identity. That matters more here than for the identities
above: this repository is public, so a fork's pull request runs workflow code the fork controls,
and a credential a fork could assume is a credential that can rewrite production.

**The suffix is `ref:`, which constrains the workflow that may use it.** A job that names a
GitHub `environment` presents `:environment:<name>` in place of the ref, so declaring one on
`deploy ingest worker` silently stops this credential matching. `.github/scripts/assert-oidc-subject.sh`
runs on every push and compares the token GitHub actually issues against this value, so the two
cannot drift apart unobserved again.
''')
resource workerDeployerMaster 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: workerDeployer
  name: 'github-switchback-master'
  properties: {
    issuer: 'https://token.actions.githubusercontent.com'
    subject: '${workerDeploySubjectPrefix}:ref:refs/heads/master'
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

resource workerDeployerSite 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: functionApp
  name: guid(functionApp.id, workerDeployer.id, websiteContributorRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      websiteContributorRoleId
    )
    principalId: workerDeployer.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// Read-only, and the deploy fails without it: the push is only half the job, and the half that
// proves the host is running the package is an Application Insights query.
resource workerDeployerTelemetry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appInsights
  name: guid(appInsights.id, workerDeployer.id, monitoringReaderRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      monitoringReaderRoleId
    )
    principalId: workerDeployer.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

@description('''
**A failed drain has to page somebody, and neither of the obvious signals sees one.**

`switchback-ingest-deadletter` fires on `DeadletteredMessages`, and a drain the host kills never
dead-letters: the redelivery finds the `ingest_jobs` row still under the dead invocation's lease,
logs "nothing claimable" and *completes* the message in ~165 ms, so `DeliveryCount` never reaches 2.

The `requests` table does not see one either, and that is the trap this rule was caught by. A
handler error is caught inside `drainJobs`, written to the job row, and the invocation returns
normally — so on 2026-08-04 `requests | success == true` was 14/14 while six Alps tiles failed.
The first arm below is still worth keeping (a host kill *is* a failed request), but on its own it
was a rule that could not fire on the failure mode it was written for.

The second arm reads `traces` for the token `runIngestSignal` logs beside every job-level failure.
Matching a token rather than the sentence is deliberate: a reworded log line must not silently
disarm the alert, and `apps/ingest-worker/test/drain.test.ts` asserts the two agree.

The third arm is subdivision, which would otherwise have *disarmed* the second. Before it a tile
that exhausted `deadlineAt` threw `IngestDeadlineError`, `drainJobs` recorded a failure and the
token above was logged; now that tile splits, `processTile` returns normally and the invocation
logs `done`. An operator would read 8/8 tiles succeeded while two of them ingested nothing and
deferred to four children each. A split is a deferral, not a success, and the ground a reader is
waiting for is still missing when one happens.

**Both tokens in that arm are edge-triggered, and the rule depends on it.** A split is logged once,
when it happens. `switchback-ingest-subtree-stuck` is written only when the parent's stored
`lastError` does not already say so — without that it would be logged on every drain of a blocked
parent, and a blocked parent is `pending`, so `ensureCoverage` re-queues it on every viewport poll
and `explore.tsx` polls *because* it is pending. One stuck subtree would then page every fifteen
minutes for as long as anyone left that map open, on the same rule as the genuine failure signal,
which trains an operator to ignore exactly the signal this rule was created for.

Both trace arms depend on `traces` arriving at all. `host.json` samples Application Insights at
five items per second and adaptive sampling drops correlated *sets*, so a dense tile's dependency
telemetry could take the one line these arms match with it. `excludedTypes` there now holds
`Trace`, which is what makes this rule's evidence non-droppable.

`Count`/`GreaterThan 0` over fifteen minutes, so a single failure is enough. `autoMitigate` is off
— the condition is "this happened", not "this is happening", and an alert that resolves itself the
moment the tile stops being retried is an alert nobody reads.

**The fourth arm is the one that sees a killed handler.** A handler the host kills writes no
request row at all — the process stops between two awaits — so the first arm is structurally
incapable of firing on it. Measured on 2026-08-08 16:00–20:00 UTC: `Functions.ingestDrain` logged
42 `Executing` against 37 `Executed`, and the five invocations that logged a start and no end
(16:32:42, 17:06:37, 17:28:19, 17:45:12 and 18:24:00 UTC) have no `AppRequests` row under their
invocation ids — the query returns zero.

A slow handler that *does* return is a separate fault the first arm also misses, for the opposite
reason: six other invocations ran 540,111 ms to 548,954 ms past the 540,000 ms bound and every
one recorded `Success=True`. Overrunning is not failing, as far as the host is concerned.

The three deployed arms are **not** silent over that window — run verbatim they return five
matches: one `ingest-job-failed` for `ingest_tile:120222201` at 16:56:39, and four
`switchback-ingest-tile-split` at 17:55:05, 18:04:14, 18:13:20 and 18:22:30. Every one of those is
a different fault. None is the killed handler, and the `Executing`-minus-`Executed` gap of five is
invisible to all three.

The signal the fourth arm watches is written by the reaper rather than by the redelivery, because
the reaper is the only participant that observes the death. `reclaimExpiredJobs` runs ahead of the
claim in both `drainJobs` and `drainSlotGate`, so by the time a redelivered message is classified
the row has already been returned to `queued` and that delivery has nothing left to report — which
is the repair working, not a gap. The reclaim emits `switchback-ingest-lease-expired`, and it fires
on the real event: inside the same window the pump logged three non-zero reclaims, at 17:45:12,
17:58:22 and 18:16:20 UTC, plus a retirement at 17:04:00. Each was a lease whose holder had died,
and none carried a token any rule could match.

**The fifth arm is narrower than it looks, deliberately.** `switchback-ingest-signal-stranded`
covers the one state no reclaim can free — a `running` row whose `lockedAt` is NULL, which
`lockedAt < cutoff` never matches however long it sits. That is a different fault from a killed
handler and it needs its own arm; it is not a second chance at the same one.

**The sixth arm is the one condition `writeOutcome`'s lease fence exists to detect.**
`switchback-ingest-double-commit` is written when a handler finished under a lease that had already
been taken back, so the same trails were committed twice. The count lives only in `DrainResult.lost`
and the row belongs to whoever reclaimed it, so without this line nothing anywhere records it.

**The seventh arm is a repair, reported because nothing else would show it happened.**
`switchback-ingest-tile-wedged` is written by `repairWedgedTiles` when it takes a tile out of
`running` that no job could have finished. A tile reaches that state only by having its handler
killed on its last attempt, so the repair firing means the killing is still happening.

**The eighth arm covers the pump, which is now the only route from `ingest_jobs` to a drainer.**
`runPump` reads the queue depth through ARM and publishes; if either throws, `ingestPump` rejects.
`reportQueueHealth` has already run by then, so `switchback-ingest-worker-silent` stays quiet on its
heartbeat and the estate looks alive while nothing reaches the queue. Unlike the drain, a rejected
timer invocation does write a request row — the process is not killed — so `success == false` is the
right predicate here even though it is the wrong one four arms up.
''')
resource drainFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'switchback-ingest-drain-failed'
  location: location
  tags: tags
  properties: {
    displayName: 'switchback-ingest-drain-failed'
    description: 'An ingest job failed, was killed by the host, deferred its tile to four children, or the pump could not publish. None of these dead-letters, so this rule is the only signal.'
    severity: 2
    enabled: true
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'union (requests | where name == "ingestDrain" and success == false | project timestamp), (traces | where message has "ingest-job-failed" | project timestamp), (traces | where message has "switchback-ingest-tile-split" or message has "switchback-ingest-subtree-stuck" | project timestamp), (traces | where message has "switchback-ingest-lease-expired" | project timestamp), (traces | where message has "switchback-ingest-signal-stranded" | project timestamp), (traces | where message has "switchback-ingest-double-commit" | project timestamp), (traces | where message has "switchback-ingest-tile-wedged" | project timestamp), (requests | where name == "ingestPump" and success == false | project timestamp)'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: false
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

@description('''
**A 429 from Overpass is the one upstream signal that can take the product down, and nothing read
it.** The public instances allot slots per client IP; sustained rate limiting is answered with a
block, and a blocked IP means no tile ingests at all until somebody notices and asks for it back.

`switchback-ingest-queue-distress` has a `rateLimited` gauge, but it counts `ingest_jobs.lastError`
containing '429' — so it only sees a rate limit that outlived the retry budget and failed a job.
Failover absorbs most of them before that, and an absorbed 429 touches no job row. Measured on
2026-08-08: the distress line reported `rateLimited=0` on every tick while `OVERPASS_STRAIN_MARKER`
recorded five real 429s between 16:37:28 and 18:24:51 UTC, each followed by a failover.

This rule reads the request path directly, where the 429 actually arrives.
`packages/ingest/src/overpass.ts` logs one line per non-OK response, and the `status=` in it is the
code the mirror returned. Scoped to 429 rather than to strain generally: a 504 is a slow mirror and
failover is the designed answer, but a 429 is the upstream telling us we are over our allowance,
and the correct response is a person deciding whether to back off.
''')
resource overpassLimitedAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'switchback-ingest-overpass-limited'
  location: location
  tags: tags
  properties: {
    displayName: 'switchback-ingest-overpass-limited'
    description: 'Overpass answered 429. Sustained rate limiting is answered with an IP block, which stops ingestion entirely.'
    severity: 2
    enabled: true
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'traces | where message has "switchback-ingest-overpass-strain" and message has "status=429" | project timestamp'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: false
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

@description('''
**Three of a tile's four Overpass queries fail soft, so a budget that is too tight loses data
silently.** Region, waypoints and parent-route discovery all catch and carry on: the tile still
reaches `ready`, the request row still reads success, and no job row records anything. Measured on
2026-08-08, five of five invocations that reached parent-route discovery between 22:34 and 22:48 UTC
were refused by the start-by, and nothing in the estate said so.

`packages/ingest/src/pipeline.ts` now prefixes all three with `switchback-ingest-overpass-skipped`,
which is what makes them countable. The threshold is not zero: one skipped waypoint query is a slow
mirror, and paging on it would be noise. Sustained skipping means the budget or the upstream has
moved, which is a person's decision — hence severity 3 and `autoMitigate` on, since unlike a dead
letter this genuinely recovers on its own.
''')
resource overpassSkippedAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'switchback-ingest-overpass-skipped'
  location: location
  tags: tags
  properties: {
    displayName: 'switchback-ingest-overpass-skipped'
    description: 'Tiles are completing without their region, waypoints or parent routes because Overpass queries are being refused or failing. The data loss is silent everywhere else.'
    severity: 3
    enabled: true
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'traces | where message has "switchback-ingest-overpass-skipped" | project timestamp'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 4
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

@description('''
**The queue needs a gauge as well as an event stream, and this is it.**

`switchback-ingest-drain-failed` above fires on things that *happened* — a job that failed, a
handler the host killed, a tile that deferred itself to four children. This rule watches what is
*true*: conditions that persist, and that nothing would report until somebody went looking.

Six of those conditions are a *row*: a job buried recently, a lease past `LEASE_TIMEOUT_MS`, a
`lastError` naming a 429, a tile carrying a split marker with no children, a subtree marked stuck,
a tile left mid-fetch that no job can finish. The seventh is the absence of rows changing — a drain
that has stopped leaves no error behind, so
`stalledDrain` reports due work with no terminal transition inside `DRAIN_SILENCE_MS`.
`ingestPump` runs every two minutes and already reads that database, so
`apps/ingest-worker/src/health.ts` reads the seven counts and logs `switchback-ingest-queue-distress`
when any is non-zero. The report runs ahead of the `INGEST_PUMP_ENABLED` brake in
`functions/pump.ts`: a queue somebody has deliberately stopped feeding is exactly when its depth
still needs watching.

**Each of the seven can return to zero, which is what makes this a rule rather than a light left
on.** Three of them would not have: `failJob` buries a job as `dead` instead of deleting it, and
`pruneFinishedJobs` keeps that row for thirty days, so an unwindowed count reads the same
twenty-five for a month and a new 429 changes nothing an operator can see. `DISTRESS_WINDOW_MS` in
`packages/ingest/src/maintenance.ts` bounds `dead` and `rateLimited` to the last hour — longer than
this rule's fifteen-minute window, so nothing falls between evaluations. The third is `stalledDrain`,
which measures silence rather than depth for the same reason: 44,884 jobs are queued and overdue and
will be for months, so a gauge counting them is a light left on by construction.
`orphanedSplits` counts
only parents whose children are actually missing, not every parent midway through a legitimate
subdivision.

`autoMitigate` is **on**, unlike the rule above, and the difference is deliberate. That one is
edge-triggered — a thing happened. This is a gauge: distress is present or it is not, the pump
re-reads it every two minutes, and a fixed queue should clear the alert rather than leave a
resolved condition open. Severity 3 for the same reason: it is a backlog, not an outage.

`apps/ingest-worker/test/health.test.ts` asserts this query and the marker the code logs agree, so
a reworded log line fails the build instead of silently disarming the rule.

**This rule cannot fire from a worker that is not running, which is why it is not the only one.**
Its whole firing condition is a log line, so a host that is down, wedged, or serving a build with no
`health.ts` in it produces exactly the telemetry a healthy queue does. `switchback-ingest-worker-silent`
below reads the heartbeat's absence and closes that gap.
''')
resource queueDistressAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'switchback-ingest-queue-distress'
  location: location
  tags: tags
  properties: {
    displayName: 'switchback-ingest-queue-distress'
    description: 'The ingest queue buried a job, lost a lease, hit a rate limit, orphaned a split marker or wedged a subtree within the last hour. Reported by ingestPump, whichever side owns the drain.'
    severity: 3
    enabled: true
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT15M'
    criteria: {
      allOf: [
        {
          query: 'traces | where message has "switchback-ingest-queue-distress" | project timestamp'
          timeAggregation: 'Count'
          operator: 'GreaterThan'
          threshold: 0
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

@description('''
**The rule that catches a worker which has stopped shipping.**

Every other rule in this file is armed by something the Function App emits, so all of them read a
host that is down, wedged, or running a build that predates the code they watch as an estate with
nothing wrong. That is not a hypothetical: the zip `WEBSITE_RUN_FROM_PACKAGE` names is uploaded by
`.github/scripts/deploy-worker.sh` and by nothing else, so a failure of that path leaves the app on
whatever it was doing before — serving the previous zip, or, when the host is stopped under the
deploy, serving nothing while the setting names a build it never ran. Run 31301084801 left the
second state. Both read as silence, and this is the rule that reports either.

`reportQueueHealth` logs `switchback-ingest-queue-health` on **every** reading — the first statement
in the `ingestPump` handler, ahead of the `INGEST_PUMP_ENABLED` brake, on a two-minute timer.
Fifteen lines are expected per window. Zero means the pump did not run, or ran a build with no
`health.ts` in it, and there is no third reading.

**The query returns a row even when nothing matches**, which is what makes a count of zero
alertable: `summarize` with no `by` clause yields exactly one row holding `0`, where the bare
`| project timestamp` form used above yields none and leaves the platform's empty-result handling to
decide the verdict.

Severity 2 and `autoMitigate` on: a drainer nobody can see is worse than a queue in distress, and
the condition clears by itself the moment a heartbeat lands.
''')
resource workerSilentAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'switchback-ingest-worker-silent'
  location: location
  tags: tags
  properties: {
    displayName: 'switchback-ingest-worker-silent'
    description: 'ingestPump has published no queue-health reading for 30 minutes. The worker is down, or it is running a build that predates health.ts — in both cases every other ingest alert is reading a process that cannot arm it.'
    severity: 2
    enabled: true
    scopes: [
      appInsights.id
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT30M'
    criteria: {
      allOf: [
        {
          query: 'traces | where message has "switchback-ingest-queue-health" | summarize heartbeats = count()'
          metricMeasureColumn: 'heartbeats'
          timeAggregation: 'Total'
          operator: 'LessThan'
          threshold: 1
          failingPeriods: {
            numberOfEvaluationPeriods: 1
            minFailingPeriodsToAlert: 1
          }
        }
      ]
    }
    autoMitigate: true
    actions: {
      actionGroups: [
        actionGroup.id
      ]
    }
  }
}

// ---------------------------------------------------------------------------------------
// Outputs. No keys and no connection strings, because there are none: the three values Vercel
// needs are a hostname, a tenant id and a client id, and none of them authenticates anything on
// its own.
// ---------------------------------------------------------------------------------------
output serviceBusNamespace string = namespace.name
output serviceBusFullyQualifiedNamespace string = '${namespace.name}.servicebus.windows.net'
output serviceBusQueue string = queue.name
output functionAppName string = functionApp.name
output functionAppPrincipalId string = functionApp.identity.principalId
output applicationInsightsName string = appInsights.name

@description('Set on Vercel as AZURE_CLIENT_ID. The identity clientId, not its principalId.')
output publisherClientId string = publisher.properties.clientId
output publisherPrincipalId string = publisher.properties.principalId
output publisherTenantId string = publisher.properties.tenantId

@description('Set as the AZURE_WORKER_DEPLOY_CLIENT_ID repository variable. Without it CI cannot publish the worker.')
output workerDeployerClientId string = workerDeployer.properties.clientId
