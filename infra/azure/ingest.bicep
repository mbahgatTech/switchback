// The ingest queue and the worker that drains it: Service Bus, a Consumption Function App, and
// the storage, telemetry and RBAC they need.
//
// **A separate template, at resource-group scope, on purpose.** It deploys into the resource
// group `main.bicep` already created and never declares the Postgres server, its database, its
// firewall rules or its parameters. `administratorLoginPassword` is `@secure()` with no default
// and ARM cannot read the current value back, so any deployment that includes `postgres.bicep`
// writes whatever it is handed — and the live password is not recorded anywhere readable. Adding
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

This is the application login, not the administrator, and it is the same string Vercel already
holds. **This template does not enable Entra authentication on the server**, so there is no managed
identity path to Postgres here; see the note beside the Function App's identity for what turning
that on would cost.
''')
@secure()
param databaseUrl string

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
Whether ingest runs through this queue. Written to the Function App as `INGEST_QUEUE_DRIVER` and
read by both functions here, exactly as Vercel reads it.

That is what makes the flag a rollback: set both sides to `postgres` and the Vercel cron drains
`ingest_jobs` again while the pump stops publishing and the trigger drops what is left. Set only
one and the two drain the same table at once, which is worse than either alone. At 3am the faster
brake is `az functionapp config appsettings set` on this one setting, which restarts the app and
takes effect in seconds.

**No default, on purpose.** A template deployment overwrites this setting with whatever the
parameter says, so a default would let a routine deploy silently undo an operator's rollback —
and the unsafe direction (`servicebus`) is exactly the one a forgotten `export` would have
restored. Every deployment must state the driver; `ingest.bicepparam` reads it from
`INGEST_QUEUE_DRIVER` in the deploying shell and the build fails if it is unset.
''')
@allowed([
  'postgres'
  'servicebus'
])
param ingestQueueDriver string

@description('''
How deep a tile that outruns `INGEST_DEADLINE_MS` may be subdivided. `9` is off: no tile splits,
a dense one fails exactly as it did before, and children already created still finish and still
roll up. `11` allows two levels — six Alps tiles hit the 540 s wall on 2026-08-04, and `120221203`
measures 6,440 Overpass elements at z9 against 1,641 in its first z10 child, so one level is
expected to be enough and the second is margin.

**A parameter, not a literal, and `ingest.bicepparam` resolves it to `9` unless the deploying
shell says otherwise.** An ARM application-settings write replaces the collection whole, so a
value baked into the template would re-enable subdivision on the next routine deploy after an
operator had turned it off at 3am. The polarity is the point and it is the opposite of
`ingestQueueDriver`'s: for the driver both values are dangerous, so it has no fallback at all;
here the unsafe direction is only ever *on*, so a forgotten `export` must land on off.

Subdivision stays off in the committed parameters until task #228 lands. A new interior seam
fragments a multi-way trail that crosses it — `assembleTrails` keys a way-trail by the lowest way
id *it saw*, and `commitTrail` only ever upserts — so a split writes damage into `trails` that
turning the flag back off does not undo.
''')
@allowed([
  '9'
  '10'
  '11'
])
param ingestSubdivideMaxZoom string

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
it back on is a one-line revert, and the flag rollback does not need it: `INGEST_QUEUE_DRIVER=postgres`
bypasses the broker entirely.

It is not a claim about this file. Three long-lived credentials are deployed from it and a maintainer
needs to know they are there to rotate: the storage account key, minted into `AzureWebJobsStorage` and
`WEBSITE_CONTENTAZUREFILECONNECTIONSTRING` below; `DATABASE_URL`, passed in as a secure parameter and
held as an application setting; and the ten-year blob SAS the zip push writes into
`WEBSITE_RUN_FROM_PACKAGE`. What has no key is the queue.
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

`lockDuration: PT5M` is the service maximum, and is deliberately **shorter** than the 30-minute
database lease (`LEASE_TIMEOUT_MS`, packages/ingest/src/jobs.ts). A crashed host's message returns
in five minutes, finds the row still leased, claims nothing and completes as a no-op. The
`(lockedBy, lockedAt)` compare-and-set fence in `writeOutcome` is the real guard; this is not trying
to be one. Locks on a message actually being worked are held by the host's auto-renewal, configured
in `host.json` at `00:30:00` so lock and lease expire together rather than one silently first.

`maxDeliveryCount: 5` with `deadLetteringOnMessageExpiration: false` gives the dead-letter queue one
meaning: **the worker could not reach Postgres five times**. Work errors never redeliver — `drainJobs`
catches per job and routes to `failJob`, and retry semantics for the work itself are `RETRY_DELAYS_MS`,
`maxAttempts` and the `dead` status in Postgres, none of which Service Bus can express. Dead-lettering
expired messages would fill the DLQ with stale wake-up signals and hide the one thing it should mean.

`defaultMessageTimeToLive: PT1H` against a 14-day default: a signal older than an hour is worthless
because the pump re-derives the truth every two minutes. The dedupe window is 10 minutes, comfortably
above the pump interval plus the worst-case dwell of a queue held at most eight deep.
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

`Maximum` rather than `Average`: `DeadletteredMessages` is a gauge of current DLQ depth, and averaging
a gauge over fifteen minutes can hide a single message that arrived late in the window.
''')
resource deadLetterAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'switchback-ingest-deadletter'
  location: 'global'
  tags: tags
  properties: {
    description: 'A message on ingest-jobs was dead-lettered: the worker could not process it in ${queue.properties.maxDeliveryCount} deliveries.'
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
    autoMitigate: true
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

Shared-key access stays on because the Consumption host reads `AzureWebJobsStorage` as a connection
string; identity-based host storage is a Flex/Premium/Dedicated feature. That key never leaves ARM —
it is composed into an application setting below and is not an output. The *Service Bus* connection,
which is the one that matters for least privilege, is identity-based and keyless.

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
    allowSharedKeyAccess: true
    defaultToOAuthAuthentication: false
    accessTier: 'Hot'
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

var storageConnectionString = 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'

var optionalWorkerSettings = concat(
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

**The Overpass clamp. This is the load-bearing part of the whole deployment.**

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

The first two lines are the ones doing the work, and the fourth is why: however many invocations the
host starts, they run in one Node process and share one `OverpassClient`, whose own queue is the
ceiling. `host.json`'s `maxConcurrentCalls: 1` is set too, but the argument deliberately does not rest
on it — the host multiplies that value by the instance's core count, and "a Consumption instance is
typically one core" is not a sentence to build a correctness claim on.

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
`reclaimExpiredJobs`. That is why the Vercel cron still calls `reclaimExpiredJobs` on the
`servicebus` branch instead of being switched off.

`OVERPASS_MAX_CONCURRENT` is set explicitly to `2` rather than left to the code default so the number
is visible in the portal alongside the scale limit. **Raising either of these breaks the fair-use
guarantee.** They are not throughput knobs.

Vercel makes zero Overpass requests once `INGEST_QUEUE_DRIVER=servicebus` — but that is a property
of *a Vercel environment*, not of the deployment. Production and Preview each carry the flag, or do
not, independently, and a branch deployed before the flag existed drains inline whatever the
environment says because its code has no `ingestQueueDriver` call to make. Three call sites reach
Overpass from a Vercel process and all three are gated on the flag: the cron route's
`drainOrReclaim`, `trails.ts`'s `kickIngest`, and `routes.ts`'s `kickNetwork`. The last was missed
once — it drained `ingest_network` inline from a public procedure the planner fires on every
viewport settle, which the pump also publishes, so that kind had two drainers while this comment
asserted it had one.

**The host's 10-minute `functionTimeout` bounds the handler, so the client has to be bounded too.**
`OverpassClient`'s own worst case on the defaults is `maxAttempts` 6 x `requestTimeoutMs` 190 s plus
backoff — roughly 24 minutes for *one* query, and `processTile` issues several. Left alone the host
wins that race: it kills the process mid-tile, which strands the `ingest_jobs` lease and redelivers
the message. `INGEST_OVERPASS_DEADLINE_MS` and `OVERPASS_MAX_TOTAL_MS` below are the two numbers
that make it fit; the arithmetic is beside them.

---

**Managed identity, and where it stops.** The Service Bus connection is identity-based — a fully
qualified namespace, no key, backed by the role assignment below. Postgres is not: the server has
`activeDirectoryAuth: Disabled` and `tenantId: null`, and enabling Entra authentication is a write to
the server resource, which is the password-rotation hazard this template exists to avoid. Doing it
later deliberately means: set `authConfig.activeDirectoryAuth: Enabled` and `tenantId` on the server,
create an Entra administrator, run `pgaadauth_create_principal` for this app's principal id, and swap
the driver to token auth. Until then the worker connects the way the web app already does.

---

**`WEBSITE_RUN_FROM_PACKAGE` is deliberately absent, and that makes deploy ordering a hard rule.**
Linux Consumption runs the code from a package URL that `az functionapp deployment source config-zip`
writes into this same collection — and an ARM application-settings write replaces the collection
whole. Declaring it here would fight the zip deploy; omitting it means a Bicep deployment on its own
leaves the app codeless until the next zip. So the template deploy and the zip push always run
together, template first, **and a `syncfunctiontriggers` POST after** — otherwise the host comes back
with `0 functions loaded`, `az functionapp function list` returns nothing, and a Consumption app with
no registered triggers has nothing to scale on, so it never runs again and a restart does not fix it.
See infra/azure/README.md for the command. Anything the worker needs from the environment belongs in
this list for the same reason: a setting added by hand in the portal is erased by the next
deployment.
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
            name: 'AzureWebJobsStorage'
            value: storageConnectionString
          }
          // Consumption provisions the app onto an Azure Files share, and these two settings are
          // what name it. Without them the host has no content root: the package blob downloads
          // fine and `wwwroot` is still empty, so every start logs "0 functions found (Custom)"
          // and the app idles at zero. Neither `what-if` nor a Bicep lint can see that — it only
          // shows once something has to run.
          {
            name: 'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING'
            value: storageConnectionString
          }
          {
            name: 'WEBSITE_CONTENTSHARE'
            value: toLower(functionAppName)
          }
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
          // The same flag Vercel reads, so a rollback stops both drainers rather than one.
          {
            name: 'INGEST_QUEUE_DRIVER'
            value: ingestQueueDriver
          }
          // The instant brake. Setting this to false stops the pump publishing in seconds with no
          // deploy anywhere, which is a faster stop than the Vercel-side INGEST_QUEUE_DRIVER flag
          // (that one needs a redeploy to take effect).
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
          // The two halves of the Overpass budget. 300 s is the last moment the worker will
          // *start* a query; 240 s is the most that one query may then spend across every retry.
          // 540 s worst case, inside the 600 s Consumption fixes `functionTimeout` at. Before
          // these, one query's own budget was six attempts of 190 s plus backoff — about 24
          // minutes — and `ingest_tile:120221221` duly ran 600008 ms and was killed mid-tile.
          {
            name: 'INGEST_OVERPASS_DEADLINE_MS'
            value: '300000'
          }
          {
            name: 'OVERPASS_MAX_TOTAL_MS'
            value: '240000'
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

Three assignments, all **scoped to the queue** rather than the namespace, so nothing here has
standing on an entity created later:

  worker    Data Sender    the pump publishes a wake-up signal per runnable row
  worker    Data Receiver  the trigger receives, completes, and dead-letters
  publisher Data Sender    Vercel publishes, and can do nothing else

The worker's pair replaces a single Data Owner; see the note beside the role ids above for what
that was buying and why it is not needed.
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
''')
resource drainFailureAlert 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = {
  name: 'switchback-ingest-drain-failed'
  location: location
  tags: tags
  properties: {
    displayName: 'switchback-ingest-drain-failed'
    description: 'An ingest job failed, was killed by the host, or deferred its tile to four children. None of the three dead-letters, so this rule is the only signal.'
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
          query: 'union (requests | where name == "ingestDrain" and success == false | project timestamp), (traces | where message has "ingest-job-failed" | project timestamp), (traces | where message has "switchback-ingest-tile-split" or message has "switchback-ingest-subtree-stuck" | project timestamp)'
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
