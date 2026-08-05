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
// existing server rather than provisioning beside it.
//
// **"No-op" is a claim someone will check, so here is what checking it actually shows.**
// Re-measured 2026-08-01 with `az deployment sub what-if` against the live deployment: 18
// changes — 11 `NoChange`, 6 `Modify`, 1 `Create`. Most of it is residue that never converges,
// because it is either a value ARM will not read back or a value ARM rewrites on read. Two
// items are not residue: they are real, and they converge the moment this template is next
// deployed. The list is written down so nobody spends an afternoon on it a second time, and
// the two halves are kept apart so nobody dismisses the second half as more of the first.
//
// ---- Permanent residue. Nothing here changes behaviour. ----
//
// 1. `administratorLoginPassword`. ARM has no way to read the current password, so whatever
//    is passed is written. Pass the *same* value every time — a redeploy with a freshly
//    generated password silently rotates the admin credential and every connection string
//    that carries it stops working. See infra/azure/README.md, "Redeploying", which also says
//    where that value has to live for this to be possible at all. This is the one item on the
//    list with teeth.
//
// 2. Three server parameters report as changed on every run and never converge:
//    `log_connections`, `log_disconnections` and `ssl_min_protocol_version`. The template
//    declares `source: 'user-override'`; Azure collapses `source` back to `system-default`
//    whenever the value equals the engine default, which all three do, so what-if reports
//
//      Modify properties.source: "system-default" -> "user-override"
//
//    on each of them, forever. The *values* are correct and are what postgres.bicep intends —
//    re-verified 2026-08-01 with `az postgres flexible-server parameter list`, which reports
//    `require_secure_transport = ON`, `ssl_min_protocol_version = TLSv1.2`,
//    `connection_throttle.enable = on` and `azure.extensions = POSTGIS,PG_TRGM,BTREE_GIST`.
//
// 3. The server resource reports the deletion of five properties the template does not
//    declare, because they are provider-assigned and only exist on read:
//    `dataEncryption` (SystemManaged), `replica`, `replicationRole`, `storage.iops` (240, a
//    function of the size) and `storage.type` (Premium_LRS). Plus `createMode: "Default"`,
//    which is a write-only property that does not read back. Declaring them would mean
//    hard-coding derived values — `storage.iops` in particular moves on its own when autogrow
//    fires, which is exactly the value main.bicepparam warns against pinning.
//
// 4. The diagnostic setting reports `logAnalyticsDestinationType` being removed and its `logs`
//    and `metrics` arrays as changed. Same cause: `AzureDiagnostics` is the provider's default
//    fill-in, and what-if compares arrays it cannot match by identity.
//
// ---- Not residue. These two are real and this template is the correct side of them. ----
//
// 5. `switchback-database`, the resource-group-scoped budget in monitoring.bicep, reports as
//    `Create` because **it does not exist**. Confirmed directly rather than inferred from the
//    what-if:
//
//      az rest --method get --url ".../rg-switchback-prod-northcentralus/providers/
//        Microsoft.Consumption/budgets?api-version=2023-05-01"   ->   { "value": [] }
//
//    monitoring.bicep argues at length for why this budget is the only one whose number is
//    about Postgres. That argument has been true and undeployed since it was written.
//
// 6. `switchback-monthly-credit` reports `Modify`: the live budget still carries the old
//    graded ramp — notifications `half` (50%), `threeQuarters` (75%), `nearlyOut` (90%) —
//    while this file declares the two-notification design the long comment beside the budget
//    below explains, `nearlyOut` (90%) and `overCredit` (100%). `az consumption budget list`
//    reports `notifications: half,nearlyOut,threeQuarters`. So the reasoning below describes
//    an intent, not the deployed state, until the next deployment.
//
// Both of 5 and 6 are fixed by deploying, not by editing this file. Neither was converged at
// the time this note was written, because doing so means passing `administratorLoginPassword`
// and item 1 makes that the one operation on this list that is worth being certain about
// first — a redeploy carrying the wrong value rotates the production credential.
//
// The budget window used to be on this list, because `budgetStartDate` defaulted to
// `utcNow()`. It is now a fixed timestamp passed from main.bicepparam with an explicit
// `endDate`, in the exact form ARM stores (`2026-07-01T00:00:00Z`, not `2026-07-01` — the
// short form deploys identically and then diffs forever), and it converges: the live budget
// reads back `2026-07-01T00:00:00Z` / `2036-07-01T00:00:00Z` and neither appears above.
//
//   openssl rand -hex 32 > "$TMP/pgpw"
//   export PGADMIN_PASSWORD="$(cat "$TMP/pgpw")"
//   az deployment sub create \
//     --name switchback-db \
//     --location northcentralus \
//     --template-file infra/azure/main.bicep \
//     --parameters infra/azure/main.bicepparam
//
// The password reaches the deployment through the environment, read by
// `readEnvironmentVariable` in main.bicepparam, so it never appears in argv, in the process
// table, in shell history, or in a committed file. README.md has the full recipe including
// where the value is kept afterwards.

targetScope = 'subscription'

import { entraAdministrator } from './postgres.bicep'

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
Whether to place a `CanNotDelete` lock on the resource group. See the lock resource below for
what it protects and what it does not.

Default `true`, because a production database with no delete lock is the default this template
should not have. It is a parameter rather than unconditional for one measured reason: creating
a lock needs `Microsoft.Authorization/locks/write`, and the built-in **Contributor** role does
not have it. Contributor's `notActions` — read back from this subscription with
`az role definition list --name Contributor --query "[0].permissions[0].notActions"` — are:

  Microsoft.Authorization/*/Delete
  Microsoft.Authorization/*/Write        <-- covers locks/write
  Microsoft.Authorization/elevateAccess/Action
  ...

So a principal holding only Contributor — which is what the deployment service principal on
this subscription holds, and nothing more — cannot deploy this template with the lock enabled.
It fails with `AuthorizationFailed` before anything else happens, which would take the
README's "redeploy is a no-op" path with it, and that path is also the only documented way to
reapply the *same* admin password. Export `DEPLOY_DELETE_LOCK=false` in that situation — see
`main.bicepparam`, which is where this parameter is bound — deploy, and have someone with Owner
or User Access Administrator create the lock separately:

  az lock create --name switchback-prod-no-delete --lock-type CanNotDelete \\
    --resource-group rg-switchback-prod-northcentralus --notes "..."

**That override does not expire when the lock is placed.** Preflight authorizes the *action*,
so a template declaring this lock issues a PUT and needs `locks/write` on every run, existing
lock or not. A Contributor keeps exporting `false` until the principal is granted a role that
carries `Microsoft.Authorization/*/Write`. See `main.bicepparam` for the measured permission
set behind that.

Note the same `notActions` entry that blocks creation — `Microsoft.Authorization/*/Delete` —
also stops a Contributor **removing** the lock once an Owner has placed it. That asymmetry is
the whole point: the principal the lock defends against cannot lift it.
''')
param deployDeleteLock bool = true

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

@description('''
Declare the database itself. True on a from-scratch build; false against a server that already
has it.

Charset and collation are fixed by `CREATE DATABASE`, so ARM has no update to perform — and
the provider rejects a PUT that merely restates them, including the exact string it reads back
(`Invalid value given for parameter collation`, measured 2026-08-05). A redeploy with this
true fails after the server has already been written. Export `DEPLOY_DATABASE=false` for any
run against the live server; see infra/azure/README.md.
''')
param deployDatabase bool = true

@description('Administrator login. Not `postgres`, `admin`, or `azure_superuser` — reserved.')
param administratorLogin string = 'sbadmin'

@description('''
Login for the least-privilege application role — the credential Vercel carries.

This role is **not** created by this template. ARM cannot run SQL, so a Bicep file can name
the role but cannot bring it into existence, and a security control that only exists in a
comment is worse than a shorter honest list. It is created by hand, by the
`Create the least-privilege application role` step of the runbook in infra/azure/README.md,
which carries the exact SQL; `scripts/verify-migration.ts` then asserts that it exists, that
it is not a member of `azure_pg_admin`, and that it cannot create a table. That assertion is
what makes this comment a claim rather than an intention, and it has been run: 72 checks,
72 passed.

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
Turn Microsoft Entra authentication on without yet declaring who administers it.

**This exists because the two cannot be deployed together.** ARM refuses an
`administrators` child on a server whose `activeDirectoryAuth` is still Disabled, and it
refuses it at *preview* time too — `what-if` returns BadRequest on the administrator rather
than showing the change list, so the one deployment that restarts the production database
would have to be run blind. Setting this true with `entraAdministrators` empty makes the
restart its own reviewable deployment; the administrators go in the next one.

Declaring an administrator turns the feature on regardless, so leaving this false afterwards
does not turn it back off.
''')
param entraAuthEnabled bool = false

@description('''
Microsoft Entra principals that may administer the database.

Empty (the default) leaves nobody declared. A non-empty list turns Entra authentication on
alongside the password login, which is the state this deployment holds while consumers are
moved across one at a time.

**Filling this in on a server whose Entra authentication is still off restarts it** — Azure
installs the `pgaadauth` extension. Use `entraAuthEnabled` to take that restart separately.

  az ad signed-in-user show --query id -o tsv
  az identity show -g <rg> -n <name> --query principalId -o tsv
''')
param entraAdministrators entraAdministrator[] = []

// ---------------------------------------------------------------------------------------
// Budget and alerting
// ---------------------------------------------------------------------------------------

@description('''
Address that receives budget and metric alerts. See `monitoring.bicep`.
''')
param alertEmailAddress string = 'mazenbahgat@outlook.com'

@description('''
Monthly credit on the subscription, in USD. The **subscription**-scoped budget below is
expressed as a fraction of this, so changing the credit changes both of its thresholds.

This is a fact about the offer (`MSDN_2014-09-01`), not a target: it is what the spending
limit deallocates the server for exceeding. Measured subscription spend for July 2026 was
191.39 USD, i.e. already past it, almost entirely from a resource group unrelated to this
workload — which is why the question "is this database getting more expensive" is answered by
a separate resource-group budget rather than by this number.
''')
param monthlyCreditUsd int = 150

@description('''
Budget for this workload alone, in USD, evaluated against `rg-switchback-prod-northcentralus`
only. See `monitoring.bicep`.

Set to the credit rather than to the bill on purpose. Steady state is ~57 USD, so the server
sits at ~38% and the 50 / 75 / 90% thresholds are quiet — while each one still names a real
event: 50% is an autogrow step or Defender being enabled, 75%/90% is the General Purpose
escalation (~137 USD) about to consume the whole credit on its own.
''')
param workloadBudgetUsd int = 150

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

// ---------------------------------------------------------------------------------------
// The delete lock.
//
// **What this is actually defending against, stated concretely.**
//
// Everything in this resource group can be rebuilt from this template in about fifteen
// minutes — except the data, which cannot be rebuilt from anything in this repository. The
// server holds every user account, every recorded GPS track, and 19,157 trails. Deleting a
// Flexible Server takes its automated backups with it: there is no recycle bin, no soft
// delete, and no "restore the server I deleted yesterday". The recovery story for a deleted
// server is the Neon copy named in the `rollback` tag, and that copy stops being current the
// moment cutover finishes.
//
// The realistic ways it goes:
//
//   - `az group delete -g rg-switchback-prod-northcentralus` typed against the wrong shell,
//     or with the wrong subscription selected. `az account show` says `Visual Studio
//     Enterprise Subscription` here and on the other workload in this subscription too.
//   - Any principal with **Contributor** — which the deployment service principal has, at
//     *subscription* scope, not scoped to this group — has `Microsoft.Resources/*/delete`.
//     Contributor is the role people are given so they can deploy; deleting production is
//     included in it for free, and nothing about the grant says so.
//   - A cleanup script that enumerates resource groups and removes ones it does not
//     recognise. `rg-switchback-prod-northcentralus` was created 2026-07-30 and is the newest
//     group in the subscription.
//
// The lock is at **resource-group** scope rather than on the server, and that is a choice
// worth defending. A server-scoped lock leaves `az group delete` blocked too — ARM refuses to
// delete a group containing any locked resource — so the headline protection is the same. But
// a group-scoped lock additionally covers the things that make an incident legible after the
// fact: `log-switchback-prod`, which holds the `log_connections` audit trail postgres.bicep
// exists to produce, and the two metric alerts and the action group, which are what would
// notice the next problem. Losing those is not as bad as losing the database, and it is bad
// enough to be worth the same one line of configuration.
//
// **What it does not do, so nobody mistakes it for more than it is.** `CanNotDelete` blocks
// delete. It does not block `DROP TABLE`, it does not block a bad migration, and it does not
// block writes of any kind — a lock is an ARM control-plane control and Postgres is a data
// plane it has no visibility into. It also does not stop an Owner: removing it is one command,
// which is correct, because the point is to make destruction deliberate rather than
// impossible.
//
// **Status at the time this was committed: the lock is declared here and is NOT yet live.**
// Creating it needs `Microsoft.Authorization/locks/write`, the service principal that deploys
// this subscription holds only Contributor, and Contributor's `notActions` exclude exactly
// that. The attempt and its verbatim error are in the pull request. Until someone with Owner
// or User Access Administrator applies it, `az deployment sub what-if` will report this
// resource as a `Create` — that is an accurate to-do item, not template drift. See
// `deployDeleteLock` above for the escape hatch a Contributor-only deployment needs.
// ---------------------------------------------------------------------------------------

module deleteLock 'lock.bicep' = if (deployDeleteLock) {
  name: 'switchback-lock'
  scope: rg
  params: {
    lockName: 'switchback-prod-no-delete'
    lockNotes: 'Production database for Switchback. This group holds the Postgres server and its only backups, plus the Log Analytics workspace carrying the connection audit log and the alerts that would notice a problem. Deleting the server destroys every user account, every recorded GPS track and 19,157 trails, and the backups go with it. Declared in infra/azure/main.bicep. Removing this lock is a deliberate act: say why, in the pull request that does it.'
  }
}

module monitoring 'monitoring.bicep' = {
  name: 'switchback-monitoring'
  scope: rg
  params: {
    location: location
    tags: tags
    alertEmailAddress: alertEmailAddress
    workloadBudgetUsd: workloadBudgetUsd
    workloadBudgetStartDate: workloadBudgetStartDate
    budgetEndDate: budgetEndDate
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
    deployDatabase: deployDatabase
    administratorLogin: administratorLogin
    applicationLogin: applicationLogin
    administratorLoginPassword: administratorLoginPassword
    minTlsVersion: minTlsVersion
    entraAuthEnabled: entraAuthEnabled
    entraAdministrators: entraAdministrators
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
// Everything above is sized around one fact: this subscription's `spendingLimit` is `On`,
// which means that when the monthly credit is consumed the subscription is *disabled* and
// every resource in it is deallocated. postgres.bicep chooses Burstable over General Purpose
// explicitly to stay at ~38% of the credit rather than ~91%, and README.md argues the same.
// And until this revision, nothing measured it: `az consumption budget list` returned `[]`.
// The first notice of the cliff would have been the site being down — with a recovery of
// either "wait for the next billing month" or "remove the spending limit", which converts the
// subscription to pay-as-you-go and starts charging a card. Neither is a five-minute fix, and
// the symptom table in README.md now carries a row for it.
//
// A note on verifying that claim, because the obvious command no longer shows it: current
// `az` returns `subscriptionPolicies.spendingLimit` as `null` from `az account show`. The
// value is still there on the ARM representation —
//
//   az rest --method get --url "https://management.azure.com/subscriptions/<id>?api-version=2022-12-01"
//     → subscriptionPolicies: { quotaId: "MSDN_2014-09-01", spendingLimit: "On" }
//
// **Two budgets, because one budget was answering two questions and getting both wrong.**
//
// The credit is not dedicated to this workload, and the gap is not small. Measured against
// the live subscription for July 2026 (`Microsoft.CostManagement/query`, ActualCost, grouped
// by ResourceGroupName):
//
//   rg-mazenbahgat-8881                              179.85 USD
//   me_plant-environment_plant_together_centralus     11.52 USD
//   plant_together                                     0.02 USD
//   rg-switchback-prod-northcentralus                  0.00 USD   (created 2026-07-30)
//   ------------------------------------------------------------
//   subscription total                               191.39 USD
//
// So a *subscription*-scoped budget of 150 is at 128% before this database has billed a
// single cent, and the 50 / 75 / 90% thresholds an earlier revision put on it were all
// breached on the day they were created. Three alerts that fire from birth, on spend from a
// resource group nobody here touches, train exactly the shrug this design spends its length
// trying to avoid — and they cannot answer the question they were written to answer, which is
// "is *the database* about to cost more than it should".
//
// The split:
//
//   `switchback-monthly-credit` (here, subscription scope) is the *cliff*. Total spend is what
//   disables the subscription, wherever it comes from, so this one has to stay at subscription
//   scope and has to stay pegged to the credit. Two notifications rather than a graded ramp,
//   because a ramp implies headroom that does not exist: 90% is "the credit is nearly gone"
//   and 100% is "it is gone, and the spending limit will deallocate the database". Both are
//   true *today*, and they will alert on the next evaluation. That is not noise — the
//   subscription really is over its credit, and the reason the server is still running is
//   worth someone establishing from the billing page rather than inferring from this file.
//   What was noise was reading those alerts as a statement about Postgres.
//
//   `switchback-database` (monitoring.bicep, resource-group scope) is *this workload*. It sits
//   at 0.00 USD today and at ~38% of its amount in steady state, so its 50 / 75 / 90%
//   thresholds are all quiet and every one of them means something specific: an autogrow step,
//   Defender being switched on, or the General Purpose escalation.
//
// All thresholds are `Actual` rather than `Forecasted`: a forecast on spend that is nearly a
// flat line is noise, and a false alarm trains the same shrug.
//
// `startDate` must be the first of a month and, for a monthly budget, not in the past at
// creation. It is passed in from main.bicepparam as a fixed date rather than computed with
// `utcNow()`, so this template's output does not depend on the day it is run — see the note
// on the parameter itself.
// ---------------------------------------------------------------------------------------

@description('''
First day of the budget window, UTC, as full ISO-8601 — `yyyy-MM-01T00:00:00Z`. Fixed, not
`utcNow()`.

An earlier revision defaulted this to `utcNow('yyyy-MM-01')`. That made it the one value in
this template that is neither fixed nor a function of the resource group id, which falsified
the "re-running this template is a no-op" claim at the top of this file in a directly
measurable way: `az deployment sub what-if` reported the budget as `Modify` on every run, with

  startDate  "2026-07-01T00:00:00Z" -> "[utcNow('yyyy-MM-01')]"
  endDate    "2036-07-01T00:00:00Z" -> null

— and in a later month the PUT would also move the live budget window forward, on the same
redeploy the header calls "the only documented way to reapply the same admin password". A
budget window that moves because of *when* someone reapplied a password is a surprise nobody
asked for. `endDate` is likewise stated rather than left to the provider, so the deployed
window and the declared window are the same window.

The default carries the `T00:00:00Z` for the same reason main.bicepparam does. A bare
`'2026-07-01'` deploys identically and then reports
`Modify properties.timePeriod.startDate "2026-07-01T00:00:00Z" -> "2026-07-01"` on every
what-if afterwards, because ARM stores and reads back the full form. This default previously
used the bare form, which meant the file documenting that trap shipped it: anyone deploying
main.bicep without main.bicepparam — the what-if in the header runs both together, but a
`--parameters budgetStartDate=` override or a bare template deploy does not — inherited the
permanent diff the paragraph above exists to prevent. Default and parameter file now agree
character for character, so the two cannot disagree.
''')
param budgetStartDate string = '2026-07-01T00:00:00Z'

@description('''
First day of the *resource group* budget's window, UTC, same full ISO-8601 form.

Separate from `budgetStartDate`, and the reason is a rule that only bites on creation: ARM
rejects a new monthly budget whose start date is before the current month —
`Start date for monthly time grain should not be prior to current month` — while an existing
budget keeps whatever date it was created with and can be updated freely. The subscription
budget was created in July 2026 and the resource-group one in August, so a single shared value
cannot deploy both. The paragraph above predicted a stale date would fail a redeploy on the
operation that is riskiest to improvise; this is that failure, and splitting the parameter is
the fix rather than moving the live subscription window.
''')
param workloadBudgetStartDate string = '2026-08-01T00:00:00Z'

@description('''
Last day of the budget window, UTC, in the same full ISO-8601 form as `budgetStartDate`.
Matches what Azure assigns by default.
''')
param budgetEndDate string = '2036-07-01T00:00:00Z'

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: 'switchback-monthly-credit'
  properties: {
    category: 'Cost'
    timeGrain: 'Monthly'
    amount: monthlyCreditUsd
    timePeriod: {
      startDate: budgetStartDate
      endDate: budgetEndDate
    }
    notifications: {
      nearlyOut: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 90
        thresholdType: 'Actual'
        contactEmails: [alertEmailAddress]
        contactGroups: [monitoring.outputs.actionGroupId]
      }
      overCredit: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
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
