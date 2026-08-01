// Non-secret parameters for infra/azure/main.bicep. Committed on purpose.
//
// The password is not in this file and must never be. `administratorLoginPassword` is
// declared `@secure()` with no default in main.bicep, and a `.bicepparam` file has to assign
// every required parameter — so it is read from the environment instead, which is the one
// place that is neither this file, nor argv, nor a log line:
//
//   openssl rand -hex 32 > "$TMP/pgpw"
//   export PGADMIN_PASSWORD="$(cat "$TMP/pgpw")"
//   az deployment sub create \
//     --name switchback-db --location northcentralus \
//     --template-file infra/azure/main.bicep \
//     --parameters infra/azure/main.bicepparam
//   unset PGADMIN_PASSWORD
//
// A `$( )` substitution never reaches the process table, and what lands in shell history is
// the variable name rather than its value. **Put the password in a password manager before
// deleting the file** — it cannot be read back out of ARM, out of a GitHub secret, or out of
// Vercel, and a redeploy has to pass the same value. See README.md, "Deploying".
//
// Note `az` will not accept a `.bicepparam` alongside any other `--parameters` argument, so
// there is no second file to merge in. Everything non-secret lives here; the secret lives in
// the environment.

using './main.bicep'

// North Central US (Chicago). **Not** East US or East US 2 — both are offer-restricted for
// this subscription and cannot provision a Flexible Server at all. Verified 2026-07-30:
//
//   az postgres flexible-server list-skus --location eastus   → 0 editions,
//     "Provisioning is restricted in this region."
//   az postgres flexible-server list-skus --location eastus2  → 0 editions,
//     "Subscriptions are restricted from provisioning in this region."
//   northcentralus / centralus / canadacentral / westus3 → 3 editions each, Burstable present.
//
// The first attempt at this deployment failed on exactly that: `switchback-db` is in the
// subscription's deployment history as `Failed` / `LocationIsOfferRestricted`. See the
// parameter's description in main.bicep for why North Central US is the pick of the four.
param location = 'northcentralus'

param resourceGroupName = 'rg-switchback-prod-northcentralus'
param serverNamePrefix = 'psql-switchback-prod'

// Burstable B2s: 2 vCore, 4 GiB, 414 user connections, ~38% of the monthly credit. The
// General Purpose escalation — which is the only way to get the built-in PgBouncer — is
// `tier = 'GeneralPurpose'` and `skuName = 'Standard_D2ds_v5'`; PgBouncer, the pooled port
// and the `pgbouncer=true` URL parameter all follow automatically from the tier. Read the
// header of postgres.bicep before making that change: it costs ~91% of the credit, and this
// subscription's spending limit deallocates everything when the credit runs out.
param tier = 'Burstable'
param skuName = 'Standard_B2s'

// 64 GiB for the 240 IOPS, not for the capacity — the corpus is ~382 MB. Cannot be shrunk
// afterwards, so this is a permanent floor of a few dollars a month.
//
// **Re-read both of these from `az postgres flexible-server show` before any redeploy.**
// Autogrow is on (see postgres.bicep), Azure grows storage only in irreversible 2x steps, and
// the size-implied performance tier moves with the size: 65536 MB is P6/240 IOPS, 131072 MB
// is P10/500 IOPS. After one autogrow these two values describe a smaller disk on a tier that
// is no longer valid for the actual size, and the redeploy README.md calls a no-op fails —
// which matters because a redeploy is also how the *same* admin password gets reapplied, so a
// stale value here turns a routine reapply into a failed deployment. The `storage_percent`
// alert exists so an autogrow is a message rather than a discovery.
//
//   az postgres flexible-server show \
//     -g rg-switchback-prod-northcentralus -n <server> \
//     --query "{gb:storage.storageSizeGB,tier:storage.tier,autoGrow:storage.autoGrow}"
param storageSizeGB = 64
param storageTier = 'P6'

param backupRetentionDays = 14
param postgresVersion = '17'

param databaseName = 'switchback'

// Must equal Neon's `datcollate`/`datctype`. The migration preflight checked this and refused
// to proceed on a mismatch rather than silently reordering every `ORDER BY name` in the app.
//
// **`C.UTF-8`, not `en_US.utf8`.** Measured on the live source rather than assumed — Neon
// reports `C.UTF-8` for both `datcollate` and `datctype`, while Azure's server-default (and
// what this parameter said until the first real migration run) is `en_US.utf8`. Those two
// sort differently: `C` is byte order, `en_US` is dictionary order, so `ORDER BY name`
// returns a different sequence and the partial unique index
// `trail_lists_one_system_list_per_user` is built under different equality rules. A restore
// succeeds under either, which is exactly what makes the difference dangerous.
//
// Azure accepts the `C.UTF-8` spelling and stores it verbatim, which matters because the
// verifier compares the two `datcollate` strings literally: the server also offers a `C.utf8`
// alias, and that would be the same locale under a name that fails the comparison.
//
// Collation is fixed at CREATE DATABASE and cannot be altered afterwards, so changing this
// value means dropping and recreating the database, not redeploying over it.
param databaseCollation = 'C.UTF-8'

param administratorLogin = 'sbadmin'

// The least-privilege role Vercel connects as. Created by hand from the runbook in README.md,
// not by the template — ARM cannot run SQL — and asserted by scripts/verify-migration.ts.
// `sbadmin` above can DROP TABLE and manage roles and stays in the GitHub secrets that CI
// uses; `sbapp` can only read and write rows, and is the credential that sits on an
// internet-reachable endpoint being used by every web request.
param applicationLogin = 'sbapp'

// Where budget and metric alerts go. See monitoring.bicep — an action group with no receiver
// is a rule that fires into nothing while the portal shows it as configured.
param alertEmailAddress = 'mazenbahgat@outlook.com'

// The subscription's monthly credit, in USD. The subscription-scoped budget in main.bicep is
// pegged to this. The spending limit on this subscription is *On*: exceeding the credit
// disables the subscription and deallocates the server, which is why a budget exists at all.
//
// Note what this number is not: it is not a statement about what this database costs. Measured
// July 2026, subscription spend was 191.39 USD — already over the credit — of which 179.85 came
// from `rg-mazenbahgat-8881` and 0.00 from this workload's resource group. The two budgets are
// split for that reason; see the block above the budget in main.bicep.
param monthlyCreditUsd = 150

// Budget for this resource group alone, in USD, evaluated by the resource-group-scoped budget
// in monitoring.bicep. Same figure as the credit, so ~57 USD steady state reads as ~38% and
// every threshold stays quiet until something actually changes.
param workloadBudgetUsd = 150

// Fixed budget window. **Not `utcNow()`** — an earlier revision computed the start date at
// deployment time, which made `az deployment sub what-if` report the budget as modified on
// every single run and would have silently moved the live window forward on any redeploy made
// in a later month. A start date in the past is fine for an existing budget; it only has to be
// the first of a month and not in the past at the moment of *creation*.
//
// Written as full ISO-8601 with the `T00:00:00Z`, which is the shape ARM stores and reads back.
// A bare `'2026-07-01'` deploys identically and then reports
// `Modify properties.timePeriod.startDate "2026-07-01T00:00:00Z" -> "2026-07-01"` on every
// what-if afterwards — the same permanent-diff problem in a different costume. Measured, not
// guessed.
param budgetStartDate = '2026-07-01T00:00:00Z'
param budgetEndDate = '2036-07-01T00:00:00Z'

// TLSv1.2 is Azure's default and what Neon serves today. Raise to 'TLSv1.3' only after a
// negotiated TLS 1.3 session has actually been observed against this server from the machine
// that will hold the connection — the migration preflight printed the negotiated version for
// exactly this reason. See the parameter description in main.bicep.
param minTlsVersion = 'TLSv1.2'

// Optional Microsoft Entra administrator, so a human can connect without the application's
// password. Empty leaves Entra auth off entirely. Fill both or neither:
//   az ad signed-in-user show --query id -o tsv
param entraAdminObjectId = ''
param entraAdminPrincipalName = ''

param tags = {
  app: 'switchback'
  env: 'production'
  managedBy: 'bicep'
  repo: 'mbahgatTech/switchback'
  sourcePath: 'infra/azure'
  costCenter: 'vs-enterprise-monthly-credit'
  dataClassification: 'user-content'
  // Read by anyone opening the portal: Neon is still live and is the way back.
  rollback: 'neon-us-east-1-retained'
}

// The only secret, and it is not stored here — see the header. No fallback default: a missing
// PGADMIN_PASSWORD must fail the deployment loudly rather than provision a production database
// with something a reader of this file could guess.
param administratorLoginPassword = readEnvironmentVariable('PGADMIN_PASSWORD')
