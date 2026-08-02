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
Whether to create the role assignment that lets the worker reach Service Bus with its managed
identity.

Same shape and same reason as `deployDeleteLock` in main.bicep. Writing a role assignment needs
`Microsoft.Authorization/roleAssignments/write`, which built-in **Contributor** does not have — the
existing deploying service principal holds Contributor at subscription scope and nothing more, so
for it this must be `false` or the whole deployment fails on one resource. Set it from the
environment in `ingest.bicepparam` (`DEPLOY_ROLE_ASSIGNMENTS`). CI deploys with an identity that
also holds Role Based Access Control Administrator on this group, so there it is `true` and the
assignment is real.

With it `false`, everything else still deploys and the worker cannot authenticate to the queue
until an Owner runs the one `az role assignment create` recorded in README.md.
''')
param deployRoleAssignments bool = true

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

// Azure Service Bus Data Owner. Data *Owner* rather than Sender + Receiver because the pump calls
// `getQueueRuntimeProperties()` to read the queue depth before it publishes, and that is an
// administration operation the two data roles do not carry.
var serviceBusDataOwnerRoleId = '090c5cfd-751d-490a-894a-3ce6f1109419'

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

`disableLocalAuth` stays `false` deliberately. The worker authenticates with its managed identity
and holds no key, but Vercel has no Azure identity at all, so the publisher uses the queue-scoped
SAS rule below. Turning local auth off would take the publisher out with it.
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
    disableLocalAuth: false
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
Send-only, queue-scoped, for the Vercel publisher.

Vercel has no Azure identity, so this is the one place a key is unavoidable. Scoped to the queue
rather than the namespace and `Send` rather than `Manage` so the credential that lives in a
third-party dashboard can enqueue and nothing else — it cannot read a message, cannot drain the
queue, cannot create an entity.

**The key is not an output of this template.** Read it once, out of band, and paste it into Vercel:

  az servicebus queue authorization-rule keys list \
    -g rg-switchback-prod-northcentralus --namespace-name <namespace> \
    --queue-name ingest-jobs -n vercel-send --query primaryConnectionString -o tsv
''')
resource sendRule 'Microsoft.ServiceBus/namespaces/queues/authorizationRules@2024-01-01' = {
  parent: queue
  name: 'vercel-send'
  properties: {
    rights: [
      'Send'
    ]
  }
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
    = 2  concurrent Overpass requests, deployment-wide

The first two lines are the ones doing the work, and the fourth is why: however many invocations the
host starts, they run in one Node process and share one `OverpassClient`, whose own queue is the
ceiling. `host.json`'s `maxConcurrentCalls: 1` is set too, but the argument deliberately does not rest
on it — the host multiplies that value by the instance's core count, and "a Consumption instance is
typically one core" is not a sentence to build a correctness claim on.

`OVERPASS_MAX_CONCURRENT` is set explicitly to `2` rather than left to the code default so the number
is visible in the portal alongside the scale limit. **Raising either of these breaks the fair-use
guarantee.** They are not throughput knobs.

Vercel makes zero Overpass requests once `INGEST_QUEUE_DRIVER=servicebus`, which is what makes the
claim deployment-wide rather than per-host.

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
together, template first. Anything the worker needs from the environment belongs in this list for the
same reason: a setting added by hand in the portal is erased by the next deployment.
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
      // The clamp. One instance, deployment-wide.
      functionAppScaleLimit: 1
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      http20Enabled: true
      use32BitWorkerProcess: false
      appSettings: concat(
        [
          {
            name: 'AzureWebJobsStorage'
            value: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
          }
          {
            name: 'FUNCTIONS_EXTENSION_VERSION'
            value: '~4'
          }
          {
            name: 'FUNCTIONS_WORKER_RUNTIME'
            value: 'node'
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
Azure Service Bus Data Owner for the worker's identity, **scoped to the queue** rather than the
namespace — this app can send, receive and read runtime properties on `ingest-jobs` and has no
standing on any entity created later.

Skipped when `deployRoleAssignments` is false; see that parameter for who can and cannot write this.
''')
resource queueDataOwner 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (deployRoleAssignments) {
  scope: queue
  name: guid(queue.id, functionApp.id, serviceBusDataOwnerRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      serviceBusDataOwnerRoleId
    )
    principalId: functionApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// ---------------------------------------------------------------------------------------
// Outputs. No keys and no connection strings — the Vercel SAS key is read out of band, see
// `sendRule` above.
// ---------------------------------------------------------------------------------------

output serviceBusNamespace string = namespace.name
output serviceBusFullyQualifiedNamespace string = '${namespace.name}.servicebus.windows.net'
output serviceBusQueue string = queue.name
output sendAuthorizationRuleName string = sendRule.name
output functionAppName string = functionApp.name
output functionAppPrincipalId string = functionApp.identity.principalId
output applicationInsightsName string = appInsights.name
