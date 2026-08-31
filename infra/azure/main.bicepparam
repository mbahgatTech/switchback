// Non-secret parameters for infra/azure/main.bicep. Committed on purpose.
//
// The password is not in this file and must never be. `administratorLoginPassword` is declared
// `@secure()` in main.bicep and defaults to empty, so it is not required and a deployment that
// supplies nothing leaves the live credential untouched. It is read from the environment when it
// is supplied at all, which is the one place that is neither this file, nor argv, nor a log line:
//
//   openssl rand -hex 32 > "$TMP/pgpw"
//   if PGADMIN_PASSWORD=$(cat "$TMP/pgpw") && [ -n "$PGADMIN_PASSWORD" ]; then
//     export PGADMIN_PASSWORD
//     az deployment sub create \
//       --name switchback-db --location northcentralus \
//       --template-file infra/azure/main.bicep \
//       --parameters infra/azure/main.bicepparam
//   fi
//   unset PGADMIN_PASSWORD
//
// The deploy sits inside that guard because an empty value is not an error here: the fallback
// below omits the property and the run reports success on a server with no administrator
// password. `export VAR="$(cat …)"` cannot carry the guard, because export reports its own
// status rather than the substitution's.
//
// A `$( )` substitution never reaches the process table, and what lands in shell history is
// the variable name rather than its value. **Record the password before deleting the file** —
// ARM cannot read it back and a redeploy has to pass the same value. README.md's "Read this
// first" inventories where the live one is kept; a copy outside that inventory goes stale
// without saying so. See README.md, "Deploying".
//
// A `.bicepparam` may be combined with further `--parameters name=value` overrides, and
// `.github/scripts/infra-deploy.sh` relies on it — it passes this file and `deployDatabase=false`
// in the same command. Everything non-secret lives here; the secret lives in the environment.

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

// `CanNotDelete` on the resource group — see the long note beside the lock in main.bicep for
// what it protects and what it deliberately does not.
//
// **This needs a role the deployment service principal does not have.** Creating a lock is
// `Microsoft.Authorization/locks/write`, and built-in Contributor lists
// `Microsoft.Authorization/*/Write` in its `notActions`. Attempted 2026-08-01 against this
// exact resource group with the subscription's deploying principal, which holds Contributor at
// subscription scope and nothing else:
//
//   ERROR: (AuthorizationFailed) The client '3ac53469-d72f-4813-b5e8-4bbf937cc76d' with object
//   id 'cf940ed6-1527-47be-9168-3406ef977827' does not have authorization to perform action
//   'Microsoft.Authorization/locks/write' over scope '/subscriptions/5cb9e7c3-.../
//   resourceGroups/rg-switchback-prod-northcentralus/providers/Microsoft.Authorization/locks/
//   switchback-prod-no-delete' or the scope is invalid.
//
// The same error comes back with the lock scoped to the server instead, so it is the action
// that is denied and not the scope. And it is not only `az deployment sub create` that stops:
// `az deployment sub what-if` runs the same preflight authorization check and fails outright
// with `InvalidTemplateDeployment`, so a Contributor cannot even *preview* a deployment while
// this is on. That is why this is an environment override rather than a hard-coded `true`.
//
// The committed intent is `true` — the lock should exist, and a what-if that reports it as
// missing is telling the truth. An operator who does not hold the role exports
// `DEPLOY_DELETE_LOCK=false` for their run, which is enough to get what-if and a redeploy
// working again, and it leaves a visible trace in the shell rather than a quiet edit to this
// file that nobody puts back.
//
// **That override is permanent for this principal — placing the lock does not retire it.** An
// earlier revision of this comment said to remove it "once an Owner has placed the lock", and
// that is wrong. ARM authorizes each declared resource operation at preflight against the
// *action*, not against whether the value would change: a template that declares the lock
// issues a PUT, so every deployment needs `Microsoft.Authorization/locks/write` whether or not
// an identical lock is already sitting there. There is no converged state in which a
// Contributor deploys this template with `deployDeleteLock` true and succeeds. Only a role
// carrying `Microsoft.Authorization/*/Write` changes that.
//
// Epistemic status: reasoned from the permission set, not measured — confirming it means
// running a deployment against the production database, which is not a thing to do to settle a
// comment. What *is* measured is the permission set itself, and it is **two** assignments, not
// one. `az role assignment list --assignee 3ac53469-d72f-4813-b5e8-4bbf937cc76d --all
// --include-inherited`, re-run 2026-08-07:
//
//   Contributor                          /subscriptions/5cb9e7c3-…        2026-03-01T22:12:04Z
//   Role Based Access Control Administrator
//                                        …/rg-switchback-prod-northcentralus  2026-08-03T16:53:36Z
//
// Contributor is the one the error above comes from: `actions: ["*"]` with both
// `Microsoft.Authorization/*/Write` and `Microsoft.Authorization/*/Delete` in `notActions`.
// The second grants `Microsoft.Authorization/roleAssignments/write` and `/delete`, `*/read` and
// `Microsoft.Support/*`, with empty `notActions` — and **no condition**, on the role definition
// (`f58310d9-a9f6-439a-9e8d-f62e7b41a168`) or on the assignment
// (`8baf9393-029a-4226-a882-992a8146d775`). It exists because a Contributor cannot write the role
// assignments the templates declare; `infraContributor` in main.bicep is one, and the three queue
// grants in `infra/azure/ingest.bicep` are more. It was created by the owner's own object id,
// `8c682736-…`, the same one declared as the Entra administrator below.
//
// **State the consequence rather than let it be inferred.** Role Based Access Control
// Administrator does not carry `Microsoft.Authorization/locks/write`, so the override above is
// still needed and the paragraph before it still holds. But an unconditioned
// `roleAssignments/write` at this scope lets the principal assign itself Owner here, and Owner
// carries `Microsoft.Authorization/*` — including `locks/delete`. So the delete lock is a control
// against accident and against any principal holding only Contributor. It is **not** a control
// against this principal, and an earlier revision of this comment claiming it was is wrong.
//
// Constraining it is an owner decision because it can break the deploy path, so it is written
// down rather than done: replace the assignment with one carrying the standard
// `constrainRoles` condition, which permits assigning only the roles named in it.
//
//   az role assignment delete --ids <the assignment id above>
//   az role assignment create --assignee 3ac53469-d72f-4813-b5e8-4bbf937cc76d \
//     --role "Role Based Access Control Administrator" \
//     --scope /subscriptions/5cb9e7c3-…/resourceGroups/rg-switchback-prod-northcentralus \
//     --condition-version 2.0 --condition "<constrainRoles, listing only the roles the
//       templates assign>"
//
// An Owner placing the lock by hand needs the name to match this template exactly, or a later
// deployment adds a second lock beside the first:
//
//   az lock create --name switchback-prod-no-delete --lock-type CanNotDelete \
//     --resource-group rg-switchback-prod-northcentralus --notes "<copy lockNotes from main.bicep>"
param deployDeleteLock = bool(readEnvironmentVariable('DEPLOY_DELETE_LOCK', 'true'))


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

// **`C.UTF-8`, not `en_US.utf8`.** Azure's server-default is `en_US.utf8`, and the two sort
// differently: `C` is byte order, `en_US` is dictionary order, so `ORDER BY name` returns a
// different sequence and the partial unique index `trail_lists_one_system_list_per_user` is
// built under different equality rules. A restore succeeds under either, which is exactly what
// makes the difference dangerous.
//
// Azure accepts the `C.UTF-8` spelling and stores it verbatim, which matters because any
// comparison against `datcollate` is literal: the server also offers a `C.utf8` alias, and that
// would be the same locale under a name that fails the comparison.
//
// Collation is fixed at CREATE DATABASE and cannot be altered afterwards, so changing this
// value means dropping and recreating the database, not redeploying over it.
param databaseCollation = 'C.UTF-8'

// The committed intent is `true` — a from-scratch build must create the database. Against the
// live server it has to be `false`: charset and collation are immutable after CREATE DATABASE
// and the provider refuses a PUT that restates them, so a redeploy fails on this resource
// after the server has already been written. Like `DEPLOY_DELETE_LOCK`, the override is a
// visible act in the shell rather than a quiet edit here that nobody puts back.
//
//   DEPLOY_DATABASE=false
param deployDatabase = bool(readEnvironmentVariable('DEPLOY_DATABASE', 'true'))

param administratorLogin = 'sbadmin'

// The least-privilege role Vercel connects as. Created by hand from the runbook in README.md,
// not by the template — ARM cannot run SQL — and checked there by connecting as it and
// requiring `CREATE TABLE` to be refused.
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

// The resource-group budget was created a month later than the subscription one, and ARM
// refuses to create a monthly budget starting before the current month. See the parameter's
// description in main.bicep.
param workloadBudgetStartDate = '2026-08-01T00:00:00Z'
param budgetEndDate = '2036-07-01T00:00:00Z'

// TLSv1.2 is Azure's default. Raise to 'TLSv1.3' only after a negotiated TLS 1.3 session has
// actually been observed against this server from the machine that will hold the connection.
// See the parameter description in main.bicep.
param minTlsVersion = 'TLSv1.2'

// Entra authentication, on alongside the password login while consumers are moved across.
//
// **Bootstrapping this on a server that does not have it yet takes two deployments**, because
// ARM rejects an `administrators` child while `activeDirectoryAuth` is Disabled — and rejects
// it during `what-if` too, so the run that restarts the database cannot be previewed. Deploy
// once with `entraAdministrators` empty and this true, then again with the list below. On the
// live server this was done imperatively instead, and the deployment that followed converged
// it; see infra/azure/README.md.
param entraAuthEnabled = true

// One federated credential per branch. `master` only: `ci.yml`'s schema push runs there and
// nowhere else, and a credential is an exact-string match with no wildcard, so every extra
// entry is a branch that may assume a Postgres administrator. A scratch branch was trusted
// here while this migration was proved from one; it is not any more.
param ciIdentityBranches = ['master']

// The identity Vercel production and Vercel preview both federate to, and only those two. The
// ingest worker is a separate principal — the Function App's own system-assigned identity, whose
// Postgres role is `sbapp_func` — and stays one; runtime-identity.bicep says why. The name is the
// deployed one: ARM cannot rename a user-assigned identity, so renaming it here would create a
// second one and leave the first holding every live grant.
param runtimeIdentityName = 'id-switchback-vercel-publisher'

// Both halves of every federated-credential subject. Entra matches the subject as an exact
// string, so renaming the Vercel team or the project silently stops the exchange working.
param vercelTeamSlug = 'mbahgattechs-projects'
param vercelProjectName = 'switchback'

// Passwords stay on. Flipping this to `false` is the cutover, and it is gated on every consumer
// having been proved on a token *and* both administrator doors re-proved in the same hour — see
// infra/azure/README.md. It is a separate, reviewable deployment on purpose: the way back from a
// wrong flip is an ARM write that itself needs Entra to be working.
//
// The value is compared against the server's live `authConfig.passwordAuth` before every `main`
// deployment — `.github/scripts/assert-password-auth-param.sh`, called by `infra-deploy.sh`. The
// flip itself is a targeted `az` call, so a parameter left at `true` after it is what would switch
// password authentication back on, and that comparison is what refuses to.
param passwordAuthEnabled = true

// One rule, the whole of IPv4, and the name carries the reason so the portal explains itself.
// Vercel serverless on this plan has no static outbound address and neither do GitHub-hosted
// runners, so there is no range to allow-list and the perimeter is the credential. Four documents
// state this range and `test/firewall-restatements.test.ts` holds them to it; narrowing means
// updating them in the same change. What narrowing would cost is in infra/azure/README.md,
// "Narrowing the firewall".
param databaseFirewallRules = [
  {
    name: 'AllowVercelServerlessNoStaticEgress'
    startIpAddress: '0.0.0.0'
    endIpAddress: '255.255.255.255'
  }
]

// The owner is here as break-glass: a human who can reach the database with a token and no
// password at all, which is what stops "the admin password is not recorded anywhere" from
// being an outage a second time. The Entra-mapped roles the *applications* use are not
// administrators and are not declared here — they are SQL objects, not ARM ones.
//
//   az ad signed-in-user show --query "{id:id,upn:userPrincipalName}" -o json
param entraAdministrators = [
  {
    objectId: '8c682736-d90b-4c33-a718-1916597894f8'
    principalName: 'mazenbahgat_outlook.com#EXT#@mazenbahgatoutlook.onmicrosoft.com'
    principalType: 'User'
  }
]

param tags = {
  app: 'switchback'
  env: 'production'
  managedBy: 'bicep'
  repo: 'mbahgatTech/switchback'
  sourcePath: 'infra/azure'
  costCenter: 'vs-enterprise-monthly-credit'
  dataClassification: 'user-content'
  // Read by anyone opening the portal: what the recovery is if this server is lost.
  rollback: 'azure-pitr-14d-lrs-new-server'
}

// The only secret, and it is not stored here — see the header. Empty when the variable is unset,
// which is the ordinary case: postgres.bicep then omits the property and the live credential is
// left untouched. Export PGADMIN_PASSWORD only to create the server or to rotate on purpose.
param administratorLoginPassword = readEnvironmentVariable('PGADMIN_PASSWORD', '')
