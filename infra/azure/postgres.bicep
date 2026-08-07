// The Flexible Server itself: compute, storage, backups, network, server parameters.
//
// Deployed into the resource group main.bicep creates. Split out of main.bicep because the
// interesting decisions all live here and a single file would bury them under scaffolding.

@description('Azure region. Inherited from main.bicep — see the note there on why East US 2.')
param location string

@description('Prefix for the server name; the deployed name appends uniqueString(rg.id).')
param serverNamePrefix string

@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param tier string

param skuName string
param storageSizeGB int
param storageTier string
param backupRetentionDays int
param postgresVersion string
param databaseName string
param databaseCollation string
param deployDatabase bool
param administratorLogin string
param applicationLogin string

@description('''
Administrator password, or empty to leave the live credential untouched. See the parameter of the
same name in main.bicep.
''')
@secure()
param administratorLoginPassword string = ''

param minTlsVersion string
param entraAuthEnabled bool
param entraAdministrators entraAdministrator[]

@description('''
Whether the server accepts a password. See the parameter of the same name in main.bicep for the
sequencing this must not be flipped ahead of.
''')
param passwordAuthEnabled bool = true

@description('''
Object id of a managed identity this deployment also creates, to be made an administrator.

Separate from `entraAdministrators` rather than appended to it, and the reason is `what-if`.
A copy count has to be computable before the deployment starts, so a loop whose length comes
from `reference()` on a not-yet-deployed resource makes ARM refuse to expand this whole module —
`NestedDeploymentShortCircuited` — and every Postgres resource silently reports as `Ignore`
instead of as a change. Losing the preview on the database is a far worse trade than one extra
parameter. Measured 2026-08-05.
''')
param ciAdministratorObjectId string

@description('Resource name of that identity, which is also its Postgres role name.')
param ciAdministratorName string
param logAnalyticsWorkspaceId string
param alertActionGroupId string
param tags object

@export()
@description('One Microsoft Entra principal that may administer the database.')
type entraAdministrator = {
  @description('Entra object id. Becomes the ARM resource name of the administrator.')
  objectId: string

  @description('UPN for a user, display name for a group, service principal or managed identity.')
  principalName: string

  principalType: 'User' | 'Group' | 'ServicePrincipal'
}

// ---------------------------------------------------------------------------------------

var serverName = '${serverNamePrefix}-${uniqueString(resourceGroup().id)}'

// PgBouncer follows the tier rather than being asked for separately, and that is on purpose.
//
// Microsoft's documentation is unambiguous twice over: "The PgBouncer feature currently
// doesn't support the Burstable server compute tier", and "Burstable servers currently don't
// have access to the built-in PgBouncer connection pooler." Deriving the flag instead of
// accepting one makes both incoherent states — Burstable with a pooler, General Purpose
// without — unrepresentable. A deployment that thinks it has a pooler on Burstable produces
// a DATABASE_URL pointing at port 6432, where nothing is listening, and every request fails
// at connect with a message about the network.
var pgBouncerEnabled = tier != 'Burstable'
var pooledPort = pgBouncerEnabled ? 6432 : 5432

// Declaring an administrator implies the feature, so the two cannot disagree in the direction
// that matters. The flag exists for the other direction — on, with nobody declared yet — which
// is the only way to sequence this safely. See the parameter's description in main.bicep.
var entraAuthOn = entraAuthEnabled || !empty(entraAdministrators) || !empty(ciAdministratorObjectId)

// Omitted from the payload unless there is something to write and password authentication is on
// to write it for. ARM cannot read a password back, so a declared value is always written and a
// redeploy carrying a different one silently rotates the live credential; omitting the property
// leaves it alone. This is what makes `passwordAuthEnabled: false` deployable with no password
// held anywhere, and what stops a routine redeploy touching the credential in the meantime.
//
// The edge that bites is the reversal: turning password auth back on without exporting the
// password omits the property and still succeeds, so the flip has to carry the credential with
// it. The rollback recipe in infra/azure/README.md does.
var writeAdministratorPassword = passwordAuthEnabled && !empty(administratorLoginPassword)

// ---------------------------------------------------------------------------------------
// The server.
//
// **Why Burstable Standard_B2s and not General Purpose.**
//
// This is a budget decision, not a performance one, and the budget is a cliff rather than a
// slope. The subscription paying for this carries a monthly credit with a spending limit that
// is on by default: when the credit is consumed the subscription is *disabled* and its
// resources are deallocated. General Purpose D2ds_v5 plus this storage runs at roughly 91% of
// that credit, leaving about $13 of headroom — one diagnostic setting, one autogrow step, or
// one 31-day month takes the database offline mid-month. B2s plus this storage runs at about
// 38%, leaving roughly $93. Losing a connection pooler is a smaller problem than losing the
// server, and this application does not need the pooler:
//
//   - B2s allows 414 user connections. A warm Vercel function holds ~5 in the request pool
//     (Prisma sizes it cores*2+1, and a Lambda has one or two) plus at most 10 in the
//     background pool (BACKGROUND_POOL_SIZE in packages/db/src/client.ts). That is ~25 warm
//     instances before the ceiling, against a fleet that has never come close.
//   - Not having PgBouncer deletes an entire failure class. Azure's PgBouncer runs
//     transaction pooling with pgbouncer.max_prepared_statements defaulting to 0, and Prisma
//     uses named prepared statements for essentially every query. Get that wrong and the
//     symptom is intermittent `prepared statement "s0" already exists` that appears only
//     under concurrency — it passes every smoke test and fails in production.
//   - The write path is bursty by construction (viewport-triggered ingest plus one daily
//     drain cron), which is the exact shape burstable CPU credits are designed for. The read
//     path is 382 MB of data against 4 GiB of RAM: resident after warm-up.
//
// Escalating is two parameter values — `tier: 'GeneralPurpose'`, `skuName: 'Standard_D2ds_v5'`
// — and PgBouncer follows automatically. The tier change is an online resize with a restart.
// The trigger to watch for is sustained active_connections above ~300 or `connection_failed`
// entries in the Postgres logs, not a hunch.
// ---------------------------------------------------------------------------------------

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: {
    name: skuName
    tier: tier
  }
  properties: {
    version: postgresVersion
    administratorLogin: administratorLogin
    administratorLoginPassword: writeAdministratorPassword ? administratorLoginPassword : null
    createMode: 'Default'

    storage: {
      storageSizeGB: storageSizeGB
      // Premium SSD v1 (the default disk type), where IOPS is a function of size: 32 GiB
      // buys 120, 64 GiB buys 240. Capacity is not the constraint — 382 MB fits in 32 GiB
      // ten times over — but the restore is: pg_restore plus the rebuild of four GiST and
      // two GIN indexes over 15k trails and 176k waypoints is IOPS-bound, and 120 makes it
      // painful. 64 GiB costs about $4 a month more than 32 and doubles the floor.
      //
      // This is a one-way door: Azure storage cannot be shrunk and only scales in 2x steps.
      // 64 GiB is therefore a permanent floor, which is why it is not simply set to 128.
      //
      // Premium SSD v2 is deliberately not used: it does not support on-demand backups and
      // it adds a separately-billed IOPS dimension to a budget that has to stay predictable.
      tier: storageTier

      // The asymmetry decides this. The downside of autogrow is a permanent, irreversible
      // step to 128 GiB. The downside of no autogrow is documented and much worse: at 95%
      // used or under 5 GiB free, the server switches itself to *read-only*, which for this
      // application is an outage. At 382 MB in 64 GiB it will never fire. It is insurance
      // that costs nothing until it saves you.
      //
      // **If it ever does fire, this template stops being redeployable until it is updated.**
      // Azure grows storage in 2x steps and never shrinks it, and the size-implied
      // performance tier moves with the size — 65536 MB is P6/240 IOPS, 131072 MB is
      // P10/500 IOPS. After one autogrow, `storageSizeGB = 64` / `storageTier = 'P6'` in
      // main.bicepparam describes a smaller disk on a tier that is no longer valid for the
      // actual size, so the "re-running the template is a no-op" path in README.md fails —
      // and that path is also the only documented way to reapply the *same* admin password,
      // so the failure lands on the operation that is riskiest to improvise. The
      // `storage_percent` metric alert in main.bicep exists so an autogrow is observed when
      // it happens rather than discovered months later during a redeploy; the note beside
      // `storageSizeGB` in main.bicepparam says to re-read both values from
      // `az postgres flexible-server show` before any redeploy.
      autoGrow: 'Enabled'
    }

    backup: {
      // 14 days rather than the default 7. It is free here — Microsoft allows backup storage
      // up to 100% of provisioned storage at no charge, which is 64 GiB against a database
      // under half a gigabyte — and it doubles the window in which a bad data migration can
      // be noticed and rewound.
      backupRetentionDays: backupRetentionDays

      // Immutable after creation, so this is decided now or never — and it is off. That is a
      // gap rather than a saving: the region supports it (`az postgres flexible-server
      // list-skus --location northcentralus -o json` reports `geoBackupSupported: Enabled`,
      // measured 2026-08-07) and at this ratio it would be free, and nothing in this
      // repository records a reason. A from-scratch deployment that wants geo-redundancy has
      // to set this Enabled here, before the first create. What the current value leaves is
      // locally-redundant point-in-time restore into a new server inside the same
      // subscription, so a region-level failure takes the recovery with the original, and
      // closing it on the live server means rebuilding it and moving the data.
      geoRedundantBackup: 'Disabled'
    }

    // Burstable does not support high availability, this region reports zone-redundant HA as
    // unavailable for this subscription regardless, and HA would double the compute bill.
    highAvailability: {
      mode: 'Disabled'
    }

    // ---------------------------------------------------------------------------------
    // **The firewall, and why it spans the entire internet.**
    //
    // The rule below is 0.0.0.0–255.255.255.255. That deserves more than a shrug, because it
    // means anyone on the internet who learns the hostname can open a TLS session and attempt
    // to authenticate.
    //
    // It is forced, not chosen. Vercel serverless functions on this plan have no static
    // outbound IP addresses — dedicated egress is a Secure Compute / Enterprise feature — so
    // there is no address range to allowlist. Neither do GitHub-hosted runners, which is the
    // other thing that has to connect. A rule narrowed to "known ranges" would be a rule that
    // fails at 3am when a provider rotates a block.
    //
    // A private endpoint is not the alternative it looks like. It would put the server on an
    // Azure virtual network, and Vercel's functions execute inside Vercel's own AWS
    // infrastructure with no route into that network. Reaching it would need a site-to-site
    // VPN or ExpressRoute terminating somewhere Vercel can reach — infrastructure that does
    // not exist, costs more than the database, and is out of scope for what is meant to be a
    // database migration. Azure also refuses to mix the two models and will not let a server
    // move between them after creation, so choosing private access now would be a one-way
    // door into a dead end.
    //
    // So the perimeter is credential-only, and the compensating controls are the real
    // security posture rather than decoration:
    //
    //   - require_secure_transport ON and a declared TLS floor: no plaintext session exists.
    //   - A hostname nobody can guess (the uniqueString suffix), so opportunistic scanners
    //     walking dictionary names find nothing.
    //   - A high-entropy admin password, SCRAM-SHA-256 only (Postgres 14+ disables MD5 on
    //     Azure), which is not brute-forceable in any practical sense.
    //   - connection_throttle.enable, which backs off repeated failed logins per source.
    //   - A least-privilege application role (`applicationLogin`, `sbapp` by default). This
    //     one is *not* created by this template — ARM has no way to run SQL — so it would be
    //     easy for this list to claim a boundary that does not exist. It is created by hand,
    //     by the `The least-privilege application role` step of the runbook in
    //     infra/azure/README.md, which also carries the two checks that turn this bullet into
    //     a claim: a catalogue query proving the role is not a member of `azure_pg_admin`, and
    //     a `CREATE TABLE` attempt made as the role itself, which must be refused. The
    //     credential Vercel carries is that role; `administratorLogin` never leaves the GitHub
    //     repository secrets.
    //   - Full certificate verification on every client (`sslmode=verify-full` for libpq,
    //     `sslaccept=strict` for Prisma — see the connection-string outputs at the foot of
    //     this file). Encryption alone would not authenticate the *server*, which on an
    //     internet-reachable endpoint is the control that actually protects the credential.
    //   - log_connections / log_disconnections, shipped to a Log Analytics workspace by the
    //     diagnostic setting in main.bicep, so a successful login from an unexpected source
    //     leaves a durable, queryable record instead of scrolling out of a short-retention
    //     default log.
    //
    // The residual risk is therefore *leakage*, not brute force: the connection string
    // appearing in a log, a build artefact, an error message, or a screen share. That makes
    // one operational rule more important than any setting in this file — the connection
    // strings live in exactly two places, GitHub Actions repository secrets and Vercel
    // production environment variables, and nowhere else. Not in .env, not in a parameter
    // file, not in a runbook, not in a commit.
    // ---------------------------------------------------------------------------------
    network: {
      publicNetworkAccess: 'Enabled'
    }

    authConfig: {
      // Both, until every consumer has been proved on a token. Turning `passwordAuth` off while
      // anything still holds a connection string locks the database against its own application,
      // and the way back is an ARM write that itself authenticates against Entra.
      passwordAuth: passwordAuthEnabled ? 'Enabled' : 'Disabled'
      activeDirectoryAuth: entraAuthOn ? 'Enabled' : 'Disabled'
      tenantId: entraAuthOn ? subscription().tenantId : null
    }

    // A named window rather than "system managed", so a maintenance restart never lands on
    // an ingest transaction. Sunday 08:00 UTC is clear of the `17 4 * * *` drain cron in
    // apps/web/vercel.json by four hours in one direction and twenty in the other.
    maintenanceWindow: {
      customWindow: 'Enabled'
      dayOfWeek: 0
      startHour: 8
      startMinute: 0
    }
  }
}

// ---------------------------------------------------------------------------------------
// Server parameters.
//
// **Two things about this block are load-bearing and both fail silently if missed.**
//
// First, `source: 'user-override'`. Omit it and ARM happily records the value while the
// engine keeps its system default. Everything looks deployed, `az ... parameter show` reports
// the value you asked for, and then `CREATE EXTENSION postgis` fails with `extension "postgis"
// is not allow-listed for "azure_pg_admin" users`. This is the classic first failure of an
// Azure PostgreSQL migration and it surfaces long after the deployment succeeded.
//
// Second, the `dependsOn` chain. These are sibling children of one server, so ARM would
// deploy them in parallel — and each parameter write is its own long-running operation
// against the same server object. Concurrent writes race and one loses with a conflict, on a
// different parameter each time, which reads as flakiness rather than as a defect. Chaining
// them serialises the writes. It costs a few minutes on a deployment that runs once.
// Conditional links in the chain are fine: ARM collapses a dependency on a resource whose
// condition is false.
//
// **On the extension allowlist specifically.** `postgis` and `pg_trgm` are the two named in
// `packages/db/prisma/schema.prisma`. `btree_gist` is the one that gets forgotten, because it
// is invisible from the schema — it is created only by `packages/db/prisma/spatial.sql`, and
// `trails_bbox_gist` is a multicolumn GiST over four scalar bbox columns that cannot exist
// without it. Allowlist the extensions from the Prisma file alone and `db push` gets through
// two CREATE EXTENSION statements, dies on the third, and leaves a half-built schema behind.
// All three are present on Azure's Postgres 17 (PostGIS 3.6.1, pg_trgm 1.6, btree_gist 1.7)
// and none of them needs a shared_preload_libraries entry, so no restart is required.
// ---------------------------------------------------------------------------------------

resource allowExtensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: {
    value: 'POSTGIS,PG_TRGM,BTREE_GIST'
    source: 'user-override'
  }
}

// On by default on a new server; declared anyway so it is a property of this template rather
// than of whatever Azure's defaults happen to be next year. No plaintext session is possible.
resource requireSecureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
  dependsOn: [allowExtensions]
}

resource sslMinProtocol 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'ssl_min_protocol_version'
  properties: {
    value: minTlsVersion
    source: 'user-override'
  }
  dependsOn: [requireSecureTransport]
}

// Backs off repeated failed logins per source address. With the firewall open to the
// internet this is one of the few controls that acts on the attacker rather than on us.
resource connectionThrottle 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'connection_throttle.enable'
  properties: {
    value: 'on'
    source: 'user-override'
  }
  dependsOn: [sslMinProtocol]
}

// Dynamic — no restart. Only reachable on General Purpose and Memory Optimized; see the note
// on `pgBouncerEnabled` above for why this is derived from the tier rather than asked for.
resource pgBouncer 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = if (pgBouncerEnabled) {
  parent: server
  name: 'pgbouncer.enabled'
  properties: {
    value: 'true'
    source: 'user-override'
  }
  dependsOn: [connectionThrottle]
}

// Belt and braces against the Prisma-through-PgBouncer failure described at the top of this
// file. Azure ships PgBouncer 1.25, which supports prepared statements in transaction mode,
// but defaults this to 0 — meaning none are tracked. `?pgbouncer=true` on the Prisma URL is
// the other half and is the portable half; either alone is a single point of failure, and the
// symptom of getting it wrong only appears under concurrency.
resource pgBouncerPreparedStatements 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = if (pgBouncerEnabled) {
  parent: server
  name: 'pgbouncer.max_prepared_statements'
  properties: {
    value: '100'
    source: 'user-override'
  }
  dependsOn: [pgBouncer]
}

// ---------------------------------------------------------------------------------------
// Connection auditing.
//
// The firewall below spans the whole of IPv4 and the perimeter is therefore a credential.
// Without these two, a successful login from an unexpected address is indistinguishable
// from a normal one — not "hard to find", *indistinguishable*, because nothing records that
// it happened. This database holds every user's email address, every recorded GPS track and
// every session token; the template tags it `dataClassification: 'user-content'` and then
// has to behave as though that were true.
//
// Both are cheap. `log_connections` writes one line per successful authentication with the
// source address, `log_disconnections` closes the pair with the session duration. Neither
// logs a statement or a row, so no user data reaches the log — which is the reason
// `log_statement` is deliberately *not* set here: on this application it would write GPS
// coordinates and email addresses into a log stream, which trades one exposure for a worse
// one.
//
// Retention is the other half and it lives in main.bicep: Flexible Server's own server logs
// are short-retention and are not queryable, so the diagnostic setting there ships
// `PostgreSQLLogs` to a Log Analytics workspace where `AzureDiagnostics | where Category ==
// "PostgreSQLLogs"` can actually answer "who connected, from where, and when".
// ---------------------------------------------------------------------------------------

resource logConnections 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'log_connections'
  properties: {
    value: 'on'
    source: 'user-override'
  }
  dependsOn: [pgBouncerPreparedStatements, connectionThrottle]
}

resource logDisconnections 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'log_disconnections'
  properties: {
    value: 'on'
    source: 'user-override'
  }
  dependsOn: [logConnections]
}

// ---------------------------------------------------------------------------------------
// Text search configuration, pinned rather than left at the Azure provider default.
//
// Pinned to `pg_catalog.simple`; a Flexible Server starts on `pg_catalog.english`. Every
// `to_tsvector` and `websearch_to_tsquery` call in this codebase names `'english'` explicitly
// — packages/db/src/spatial.ts writes the vector, packages/api/src/routers/trails.ts reads it
// — so no current query consults this GUC and search behaviour is identical either way today.
//
// It is pinned anyway, and the reason is forward-looking: the day someone writes
// `to_tsvector(name)` without a configuration argument, this GUC silently decides the
// tokenisation, and the symptom of it changing under them is a trail that stops being
// findable rather than an error.
// ---------------------------------------------------------------------------------------

resource textSearchConfig 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'default_text_search_config'
  properties: {
    value: 'pg_catalog.simple'
    source: 'user-override'
  }
  dependsOn: [logDisconnections]
}

// Ships the server's Postgres log — including the connection lines above — somewhere with a
// retention period and a query language. Without this the two parameters above produce logs
// that exist for a short while inside the service and cannot be searched, which is close
// enough to not having them.
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'switchback-postgres-logs'
  scope: server
  properties: {
    workspaceId: logAnalyticsWorkspaceId
    logs: [
      {
        category: 'PostgreSQLLogs'
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
  dependsOn: [textSearchConfig]
}

// ---------------------------------------------------------------------------------------
// Two metric alerts, both on numbers this design already names as the ones that matter and
// neither of which anyone would otherwise see without being in the portal at the time.
//
// `storage_percent` — the autogrow tripwire. See the note beside `autoGrow` above: a growth
// step is permanent, changes the size-implied performance tier, and makes the committed
// parameters un-redeployable until they are updated. It should be a message, not an
// archaeological finding.
//
// `active_connections` — the number that distinguishes "this is fine" from "this is fine
// until the next traffic spike". Burstable has no PgBouncer, so every client connection lands
// on Postgres directly against a ceiling of 414 ordinary user connections: `max_connections`
// is 429, less 10 `superuser_reserved_connections` and 5 `reserved_connections`, all three read
// from `pg_settings` on the live server. 300 is the same threshold README.md nominates as the
// signal to escalate to General Purpose, which is the tier that brings a pooler.
// ---------------------------------------------------------------------------------------

resource storageAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'switchback-postgres-storage'
  location: 'global'
  tags: tags
  properties: {
    description: 'Storage above 80% — autogrow is close, which is a permanent 2x step and invalidates storageSizeGB/storageTier in main.bicepparam.'
    severity: 2
    enabled: true
    scopes: [server.id]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'storage'
          metricName: 'storage_percent'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          operator: 'GreaterThan'
          threshold: 80
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: alertActionGroupId
      }
    ]
  }
  dependsOn: [diagnostics]
}

resource connectionsAlert 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: 'switchback-postgres-connections'
  location: 'global'
  tags: tags
  properties: {
    description: 'Sustained active_connections above 300 against a 414 ceiling. At the ceiling the failure is FATAL: sorry, too many clients already on every request, not degradation. This is the documented trigger to escalate to General Purpose, which brings PgBouncer.'
    severity: 1
    enabled: true
    scopes: [server.id]
    evaluationFrequency: 'PT5M'
    windowSize: 'PT15M'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          name: 'connections'
          metricName: 'active_connections'
          metricNamespace: 'Microsoft.DBforPostgreSQL/flexibleServers'
          operator: 'GreaterThan'
          threshold: 300
          timeAggregation: 'Average'
          criterionType: 'StaticThresholdCriterion'
        }
      ]
    }
    actions: [
      {
        actionGroupId: alertActionGroupId
      }
    ]
  }
  dependsOn: [storageAlert]
}

// ---------------------------------------------------------------------------------------

// The name is the documentation. Someone opening the portal a year from now should learn
// *why* this is open without having to find the pull request — see the long note above.
//
// Note this is deliberately not the special rule 0.0.0.0–0.0.0.0, which means "Azure services
// only" and would block Vercel entirely while looking, at a glance, like the same thing.
resource allowInternet 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = {
  parent: server
  name: 'AllowVercelServerlessNoStaticEgress'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '255.255.255.255'
  }
  dependsOn: [connectionsAlert]
}

// The collation is not cosmetic. `C.UTF-8` is byte order; Azure's server default `en_US.utf8`
// is dictionary order. A restore succeeds under either, which is exactly what makes a mismatch
// dangerous: `ORDER BY name` silently reorders every trail list and the partial unique index
// on `trail_lists` is built under different equality rules.
//
// **Create-only, hence the flag — and that is Azure's constraint, not a preference.** Charset
// and collation are fixed by `CREATE DATABASE` and cannot be altered afterwards, so there is
// no update for ARM to perform. Worse, the provider does not treat re-declaring them as a
// no-op: a PUT carrying the value the server itself reads back is rejected with
// `Invalid value given for parameter collation` (measured 2026-08-05 against this database,
// which reports `collation: "C.UTF-8"` — the exact string being sent). Leaving this true on a
// redeploy therefore fails the whole deployment, and it fails it *after* the server has been
// written, which is the worst place to stop.
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = if (deployDatabase) {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: databaseCollation
  }
  dependsOn: [allowInternet]
}

// Declaring one of these is what flips `activeDirectoryAuth` above, and **that flip restarts
// the server** — Azure installs the `pgaadauth` extension and bounces it. Adding or removing
// an administrator afterwards does not.
//
// An administrator here is an ARM-level grant only. It carries the rights of the original
// PostgreSQL administrator and can create the Entra-mapped roles the application uses, but
// those roles are SQL objects that no template can declare: see `infra/postgres-identity/`.
// `@batchSize(1)` for the same reason the configurations above are chained: each of these is
// a long-running write against one server object, and ARM would otherwise issue them at once.
@batchSize(1)
resource entraAdmins 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = [
  for admin in entraAdministrators: {
    parent: server
    name: admin.objectId
    properties: {
      principalName: admin.principalName
      principalType: admin.principalType
      tenantId: subscription().tenantId
    }
    dependsOn: [database]
  }
]

// Not part of the loop above — see `ciAdministratorObjectId`. `what-if` still cannot analyse
// this one resource, because its ARM name *is* the runtime reference, and reports it as
// `Unsupported`. That is the residual cost and it is the right size: one named resource that
// cannot be previewed, rather than every Postgres resource silently reported as `Ignore`.
resource ciAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = if (!empty(ciAdministratorObjectId)) {
  parent: server
  name: ciAdministratorObjectId
  properties: {
    principalName: ciAdministratorName
    principalType: 'ServicePrincipal'
    tenantId: subscription().tenantId
  }
  dependsOn: [entraAdmins]
}

// ---------------------------------------------------------------------------------------
// Outputs. No credential appears here or may ever be added — deployment outputs are stored
// in the deployment history and readable by anyone with reader access.
// ---------------------------------------------------------------------------------------

output serverName string = server.name
output fullyQualifiedDomainName string = server.properties.fullyQualifiedDomainName
output pgBouncerEnabled bool = pgBouncerEnabled
output pooledPort int = pooledPort

// `pgbouncer=true` is mandatory rather than cosmetic whenever the port is 6432: Prisma stops
// issuing named prepared statements when it sees it, which is the whole point.
//
// ---------------------------------------------------------------------------------------
// **Why `sslmode=verify-full` *and* `sslaccept=strict`, and not either alone.**
//
// `sslmode=require` encrypts the session and then accepts whatever certificate it is handed.
// No root-CA check, no hostname check. `require_secure_transport = ON` above does not help
// with this: it forces the client to use TLS, it cannot authenticate the *server* to the
// client. Against a firewall spanning
// all of IPv4 that is the wrong way round, because the threat model stated above is that the
// credential leaks — and an unauthenticated TLS handshake is a way for it to leak. Anyone who
// can answer for `*.postgres.database.azure.com` on the path between Vercel's AWS runtime and
// this server completes a handshake with their own certificate, harvests the login, and
// proxies the session.
//
// The two parameters are here because the two clients that read these strings honour
// different ones. Measured against Prisma 6.19.3 and node-postgres 8.22.0, the pinned
// versions, by dialling a server that answers the SSLRequest and presents a certificate the
// client has no reason to trust:
//
//   `sslmode=verify-full`  is what **libpq** understands — psql, pg_dump and pg_restore, which
//                          must also be given PGSSLROOTCERT pointing at a CA bundle holding
//                          DigiCert Global Root G2 and Microsoft RSA Root CA 2017, because
//                          libpq otherwise looks only in ~/.postgresql/root.crt and fails
//                          closed. Prisma's query and schema engines do read `sslmode`, but
//                          understand only disable/prefer/require: `verify-full` is not a
//                          value they recognise and behaves exactly as `sslmode=nonsense`
//                          does, falling back to the default. Against a server that answers
//                          the SSLRequest with `N`, both continue in cleartext; `require` is
//                          the only value that aborts.
//
//   `sslaccept=strict`     is what **Prisma** understands, and it is the half that
//                          authenticates the server. With it, a self-signed certificate is
//                          refused — "terminated in a root certificate which is not trusted"
//                          — so the platform trust store is consulted, and it already holds
//                          the two roots Flexible Server chains to. It is verify-full and not
//                          verify-ca: given a certificate signed by a supplied root but
//                          naming a different host, the engine refuses with "the
//                          certificate's CN name does not match the passed value".
//                          node-postgres is the mirror image — it reads `sslmode` (both
//                          `require` and `verify-full` force TLS and reject an untrusted
//                          chain) and ignores `sslaccept` completely, sending no SSLRequest
//                          at all when that is the only parameter given.
//
// So the CI administrator path is verified: `sslaccept=strict` is what makes Prisma check the
// chain and the hostname, and that is the parameter `.github/scripts/pg-token-url.sh` emits.
// What neither parameter does is make TLS *mandatory* for Prisma — that is
// `require_secure_transport = ON` above, server-side, which a client cannot talk down.
//
// Measured on Windows, where the engine's TLS backend is SChannel. Which parameters are read,
// and which values are recognised, is connection-string parsing and does not vary by platform;
// the certificate-verification behaviour of the OpenSSL backend the ubuntu-latest runner uses
// is **UNVERIFIED** here.
//
// Neither reaches the wrong parser: the workflow splits these URLs in Node and passes libpq
// only the standard PG* variables, so `sslaccept` never reaches libpq (which would reject it
// as an invalid connection option).
//
// **What is deployed does not match these templates, and that is a live gap rather than a
// note.** These outputs are templates a human pastes from; nothing propagates them. Measured
// 2026-08-05: the Function App's `DATABASE_URL` app setting carries `?sslmode=verify-full`
// and no `sslaccept`, and the two repository secrets were written the same way. Read together
// with the finding just above — `sslmode=verify-full` is inert for Prisma — that means the
// Prisma clients are connecting **without** server-certificate verification today, because
// the only parameter they were given is one whose value they do not recognise.
// Vercel's values are marked sensitive and cannot be read back, so they are unmeasured and
// should be assumed to be in the same state. Closing this means rewriting those settings to
// carry both parameters and re-reading them; it is listed in infra/azure/README.md.
//
// `Postgres identity` → `inspect` asserts this rather than assuming it — it connects with
// PGSSLMODE=verify-full and prints pg_stat_ssl, and a connection that could not verify the
// chain fails there, from a runner, before anything else in that job runs. That covers libpq,
// which is what the workflow uses; it says nothing about the Prisma clients above.
// ---------------------------------------------------------------------------------------
//
// Deliberately no `connection_limit` on either template. It looks like a sensible thing to
// pin and it is not, here: `backgroundUrl()` in packages/db/src/client.ts only injects
// `connection_limit=10` when the URL does not already carry one, so setting a smaller value
// on DATABASE_URL silently shrinks the *background* pool too — while `COMMIT_CONCURRENCY` in
// packages/ingest/src/pipeline.ts still derives 6 concurrent commits from the constant. Six
// commits against five connections is a pool timeout on every drain. Leaving it unset keeps
// the background pool at the 10 `backgroundUrl()` injects, which is what that constant is
// sized against.
var sslArgs = 'sslmode=verify-full&sslaccept=strict'

// The two administrator templates. They belong in GitHub repository secrets and nowhere else:
// `sbadmin` is a member of `azure_pg_admin` and can execute DDL, which `prisma db push` needs
// and a web request never does.
output databaseUrlTemplate string = 'postgresql://${administratorLogin}:<PASSWORD>@${server.properties.fullyQualifiedDomainName}:${pooledPort}/${databaseName}?${sslArgs}${pgBouncerEnabled ? '&pgbouncer=true' : ''}'

output directDatabaseUrlTemplate string = 'postgresql://${administratorLogin}:<PASSWORD>@${server.properties.fullyQualifiedDomainName}:5432/${databaseName}?${sslArgs}'

// The application template — **this is the one Vercel gets**, for both DATABASE_URL and
// DIRECT_DATABASE_URL. `directUrl` in schema.prisma is read by the Prisma CLI, never at
// runtime (apps/web/src/env.ts marks DIRECT_DATABASE_URL optional and nothing else reads it),
// so the web app has no use for a DDL-capable credential and should not carry one.
//
// The role behind it does not exist yet at deployment time — ARM cannot run SQL. It is
// created by hand, by the `The least-privilege application role` step of the runbook in
// infra/azure/README.md, from the connection string built out of this template. That step
// also carries the two checks that assert the boundary: a catalogue query showing the role is
// not a member of azure_pg_admin, and a `CREATE TABLE` attempt made as the role, which must
// be refused.
output applicationDatabaseUrlTemplate string = 'postgresql://${applicationLogin}:<PASSWORD>@${server.properties.fullyQualifiedDomainName}:${pooledPort}/${databaseName}?${sslArgs}${pgBouncerEnabled ? '&pgbouncer=true' : ''}'
