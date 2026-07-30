// Switchback's production database, as infrastructure.
//
// One resource group holding one Azure Database for PostgreSQL Flexible Server, its
// database, its firewall rule and its server parameters. Nothing else moves: the app stays
// on Vercel, photographs stay in Cloudflare R2, CI stays on GitHub Actions. This file
// replaces Neon and only Neon.
//
// Deployed at subscription scope because it creates its own resource group. A dedicated
// group is worth the extra scope: `az group delete` then becomes a complete, unambiguous
// teardown, the cost view filters to this one workload, and nothing unrelated is collateral
// damage. The alternative — dropping a server into an existing shared group — makes every
// later "is this still needed?" a question nobody can answer.
//
// Re-running this template is a no-op, not a second server. Every name here is either fixed
// or a pure function of the resource group id (`uniqueString`), so a redeploy reconciles the
// existing server rather than provisioning beside it. The one exception is
// `administratorLoginPassword`: ARM has no way to read the current password, so whatever is
// passed is written. Pass the *same* value every time — a redeploy with a freshly generated
// password silently rotates the admin credential and every connection string that carries it
// stops working. See infra/azure/README.md, "Redeploying".
//
//   openssl rand -hex 32 > "$TEMP/pgpw"
//   export PGADMIN_PASSWORD="$(cat "$TEMP/pgpw")"
//   az deployment sub create \
//     --name switchback-db \
//     --location northcentralus \
//     --template-file infra/azure/main.bicep \
//     --parameters infra/azure/main.bicepparam
//
// The password reaches the deployment through the environment, read by
// `readEnvironmentVariable` in main.bicepparam, so it never appears in argv, in the process
// table, in shell history, or in a committed file. README.md has the full recipe including
// what to do with the $TEMP file afterwards.

targetScope = 'subscription'

// ---------------------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------------------

@description('''
Azure region. North Central US (Chicago), and it is chosen from a short list rather than
preferred — **Virginia is not available to this subscription at all.**

Verified 2026-07-30 against subscription 5cb9e7c3 with
`az postgres flexible-server list-skus --location <region>`:

| Region           | Server editions | Reason                                              |
| ---------------- | --------------- | --------------------------------------------------- |
| `eastus`         | 0               | "Provisioning is restricted in this region."        |
| `eastus2`        | 0               | "Subscriptions are restricted from provisioning..." |
| `northcentralus` | 3               | available                                           |
| `centralus`      | 3               | available                                           |
| `canadacentral`  | 3               | available                                           |
| `westus3`        | 3               | available                                           |

The first deployment attempt is in the subscription's history as `switchback-db | Failed`,
`LocationIsOfferRestricted` on the `switchback-postgres` module, for precisely this reason.

Of the four that do work, North Central US is the closest to Vercel's `iad1` (Ashburn,
Virginia), where this project's functions run: Chicago→Ashburn is roughly 20 ms round trip
against the ~1 ms an in-metro region would have given. That cost is real and is paid several
times per page, because a tRPC call here issues several queries — it is the price of the
subscription restriction, not a trade anyone chose. `canadacentral` (Toronto) is comparable
on latency and was passed over only because it moves user data across a border for no
benefit; `centralus` and `westus3` are both further.

Budget the ~20 ms into the post-cutover watch: the p95 of `/nearby` is expected to rise, and
that is the expected outcome rather than a symptom. A Flexible Server cannot be moved between
regions afterwards, so revisiting this means a second migration.
''')
param location string = 'northcentralus'

// ---------------------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------------------

@description('Resource group to create. Dedicated to this workload — see the file header.')
param resourceGroupName string = 'rg-switchback-prod-northcentralus'

@description('''
Prefix for the server name. The deployed name is `<prefix>-<uniqueString(rg.id)>`.

The suffix is not decoration. The firewall below is open to the internet (it has to be —
see postgres.bicep), so the hostname is the only thing standing between a port scanner
walking dictionary names and a live SCRAM handshake. `psql-switchback-prod` is guessable;
`psql-switchback-prod-k7m2q9xw4vhba` is not. That is a noise filter, not a security
boundary, and it is free.

`uniqueString` is deterministic on the resource group id, so this is stable across
redeploys and across `what-if` runs.
''')
param serverNamePrefix string = 'psql-switchback-prod'

// ---------------------------------------------------------------------------------------
// Compute and storage — see postgres.bicep for the reasoning behind each default
// ---------------------------------------------------------------------------------------

@description('Compute tier. Burstable has no built-in PgBouncer; see postgres.bicep.')
@allowed([
  'Burstable'
  'GeneralPurpose'
  'MemoryOptimized'
])
param tier string = 'Burstable'

@description('Compute SKU. Must belong to `tier`. Standard_B2s is 2 vCore / 4 GiB.')
param skuName string = 'Standard_B2s'

@description('Storage in GiB. IOPS is a function of this on Premium SSD v1: 32 buys 120, 64 buys 240.')
param storageSizeGB int = 64

@description('''
Premium SSD performance tier. Must be valid for `storageSizeGB` — P6 is the size-implied
default at 64 GiB and P4 at 32 GiB. Raising it (P10 = 500 IOPS) buys throughput without
buying capacity, billed on the separate IOPS-scaling meter. Change only with a measurement
in hand.
''')
param storageTier string = 'P6'

@description('Backup retention in days. 7 is the default, 35 the maximum.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int = 14

@description('PostgreSQL major version. 17 matches Neon and the CI/local Postgres image.')
param postgresVersion string = '17'

@description('Database name. `switchback`, not Neon\'s `neondb` — see README.md.')
param databaseName string = 'switchback'

@description('''
Database collation and ctype. MUST match Neon\'s, which the migration workflow reads with
`SELECT datcollate FROM pg_database` and refuses to proceed on a mismatch. Restore succeeds
either way, which is the danger: a different collation silently reorders every `ORDER BY
name` and rebuilds `trail_lists_one_system_list_per_user` under different rules.

Neon reports `C.UTF-8` — byte order — not the `en_US.utf8` that Azure creates a server with by
default. Azure stores this spelling verbatim; do not substitute the `C.utf8` alias it also
offers, because the verifier compares the two strings literally. Immutable after
CREATE DATABASE, so a change here means recreating the database rather than redeploying.
''')
param databaseCollation string = 'C.UTF-8'

@description('Administrator login. Not `postgres`, `admin`, or `azure_superuser` — reserved.')
param administratorLogin string = 'sbadmin'

@description('''
Login for the least-privilege application role — the credential Vercel carries.

This role is **not** created by this template. ARM cannot run SQL, so a Bicep file can name
the role but cannot bring it into existence, and a security control that only exists in a
comment is worse than a shorter honest list. It is created by the `Create the least-privilege
application role` step of `.github/workflows/migrate-to-azure.yml`, which runs from a GitHub
Actions runner (the only place in this design that can reach 5432), and `scripts/verify-
migration.ts` then asserts that it exists, that it is not a member of `azure_pg_admin`, and
that it cannot create a table.

The point of it: with a firewall spanning the whole internet the perimeter is a credential,
and the credential handed to every Vercel serverless function should be able to read and
write rows and nothing else. `administratorLogin` above can `DROP TABLE` and manage roles;
it stays in the GitHub repository secrets that CI and the migration use, and never reaches
Vercel.
''')
param applicationLogin string = 'sbapp'

@description('''
Administrator password. No default, `@secure()`, never in a committed parameter file.

Generate it URL-safe. Three places in this repository parse `DATABASE_URL` with the WHATWG
URL parser (`apps/web/src/env.ts`, `packages/db/src/client.ts`, `vitest.config.ts`), and a
`/` in the userinfo — which `openssl rand -base64` emits about half the time — does not
throw. It terminates the authority, the host silently becomes something else, and the
failure names nothing useful. `openssl rand -hex 32` has no such characters.
''')
@secure()
@minLength(24)
param administratorLoginPassword string

@description('''
Minimum TLS version the server will negotiate.

TLSv1.2 rather than TLSv1.3, deliberately, and stated as a parameter so raising it is one
value. TLS 1.2 with modern ciphers is not a weak setting; it is Azure\'s own default and it
is what Neon serves today. TLSv1.3 would be marginally better and carries a real failure
mode: if Prisma\'s Rust query engine cannot negotiate it from wherever Vercel is running,
the connection fails in a way indistinguishable from a firewall or credential problem, and
the machine that owns this repository cannot reach 5432 to tell the difference. The
migration workflow prints the negotiated TLS version from a runner; raise this to TLSv1.3
once that output says 1.3, with evidence rather than optimism.
''')
@allowed([
  'TLSv1.2'
  'TLSv1.3'
])
param minTlsVersion string = 'TLSv1.2'

@description('''
Object id of the Microsoft Entra principal to make a database administrator.

Optional. Empty (the default) leaves Entra authentication off entirely and password
authentication as the only path, which is what the app needs and all it needs. Supplying one
adds an Entra admin *alongside* the password login, so a human or `az` can connect without
sharing the application credential.

  az ad signed-in-user show --query id -o tsv

Password authentication stays enabled either way. Prisma has no Entra token flow; disabling
it breaks the application.
''')
param entraAdminObjectId string = ''

@description('UPN or display name of the Entra admin. Required when `entraAdminObjectId` is set.')
param entraAdminPrincipalName string = ''

// ---------------------------------------------------------------------------------------
// Budget and alerting
// ---------------------------------------------------------------------------------------

@description('''
Address that receives budget and metric alerts. See `monitoring.bicep`.
''')
param alertEmailAddress string = 'mazenbahgat@outlook.com'

@description('''
Monthly credit on the subscription, in USD. The budget below is expressed as a fraction of
this rather than as absolute dollars, so changing the credit changes every threshold.
''')
param monthlyCreditUsd int = 150

// ---------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------

@description('''
Tags applied to the resource group and restated on the server.

`rollback` is here so that someone reading the portal — with no access to the pull request
that created this — learns that Neon is still live and is the fallback, without having to
ask anyone.
''')
param tags object = {
  app: 'switchback'
  env: 'production'
  managedBy: 'bicep'
  repo: 'mbahgatTech/switchback'
  sourcePath: 'infra/azure'
  costCenter: 'vs-enterprise-monthly-credit'
  dataClassification: 'user-content'
  rollback: 'neon-us-east-1-retained'
}

// ---------------------------------------------------------------------------------------

resource rg 'Microsoft.Resources/resourceGroups@2023-07-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module monitoring 'monitoring.bicep' = {
  name: 'switchback-monitoring'
  scope: rg
  params: {
    location: location
    tags: tags
    alertEmailAddress: alertEmailAddress
  }
}

module postgres 'postgres.bicep' = {
  name: 'switchback-postgres'
  scope: rg
  params: {
    location: location
    serverNamePrefix: serverNamePrefix
    tier: tier
    skuName: skuName
    storageSizeGB: storageSizeGB
    storageTier: storageTier
    backupRetentionDays: backupRetentionDays
    postgresVersion: postgresVersion
    databaseName: databaseName
    databaseCollation: databaseCollation
    administratorLogin: administratorLogin
    applicationLogin: applicationLogin
    administratorLoginPassword: administratorLoginPassword
    minTlsVersion: minTlsVersion
    entraAdminObjectId: entraAdminObjectId
    entraAdminPrincipalName: entraAdminPrincipalName
    logAnalyticsWorkspaceId: monitoring.outputs.workspaceId
    alertActionGroupId: monitoring.outputs.actionGroupId
    tags: tags
  }
}

// ---------------------------------------------------------------------------------------
// The budget.
//
// **The single most consequential resource in this file, measured by what its absence costs.**
//
// Everything above is sized around one fact: this subscription's `spendingLimit` is `On`
// (verified live — `az account show --query subscriptionPolicies`), which means that when the
// monthly credit is consumed the subscription is *disabled* and every resource in it is
// deallocated. postgres.bicep chooses Burstable over General Purpose explicitly to stay at
// ~38% of the credit rather than ~91%, and README.md argues the same. And until this
// revision, nothing measured it: `az consumption budget list` returned `[]`. The first notice
// of the cliff would have been the site being down — with a recovery of either "wait for the
// next billing month" or "remove the spending limit", which converts the subscription to
// pay-as-you-go and starts charging a card. Neither is a five-minute fix, and the symptom
// table in README.md now carries a row for it.
//
// The credit is not dedicated to this workload. The same subscription already holds
// `rg-mazenbahgat-8881` — a virtual network, three NSGs, a private-link DNS zone and a WAF
// policy. Those are near-free standing alone, but a WAF policy exists to be attached to an
// Application Gateway or a Front Door, either of which would consume $150 in days. So the
// budget is scoped to the *subscription*, not to this resource group: the thing that can
// take this database offline is total spend, wherever it comes from.
//
// Three thresholds rather than one, at 50 / 75 / 90% — $75, $110, $135 against $150. The
// expected steady state is ~$57, so 50% is already "something changed"; 90% is "act today".
// All are `Actual` rather than `Forecasted`: a forecast on a subscription whose spend is
// nearly a flat line is noise, and a false alarm here trains the same shrug this design has
// spent so much effort avoiding elsewhere.
//
// `startDate` must be the first of a month and, for a monthly budget, not in the past.
// `utcNow()` is evaluated at deployment time, which makes this template's output depend on
// when it is run — normally a smell, here unavoidable and harmless, because ARM reconciles a
// budget by name and a redeploy in a later month simply moves the window forward.
// ---------------------------------------------------------------------------------------

@description('First day of the current month, UTC. See the note above on why this is dynamic.')
param budgetStartDate string = utcNow('yyyy-MM-01')

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: 'switchback-monthly-credit'
  properties: {
    category: 'Cost'
    timeGrain: 'Monthly'
    amount: monthlyCreditUsd
    timePeriod: {
      startDate: budgetStartDate
    }
    notifications: {
      half: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [alertEmailAddress]
        contactGroups: [monitoring.outputs.actionGroupId]
      }
      threeQuarters: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 75
        thresholdType: 'Actual'
        contactEmails: [alertEmailAddress]
        contactGroups: [monitoring.outputs.actionGroupId]
      }
      nearlyOut: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: [alertEmailAddress]
        contactGroups: [monitoring.outputs.actionGroupId]
      }
    }
  }
}

// ---------------------------------------------------------------------------------------
// Outputs — everything needed to build a connection string except the credential itself.
//
// Deployment outputs are readable by anyone with reader access on the deployment and are
// retained in the deployment history, so nothing secret goes here. Not the password, not a
// connection string containing one.
// ---------------------------------------------------------------------------------------

@description('Resource group the server was created in.')
output resourceGroupName string = rg.name

@description('Server resource name — the argument to `az postgres flexible-server ...`.')
output serverName string = postgres.outputs.serverName

@description('Fully qualified hostname. The host in both connection strings.')
output fullyQualifiedDomainName string = postgres.outputs.fullyQualifiedDomainName

@description('Database name.')
output databaseName string = databaseName

@description('Administrator login. Half a credential; the other half is never emitted.')
output administratorLogin string = administratorLogin

@description('Login of the least-privilege application role the migration workflow creates.')
output applicationLogin string = applicationLogin

@description('Port for DATABASE_URL — 6432 when PgBouncer is running, otherwise 5432.')
output pooledPort int = postgres.outputs.pooledPort

@description('Port for DIRECT_DATABASE_URL. Always 5432 — DDL never goes through a pooler.')
output directPort int = 5432

@description('Whether the built-in PgBouncer is running. False on Burstable, which has none.')
output pgBouncerEnabled bool = postgres.outputs.pgBouncerEnabled

@description('''
Shape of the ADMINISTRATOR `DATABASE_URL`, with the credential left as a placeholder.

This is the **migration and CI** credential and belongs in GitHub repository secrets only.
Vercel gets `applicationDatabaseUrlTemplate` below instead — see `applicationLogin`.
''')
output databaseUrlTemplate string = postgres.outputs.databaseUrlTemplate

@description('Shape of the administrator `DIRECT_DATABASE_URL`, credential left as a placeholder.')
output directDatabaseUrlTemplate string = postgres.outputs.directDatabaseUrlTemplate

@description('''
Shape of the APPLICATION connection string — the one Vercel gets, for both `DATABASE_URL` and
`DIRECT_DATABASE_URL`. The role it names is created by the migration workflow, not by this
template.
''')
output applicationDatabaseUrlTemplate string = postgres.outputs.applicationDatabaseUrlTemplate

@description('Log Analytics workspace holding PostgreSQLLogs, including the connection log.')
output logAnalyticsWorkspaceId string = monitoring.outputs.workspaceId
