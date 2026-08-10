# Switchback's production database, on Azure

One **Azure Database for PostgreSQL Flexible Server** — PostgreSQL 17 with PostGIS, in its own
resource group, described entirely in Bicep. It is the whole of Switchback's persistence: the app
runs on Vercel, photographs live in Cloudflare R2, CI runs on GitHub Actions.

**Production has served from Azure since 2026-07-30, about 20:09 UTC.** It is the only copy of
this data.

![Switchback production estate: deployment boundaries, the credentials that cross them, and the absent network boundary](../../docs/diagrams/estate.svg)

Recovery is point-in-time restore into a **new** server, 14 days, locally redundant. There is no
second copy and no geo-redundant backup; see [Backups](#backups).

---

## Read this first

- **The admin password is known again, and it is not the one that was lost.** The old value was
  never recorded anywhere and could not be read back out of ARM, which blocked every redeploy. On
  2026-08-05 it was deliberately _set_ to a freshly generated 48-character value rather than
  recovered — `az rest PATCH` with the body in a file outside the repository, deleted immediately.
  It now lives in **two** verified places: `~/.switchback/pg-sbadmin-password` on the owner's
  machine, readable only by the owner (`LOQ\mazen:(R,W)`, inheritance stripped), and the
  `DIRECT_DATABASE_URL` repository secret. **Nothing reads that secret any more** — the `migrate`
  job mints an Entra token instead, and the backup workflow it also fed has been deleted — so it is
  now a stored production administrator credential with no consumer. It still sets the blast radius
  while it exists: anyone with write access to this repository can add a workflow step that prints
  it, so compromise of repository write access is compromise of the database administrator. Delete
  it and `DATABASE_URL` at step 6 of the cutover, not before — until then they are the way back if
  the token path in `migrate` fails. It remains unreadable from ARM, so a redeploy still has to be
  given the same value. **No copy in a password manager is counted**, because none has been
  observed being made.
- **There is now a path into this database that needs no password at all.** The owner is a declared
  Microsoft Entra administrator; see [Connecting by hand, with no
  password](#connecting-by-hand-with-no-password). That is what stops "the password is not recorded
  anywhere" from ever being an outage again.
- **No SLA.** The subscription is **Visual Studio Enterprise**, which carries dev/test terms and no
  service-level agreement, and Microsoft may suspend instances that look like production use. This
  database is production use. That is a business risk this file cannot mitigate, only name.
- **The spending limit is `On`.** If the credit runs out, Azure **deallocates every resource in the
  subscription** — see the last row of [Signals](#signals-that-something-is-wrong). The
  subscription was already over its $150 credit on other workloads before this database billed
  anything, so headroom here is negative.
- **The two budget drifts are converged.** Both were blocked on the admin password; the deployment
  of 2026-08-05 applied them. The resource-group budget needed its own start date — ARM will not
  create a monthly budget beginning before the current month — which is why `budgetStartDate` and
  `workloadBudgetStartDate` are two parameters rather than one.
- **There is no second copy of this data, and no rollback target.** Recovery is point-in-time
  restore into a **new** Azure server, and nothing else. See [Backups](#backups) and
  [If this server is lost](#if-this-server-is-lost).
- **The portable backup has been proven and is not retained.** Run 31043403970 dumped production,
  restored it and compared it row for row, so the mechanism works. But the dump artifact it
  published was deleted the same day, and the workflow now withholds the dump while the repository
  is public, so **no off-Azure copy of this database exists right now** — only a 26 KiB evidence
  artifact of counts and DDL. The live rollback is Azure point-in-time restore alone. See
  [Backups](#backups).

---

## Something is wrong

### Signals that something is wrong

A 500 on its own tells you nothing. These do:

| Symptom                                                             | Cause                                                               |
| ------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `/api/version` fine, `/nearby` and `/trails/*` 500                  | Prisma cannot reach Azure — firewall, TLS, or wrong port            |
| `prepared statement "s0" already exists`                            | Pooled URL missing `pgbouncer=true` (General Purpose only)          |
| `SSL connection required`                                           | `sslmode=verify-full` missing from a URL                            |
| `function st_dwithin(geography, geography, numeric) does not exist` | PostGIS not created, or not on `search_path`                        |
| `/nearby` correct but slower than 3 s                               | `trails_geom_geography_gist` missing or unused — sequential scan    |
| Search returns nothing for a trail you know exists                  | `trails_search_vector_gin` or `trails_name_trgm` missing            |
| Everyone signed out                                                 | `sessions` rows lost in the window. Expected, self-healing          |
| Every page 1–2 s slower                                             | Wrong region. Not fixable in place                                  |
| Azure active connections pinned at the ceiling                      | Pool sizing — check `BACKGROUND_POOL_SIZE` against the tier         |
| Every route 500, and the server is gone from the portal             | The credit ran out and the spending limit deallocated it. See below |

`/api/version` reads no database, so a green `/api/version` proves nothing about Postgres —
`/nearby` and `/trails/llanberis-path` do.

That last row is the one with no five-minute fix. The recovery is either to wait for the next
billing month or to remove the spending limit, which converts the subscription to pay-as-you-go
and starts charging a card. There is no third option and no other database to serve from while
deciding.

**There is nowhere to roll back to.** Every symptom above has to be diagnosed and fixed in place.
Restoring costs a new server and loses everything written since the restore point, so it is the
answer to data loss, not to a slow page.

### If this server is lost

The recovery is Azure point-in-time restore and nothing else. It is not a rollback: it does not
repoint the site at a second copy, it builds a third one.

1. **Establish what you are recovering from.** A bad `db push`, a deleted row set, and a deleted
   server are three different problems. Only the first two have a restore point that helps.
2. **Pick a target time before the damage.** The window reaches back to
   `2026-07-30T16:32:40Z` at the earliest and 14 days at the most, whichever is later.
3. **Restore into a new server.** `az postgres flexible-server restore` takes `--source-server`
   and creates the server named by `--name`; there is no in-place restore. Budget ~$57/month for
   as long as it exists, against a subscription already over its credit.

   ```bash
   az postgres flexible-server restore \
     --resource-group rg-switchback-prod-northcentralus \
     --name psql-switchback-recover-<yyyymmdd> \
     --source-server psql-switchback-prod-37ywppu5p7fri \
     --restore-time '<iso8601-utc>'
   ```

4. **Re-point Vercel** `DATABASE_URL` / `DIRECT_DATABASE_URL` at the restored host and redeploy.
   The restored server has its own firewall rules, its own admin credential and no Entra
   administrator — expect to reapply all three before anything connects.
5. **Leave the original running and intact** until the cause is understood.

Two limits this does not cover. A restore lands inside the same subscription, so it is no help if
the subscription is what failed — and if the credit ran out and deallocated everything, the
restore target is deallocated too. And deleting a Flexible Server takes its backups with it, so
there is no restore point at all for the one failure the delete lock exists to prevent.

---

## Backups

There is one, and it is not portable.

### Azure point-in-time restore — the only recovery

Free, automatic, and the fastest way back from a bad `db push`. Re-read 2026-08-08:

| Fact                   | Value                                                                      |
| ---------------------- | -------------------------------------------------------------------------- |
| Retention configured   | 14 days, locally redundant, `geoRedundantBackup: Disabled`                 |
| Earliest restore point | `2026-07-30T16:32:40Z` — the server's own creation                         |
| Full backups taken     | Daily, plus continuous transaction logs — Azure's schedule, not a readback |
| Server state           | `Ready`, `replicationRole: Primary` — eligible                             |

```bash
az postgres flexible-server show \
  --resource-group rg-switchback-prod-northcentralus \
  --name psql-switchback-prod-37ywppu5p7fri \
  --query 'backup' -o json
```

**The window is as deep as the server is old, not 14 days.** The server was created on 2026-07-30,
so it becomes a true 14-day window on 2026-08-13; before that the retention setting is a ceiling
rather than a fact. Read the earliest restore point rather than assuming either number:

```bash
az postgres flexible-server show \
  --resource-group rg-switchback-prod-northcentralus \
  --name psql-switchback-prod-37ywppu5p7fri \
  --query 'backup.earliestRestoreDate' -o tsv
```

Two limits worth knowing before relying on it. A restore provisions a **new** Flexible Server —
about $57/month for as long as it exists, against a subscription that is already over its credit
with the spending limit `On`. And it restores into Azure and nowhere else, which is no help if the
subscription is what failed. [If this server is lost](#if-this-server-is-lost) is the procedure.

### The portable half — there is not one

Nothing in this repository takes a logical dump. A workflow did, and it was removed: it needed the
`sbadmin` password to run, which the move to identity retires, and its verified archive landed in a
GitHub Actions artifact — readable by every GitHub account, because this repository is public. Run
31043403970 published a 371 MiB full dump for a day that way. `sessions.sessionToken` and the
`accounts` `refresh_token`, `access_token` and `id_token` columns are stored in plaintext, so those
credentials were treated as compromised and invalidated.

So the restore story is Azure's point-in-time restore and nothing else. That is a real gap and it
has a shape worth stating plainly rather than arguing about: PITR reaches back only as far as the
server's age, restores only into a **new** Azure Flexible Server at roughly $57/month, and is no
help at all if the subscription is what failed. A durable off-Azure copy belongs in a private
container in a Storage account inside `rg-switchback-prod-northcentralus`, where the delete lock,
a lifecycle rule and Azure's own access logs already apply. An Actions artifact is a proving
ground, not a home.

---

## What it provisions

| File                     | What it is                                                                                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main.bicep`             | Subscription-scoped. Creates the resource group, then calls the modules. Outputs the hostname.                                                                                        |
| `postgres.bicep`         | The server: compute, storage, backups, firewall, server parameters, the database.                                                                                                     |
| `monitoring.bicep`       | Log Analytics workspace, the alert action group, and the workload budget.                                                                                                             |
| `lock.bicep`             | The resource group's `CanNotDelete` lock. A module because locks are resource-group scoped.                                                                                           |
| `ci-identity.bicep`      | `id-switchback-postgres-ci` and its federated credential. Zero Azure RBAC, by design.                                                                                                 |
| `runtime-identity.bicep` | `id-switchback-vercel-publisher` and one federated credential per Vercel environment. Declared a second time in `ingest.bicep` — see below.                                           |
| `infra-identity.bicep`   | `id-switchback-infra-deploy`. **Declared, not deployed** — see below.                                                                                                                 |
| `main.bicepparam`        | Every non-secret parameter. Committed. The password is **not** here and never may be.                                                                                                 |
| `ingest.bicep`           | The ingest queue, its worker, `id-switchback-worker-deploy`, and a second declaration of `id-switchback-vercel-publisher`. Resource-group scoped, deployed **separately**. See below. |
| `ingest.bicepparam`      | Its non-secret parameters. The connection string is read from the environment, not stored here. **Compiled by no workflow** — see `docs/architecture.md`.                             |

Three user-assigned identities exist in the resource group — `id-switchback-postgres-ci`,
`id-switchback-vercel-publisher` and `id-switchback-worker-deploy`.
`id-switchback-infra-deploy` is **not** among them: `main.bicep` declares it, no deployment
carrying that module has run, and `grantInfraIdentityContributor` is `false` regardless, so
`infrastructure.yml` compiles templates rather than deploying them. Read it back:

```bash
az identity list -g rg-switchback-prod-northcentralus --query '[].name' -o json
```

**Two templates declare `id-switchback-vercel-publisher`, and a reader converging templates
against the estate should expect that.** `runtime-identity.bicep:57-88`, reached through
`main.bicep`, and `ingest.bicep:365-427` — `publisher`, with `publisherProduction` and
`publisherPreview` — declare the same identity name and the same pair of federated credentials in
the same resource group, which is one live resource with two sources. Whichever template deployed
last owns its `tags`; the live `component` is `ingest-worker`, so `ingest.bicep` is the one that
wrote it. `id-switchback-worker-deploy` is declared in `ingest.bicep` alone.

```bash
az identity show -g rg-switchback-prod-northcentralus -n id-switchback-vercel-publisher \
  --query tags -o json
```

| Resource          | Value                                                           |
| ----------------- | --------------------------------------------------------------- |
| Resource group    | `rg-switchback-prod-northcentralus`                             |
| Region            | North Central US (Chicago)                                      |
| Server            | `psql-switchback-prod-37ywppu5p7fri`                            |
| Version           | PostgreSQL 17, PostGIS 3.6.1                                    |
| Compute           | Burstable `Standard_B2s` — 2 vCore, 4 GiB, 414 user connections |
| Storage           | 64 GiB Premium SSD (240 IOPS), autogrow on                      |
| Backups           | 14 days, locally redundant, no geo-redundancy                   |
| High availability | None                                                            |
| Database          | `switchback`, collation `C.UTF-8`                               |
| Admin login       | `sbadmin`, password, unused by CI; app connects as `sbapp`      |
| Network           | Public, one firewall rule spanning the internet                 |
| Extensions        | `postgis`, `pg_trgm`, `btree_gist` allow-listed                 |
| Delete lock       | `switchback-prod-no-delete`, `CanNotDelete`, **in place**       |
| Authentication    | Microsoft Entra **and** password, both enabled                  |

The server name's 13-character suffix is a pure function of the resource group id, so a redeploy
reconciles this server rather than provisioning beside it.

### Connecting by hand, with no password

This is the break-glass path, and it exists because the admin password once was not recorded
anywhere and nothing could be deployed. It needs no stored credential at all: the owner is a
declared Microsoft Entra administrator of the server, so an `az login` is enough.

**Disconnect ProtonVPN first.** Its `ProTUN` adapter holds the default route and tears the Postgres
session down after the TCP connection is established, which reads as a hung or rejected connection
and sends the reader hunting for a firewall or credential problem. With it disconnected this recipe
works from the owner's machine — run end to end on 2026-08-06, returning `PostgreSQL 17.10` and the
full role census.

```bash
az login
export PGHOST=psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com
export PGUSER="$(az ad signed-in-user show --query userPrincipalName -o tsv)"
export PGDATABASE=switchback
export PGSSLMODE=verify-full
# Without this libpq looks only in ~/.postgresql/root.crt under verify-full and fails closed,
# which reads as a rejected credential. Point it at the system trust store instead.
#   Windows, Git Bash:  export PGSSLROOTCERT="$(cygpath -w /usr/ssl/certs/ca-bundle.crt)"
#   Debian/Ubuntu:      /etc/ssl/certs/ca-certificates.crt
#   Fedora/RHEL:        /etc/pki/tls/certs/ca-bundle.crt
#   macOS + Homebrew:   "$(brew --prefix)/etc/openssl@3/cert.pem"
export PGSSLROOTCERT="$(cygpath -w /usr/ssl/certs/ca-bundle.crt)"
export PGPASSWORD="$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)"
psql -c 'select current_user'
unset PGPASSWORD
```

The username is the full UPN including the `#EXT#` part for a guest account — Azure matches the
token to the role by object id, but the role's _name_ is the UPN, and psql sends the name.

Nothing here needs `psql` specifically. Any libpq or `pg` client works the same way, with the token
in the password field; `node -e` against the repository's own `pg` is a workable substitute on a
machine with no PostgreSQL client installed.

**When that does not work.**

- _The connection hangs, or dies just after connecting._ ProtonVPN. See above; this is the single
  most likely cause on the owner's machine and it does not look like a VPN problem.
- _`root certificate file "…/.postgresql/root.crt" does not exist`_, or a certificate-verify
  failure: `PGSSLROOTCERT` is unset or points at the wrong path for this platform. On Windows the
  bundle ships with Git for Windows at `/usr/ssl/certs/ca-bundle.crt` and libpq needs the Windows
  form of that path, hence `cygpath -w`.
- _The token expired._ Entra issues these with a randomised 60–90 minute life (one measured on
  2026-08-05 carried 78 minutes), so a session opened yesterday needs a fresh one; re-run the
  `PGPASSWORD` line.
- _The password is rejected._ Check `az account show` is the right tenant before suspecting the
  database, and check `PGUSER` is the full UPN.
- _Nothing local works at all._ Run it from a GitHub Actions runner: dispatch the
  `Postgres identity` workflow with the **`inspect`** action, which takes the same federated token
  path and reads the same things, with no password anywhere. **Dispatch it from `master`.** The
  federated credential on `id-switchback-postgres-ci` trusts
  `repo:mbahgatTech@81331884/switchback@1316632119:ref:refs/heads/master` and nothing else, so a
  dispatch from any other branch fails at `azure/login` with `AADSTS700213` quoting a subject that
  appears in no template — which reads as a broken identity rather than a wrong branch. This exact
  path has been run from `master`: run 31254093655 dispatched `inspect` from `master` at `1a477da`
  on 2026-08-08, connected as `id-switchback-postgres-ci` over TLSv1.3, and reported
  `is_admin|true`, `server_version|17.10` and the full role and row-count census.
  `id-switchback-postgres-ci` carries exactly one federated credential — `github-master` — so that
  run is proof of the ref exchange this instruction depends on, and `postgres-entra.yml` has been
  on `master` since `b0b6406`, an ancestor of `origin/master`. The branch constraint is restated
  because it has bitten: run 31063906113 succeeded from `feat/credential-free-postgres` against a
  branch credential that has since been deleted, and run 31088984935, dispatched from a feature
  branch after that deletion, failed at `azure/login` with `AADSTS700213`. Step 5 of the cutover
  asks for both administrator doors to be re-proven in the same hour regardless — a door that
  opened on 2026-08-08 is not a door proven on the day the password stops working.

Do not use `connections_failed` to decide whether the server saw an attempt. It is not zero on this
server and never has been: measured over 2026-08-05T12:00Z–2026-08-06T12:00Z it records 35 failures
across six of twenty-four hourly buckets, from a periodic caller unrelated to whoever is debugging.
A non-zero reading says nothing about your connection.

Password authentication is still enabled, so `sbadmin` remains available as the second break-glass.
Its password is not in ARM and not readable from Vercel, but it **is** in the `DIRECT_DATABASE_URL`
repository secret and in a file on the owner's machine — see "Read this first". It stops being a
door the moment `passwordAuthEnabled` is flipped to false.

### Machine identities

| Principal                        | Database role               | May do                           |
| -------------------------------- | --------------------------- | -------------------------------- |
| Owner (Entra user)               | the UPN                     | administer                       |
| `id-switchback-postgres-ci`      | `id-switchback-postgres-ci` | administer, so `db push` can DDL |
| `id-switchback-vercel-publisher` | `sbapp_vercel`              | exactly what `sbapp` may do      |
| `func-switchback-ingest-…` MSI   | `sbapp_func`                | exactly what `sbapp` may do      |

**One of the two application roles is in use.** The Function App authenticates as `sbapp_func` with
an Entra token — `DATABASE_AUTH=entra`, set there and nowhere else since 2026-08-08T17:27:04Z.
Vercel and every other consumer still authenticates by password as `sbapp`. Read from the live
catalogue on 2026-08-08, `pg_roles` holds `sbadmin`, `sbapp`, `sbapp_vercel`, `sbapp_func`,
`id-switchback-postgres-ci` and the owner's UPN; `sbapp_vercel` and `sbapp_func` carry no password
at all and are members of `sbapp`. There is no `sbapp_runtime` and none is planned.

`id-switchback-vercel-publisher` is the shared runtime identity: Vercel production and Vercel
preview both federate to it, and Postgres cannot tell the two environments apart because the FIC
subject does not survive the token exchange. Two consumers, both Vercel — the resource name is
accurate, and so is the Postgres role it holds, `sbapp_vercel`.

The identity is declared in two templates, `runtime-identity.bicep` and `ingest.bicep`, with
different tags, and the last deploy wins: the live `component` tag is `ingest-worker`. A portal tag
is therefore not evidence of what this identity is for; the templates are.

**The ingest worker is not moving onto it.** Its Service Bus trigger receives as whatever principal
the site runs under, so a worker on the shared identity would need Data Receiver on `ingest-jobs`
put back on the identity every Vercel preview carries — the grant revoked on 2026-08-08. Two
principals with two Postgres roles is the deployed arrangement and the intended one, which is why
`provision` converges both roles rather than folding one into the other.

Each role holds its privileges by membership in `sbapp` rather than by a copied list of grants, so
neither can drift from it — including for a table `prisma db push` creates tomorrow, which
`sbapp`'s default privileges already cover. `infra/postgres-identity/` holds the SQL, and the
`provision` action of the `Postgres identity` workflow applies and re-verifies it. That action must
run from `master`, because the CI identity's federated credential trusts no other ref.

ARM cannot create these: they are SQL objects behind `pgaadauth_create_principal_with_oid`, which
runs in the database as an Entra administrator. A `Microsoft.Resources/deploymentScripts` resource
could run it and keep the call inside the template, and it was rejected: it provisions a container
instance and a storage account on every deployment, on a subscription whose spending limit
deallocates everything when the credit runs out, to run two idempotent statements. The workflow is
declarative in the way that matters — the files are the source of truth, the run re-asserts and
re-verifies them — and costs nothing.

### Cost

| Line                                        | USD / month |
| ------------------------------------------- | ----------- |
| Compute — Burstable `Standard_B2s`          | 49.64       |
| Storage — 64 GiB Premium SSD @ $0.115/GiB   | 7.36        |
| Backup — 14 days, inside the free allotment | 0.00        |
| **Total**                                   | **57.00**   |

Pay-as-you-go list prices for North Central US, verified against the retail API.

The $150 monthly credit is **not** headroom for this workload. Measured for July 2026 with
`Microsoft.CostManagement/query`:

| Resource group                                  | USD        |
| ----------------------------------------------- | ---------- |
| `rg-mazenbahgat-8881`                           | 179.85     |
| `me_plant-environment_plant_together_centralus` | 11.52      |
| `plant_together`                                | 0.02       |
| `rg-switchback-prod-northcentralus`             | 0.00       |
| **Subscription total**                          | **191.39** |

The subscription is already over its credit before this database has billed anything, so the real
headroom is **negative**. The design was already sized to the Burstable tier for exactly this
reason. What it changes is the _alerting_: a subscription-scoped budget cannot say anything about
this database when 94% of the spend is somebody else's, which is why `monitoring.bicep` carries a
second, resource-group-scoped budget.

### The two budgets

Both are live and both report `NoChange` against the template. Verified 2026-08-07 with
`az consumption budget list` and `az deployment sub what-if`.

| Budget                      | Scope          | Thresholds    | What its number is about                            |
| --------------------------- | -------------- | ------------- | --------------------------------------------------- |
| `switchback-monthly-credit` | Subscription   | 90%, 100%     | Total spend, whoever spent it: the credit cliff     |
| `switchback-database`       | Resource group | 50%, 75%, 90% | This workload alone, the only figure about Postgres |

They carry different start dates, and that is not duplication. ARM refuses to create a monthly
budget whose start date is before the current month; the subscription budget was created in July
and holds a live window nobody should move, so it keeps `2026-07-01` while the resource-group one
keeps `2026-08-01`. Hence `budgetStartDate` and `workloadBudgetStartDate`, two different immutable
facts.

Neither needs the admin password — see [Redeploying](#redeploying) for why an unset
`PGADMIN_PASSWORD` leaves the live credential alone.

`main.bicep`'s header lists the rest of the `what-if` change list: provider-assigned residue that
never converges, and the one entry that is a real to-do. Read it before concluding the template has
drifted.

---

## Four decisions that look odd

**North Central US, not Virginia.** Both East US and East US 2 are _offer-restricted_ for this
subscription: `az postgres flexible-server list-skus --location eastus2` returns zero supported
editions and the reason "Subscriptions are restricted from provisioning in this region", and
`eastus` says the same. Of the four regions available — North Central US, Central US, Canada
Central, West US 3 — Chicago is closest to Vercel's `iad1`. So the database is roughly
**20 ms further** from the application than Virginia would have been, and a tRPC call pays that
round trip several times. Pricing is identical, so the $57.00 total is unaffected. A Flexible
Server cannot be moved between regions afterwards.

**Burstable, which means no PgBouncer.** Azure's pooler is not available on this tier. That is a
real loss, bought deliberately: General Purpose `Standard_D2ds_v5` plus this storage is about
$137/month, 91% of the credit, and the spending limit _deallocates every resource_ when the credit
runs out. `Standard_B2s` allows 414 user connections against a Vercel fleet holding at most ~15 per
warm instance, so there is nothing for a pooler to solve yet.

It also deletes a failure class: the pooler runs transaction pooling with
`pgbouncer.max_prepared_statements` defaulting to `0`, and Prisma uses named prepared statements
for essentially every query. Getting that wrong produces intermittent
`prepared statement "s0" already exists` that appears only under concurrency — it passes every
smoke test and fails in production.

Escalating later is two values in `main.bicepparam` (`tier = 'GeneralPurpose'`,
`skuName = 'Standard_D2ds_v5'`) and a redeploy; PgBouncer, the pooled port and the `pgbouncer=true`
URL parameter all follow from the tier. Watch for sustained `active_connections` above ~300, or
`connection_failed` in the server log.

**One firewall rule, `0.0.0.0`–`255.255.255.255`.** Vercel serverless functions on this plan have
no static outbound IPs — dedicated egress is an Enterprise feature — and neither do GitHub-hosted
runners. There is no range to allowlist. A private endpoint is not the alternative it looks like:
it would put the server on an Azure virtual network, and Vercel's functions run in Vercel's own AWS
infrastructure with no route into it. Azure also refuses to mix public and private access and will
not let a server move between them, so choosing private now would be a one-way door.

So the perimeter is a credential, and these are the compensating controls:

- TLS mandatory (`require_secure_transport`) and **verified** rather than merely encrypted — see
  [Connection-string shape](#connection-string-shape) for why `require` would not be enough.
- A 13-character deterministic hostname suffix, so scanners walking dictionary names find nothing.
- A high-entropy, SCRAM-only admin password, and `connection_throttle.enable` backing off repeated
  failed logins.
- `log_connections` / `log_disconnections` shipping to Log Analytics, so an unexpected login leaves
  a record.
- The one that bounds the blast radius: **the credential Vercel carries is `sbapp`, not
  `sbadmin`**. It can read and write rows and is refused `CREATE TABLE` — see
  [The least-privilege application role](#the-least-privilege-application-role) for the check that
  proves it rather than assuming it.

The residual risk is therefore _leakage_ rather than brute force, which makes the credential
inventory the thing to keep honest:

| Store             | Value                 | Read by                       | Notes                                                                                                  |
| ----------------- | --------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------ |
| GitHub secret     | `DATABASE_URL`        | **nothing**                   | `sbadmin`. Deletable at step 6 of the cutover, not before                                              |
| GitHub secret     | `DIRECT_DATABASE_URL` | **nothing**                   | `sbadmin`, and the recorded copy of the admin password. Deletable at step 6 of the cutover, not before |
| GitHub secret     | `VERCEL_DEPLOY_HOOK`  | `ci.yml`'s `deploy` job       | A URL that triggers a production build. No database reach                                              |
| Vercel Production | `DATABASE_URL`        | the web app, on every request | `sbapp` — the web app never carries `sbadmin`                                                          |
| Vercel Production | `DIRECT_DATABASE_URL` | **nothing**                   | `sbapp`. Prisma opens `directUrl` for `db push`, which is CI                                           |
| Vercel Preview    | neither               | —                             | see [Preview has no database](#preview-has-no-database)                                                |

**Neither database secret has a consumer.** `ci.yml`'s `migrate` job declares `id-token: write`,
trades the runner's OIDC assertion for an Azure token against `id-switchback-postgres-ci`, and uses
that token as the database password in all three of its Postgres steps — `assert-pg-admin.ts`,
`npm run db:push` and `converge-runtime-grants.ts`. The schema push therefore authenticates as
`id-switchback-postgres-ci`, **not** as `sbadmin`, which is why `ALTER DEFAULT PRIVILEGES … FOR ROLE
sbadmin` never applied to the tables it created; `ci.yml`'s comment above the grant-convergence step
records what that cost. Both are stored administrator credentials with nothing reading them, kept
only as the way back if the token path fails.

**Vercel's copy of `DIRECT_DATABASE_URL` has no consumer either, for a different reason.**
`schema.prisma` binds it to `directUrl`, which Prisma opens only for `migrate` and `db push` — both
of which run in CI, never on Vercel. `packages/db/src/client.ts` builds every runtime connection
from `DATABASE_URL` alone, and `vercel-build` runs `prisma generate` before `next build`, which
completes with neither variable set. The one remaining mention, in `apps/web/src/env.ts`, is the
guard that refuses a non-Production environment naming the production host: a validation, not a
connection. Step 3 of the cutover therefore converts one Vercel Production variable, not two.

Those three are every GitHub secret the repository holds — the `AZURE_*` ones are gone. Verify
rather than trust this paragraph:

```bash
gh secret list --repo mbahgatTech/switchback                    # three names, timestamps, no values
npx vercel env ls                                               # per-environment presence
git grep -nE 'secrets\.(DIRECT_)?DATABASE_URL' -- '.github/'    # empty: no workflow reads either
git grep -n DIRECT_DATABASE_URL -- apps/ packages/              # schema, env guard, tests. No client
```

`Read by` is measured, and those two greps are the measurement: the first returns nothing, exit 1.
`Value` is not measured — GitHub's API returns names and timestamps, never values, so what each
secret _holds_ is design intent rather than a readback. A workflow can still print a secret, which
is the blast radius named in [Read this first](#read-this-first) and the reason
`DIRECT_DATABASE_URL` counts as a recorded copy of the admin password. Short of writing that
workflow, setting a secret again from a source you trust is the honest way to know what it holds.

### Preview has no database

Vercel Preview holds no `DATABASE_URL`, no `DIRECT_DATABASE_URL` and no `CRON_SECRET`. A preview
deployment builds and serves; the pages that need no data render, and the first Prisma query fails.
That is the intended outcome: a preview has no database of its own, and the only one it could have
reached was production.

**The build must not require the credential.** `next build` evaluates `apps/web/src/env.ts` while
collecting page data, so a required `DATABASE_URL` failed every preview build with
`Invalid environment: DATABASE_URL: Required` and put a red check on every pull request, about
nothing in the pull request. A permanently red check is how a repository learns to ignore a failing
gate. `DATABASE_URL` is therefore optional in exactly one place — `VERCEL_ENV=preview` — and
required on a laptop, in CI and in Production, where the fix is the missing variable.

It held all three until 2026-08-08. The Postgres firewall is a single rule spanning
`0.0.0.0`–`255.255.255.255`, so reachability was never the boundary — holding the connection string
was. Preview runs unreviewed branch code, and at the time `drainIfOwned` drained `ingest_jobs` on
any `trails.browse` request while `INGEST_TRAIL_IDENTITY` was a per-environment variable Preview did
not carry and Production ran on `claim`, so those writes resolved trail identity in the opposite mode
and could insert duplicates into the production corpus. That drainer is deleted and no Vercel process
ingests, so what the rule below now closes is write access to every table a request can reach.

The env vars are the containment; the durable control is in code. `apps/web/src/env.ts` refuses to
start when `VERCEL_ENV` is set to anything but `production` and `DATABASE_URL` or
`DIRECT_DATABASE_URL` names `psql-switchback-prod-37ywppu5p7fri`, so re-adding the variable fails
loudly rather than silently reopening the hole. `apps/web/test/env-preview-database.test.ts` holds
that rule and the optionality above.

**A Preview server of its own was priced and not bought.** The cheapest credible one is Burstable
`B1MS` with 32 GB of Premium SSD: $0.017/vCore-hour and $0.115/GB-month from the retail API for
`northcentralus`, so $12.41 + $3.68 = **$16.09 a month**. Cost is not what decides it — the
subscription's `switchback-monthly-credit` budget reads $14.99 of $150 for August — utility is.
`npm run db:seed` only queues ingest tiles; filling them means Overpass traffic from a second
drainer, which is the writer [C1](#preview-has-no-database) exists to remove. A Preview server would
therefore be an empty database behind a preview that renders an empty map. Buy one when Preview has
a seeding path that is not a second drainer.

**No geo-redundant backup, no high availability, no warm standby.** All three are off.

This is the weak point, said out loud rather than discovered. What is left is locally-redundant
point-in-time restore into a new server, inside the same subscription — so a region-level failure,
or the credit cliff deallocating the subscription, takes the recovery with the original.
`geoRedundantBackup` is **immutable after creation**, so closing this means rebuilding the server
and moving the data again. The cheaper half is a portable dump into a private container in this
resource group, which is a decision nobody has taken yet; see [Backups](#backups).

---

## Deploying

Every shell block below writes intermediate files under `$TMP`. Define it once, before the first
block, and use one shell for the whole procedure:

```bash
TMP="${TMPDIR:-/tmp}"
```

Not `$TEMP`: that is a Windows variable Git Bash inherits and is unset on Linux, macOS and in a
container, where `"$TEMP/pgpw"` expands to `/pgpw` — a write at the filesystem root that either
fails or, as root, succeeds somewhere nobody will think to shred. The admin password is the file in
question.

### Prerequisite: register the resource provider

The first deployment fails with `MissingSubscriptionRegistration` unless this has run. Idempotent,
a minute or two.

```bash
az account set --subscription 5cb9e7c3-0e31-4388-94e9-b36eab4bf977
az provider register --namespace Microsoft.DBforPostgreSQL --wait
```

### Prerequisite: `DEPLOY_DELETE_LOCK=false` unless you can write locks

`main.bicep` declares the resource group's `CanNotDelete` lock and `deployDeleteLock` defaults to
`true`. Creating a lock is `Microsoft.Authorization/locks/write`, which built-in **Contributor**
does not have — it is excluded by the `Microsoft.Authorization/*/Write` entry in Contributor's
`notActions`. The service principal that deploys this subscription holds Contributor at
subscription scope — plus Role Based Access Control Administrator on
`rg-switchback-prod-northcentralus`, which grants role assignments and not locks — so with the
default left alone **both `az deployment sub create` and `az deployment sub what-if` fail** — the
first with `AuthorizationFailed`, the second with `InvalidTemplateDeployment` wrapping the same
denial, because preflight is preflight:

```
ERROR: (AuthorizationFailed) The client '…' does not have authorization to perform action
'Microsoft.Authorization/locks/write' over scope '…/providers/Microsoft.Authorization/locks/
switchback-prod-no-delete' or the scope is invalid.
```

Export the override for the run and both work again:

```bash
export DEPLOY_DELETE_LOCK=false
```

### Prerequisite: `DEPLOY_DATABASE=false` against a server that already has one

`main.bicep` declares the `switchback` database and `deployDatabase` defaults to `true`, which is
right for a from-scratch build and wrong for every redeploy after it. Charset and collation are
fixed by `CREATE DATABASE` and cannot be altered, so ARM has no update to perform — and the
provider does not treat re-declaring them as a no-op. It rejects a PUT carrying the value the
server itself reads back:

```
Invalid value given for parameter collation. Specify a valid parameter value.
```

Measured 2026-08-05 against this server, whose `az postgres flexible-server db show` reports
`"collation": "C.UTF-8"` — the exact string being sent. The deployment fails _after_ the server
resource has been written, which is the worst place to stop.

```bash
export DEPLOY_DATABASE=false
```

### Prerequisite: Entra authentication before Entra administrators

On a server whose `activeDirectoryAuth` is still `Disabled`, ARM refuses an `administrators` child
— and refuses it at preview time too, so `what-if` returns `BadRequest` on that resource instead of
a change list, and the one deployment that restarts the production database cannot be reviewed
first. Bootstrapping therefore takes two runs: one with `entraAuthEnabled = true` and
`entraAdministrators` empty, then one with the list filled in. Enabling it installs the `pgaadauth`
extension and **restarts the server**; adding administrators afterwards does not.

On the live server this was done imperatively, and the deployment that followed converged it. The
restart was watched with the site under a request every twenty seconds and never dropped one.

**A failed run is genuinely a no-op — it does not rotate the admin password.** ARM authorizes the
whole template at preflight, before any resource is touched, so the deployment is rejected rather
than partially applied and `administratorLoginPassword` is never written.

Leave the committed default at `true`, and expect to keep exporting the override: ARM authorizes
each declared operation against the _action_, not against whether the value would change, so a
template that declares the lock issues a PUT and needs the permission on every run, lock already in
place or not. **The override is permanent for a Contributor-only principal** — do not read it as
drift. The same `notActions` entry means a Contributor cannot _remove_ the lock either, which is
the point of the design.

### Deploy

The admin password never reaches `argv`, a committed file, or a log line. It is generated into a
file under `$TMP`, exported into the environment, and read from there by `readEnvironmentVariable`
in `main.bicepparam`.

`openssl rand -hex 32` rather than `-base64`, and that is not a style preference: three places in
this repository parse `DATABASE_URL` with the WHATWG URL parser (`apps/web/src/env.ts`,
`packages/db/src/client.ts`, `vitest.config.ts`). A `/` in the userinfo — which base64 emits about
half the time — does **not** throw. It terminates the authority, the host silently becomes
something else, and the failure names nothing useful. Hex has no such characters.

```bash
openssl rand -hex 32 > "$TMP/pgpw"
export PGADMIN_PASSWORD="$(cat "$TMP/pgpw")"

az deployment sub create \
  --name switchback-db \
  --location northcentralus \
  --template-file infra/azure/main.bicep \
  --parameters infra/azure/main.bicepparam
```

**Record that password now, before going any further**, in the places [Read this
first](#read-this-first) inventories. This is the only moment it is readable — see
[Redeploying](#redeploying) for what depends on it.

Read the outputs — hostname, ports, and the two connection-string templates, none of which contains
the password:

```bash
az deployment sub show --name switchback-db --query properties.outputs -o json
```

Then shred the scratch files. This is **not** an archival step; the copies recorded above are the
only ones that survive:

```bash
rm -f "$TMP/pgpw"
unset PGADMIN_PASSWORD
```

**Preview before applying**, especially on a redeploy:

```bash
az deployment sub what-if \
  --location northcentralus \
  --template-file infra/azure/main.bicep \
  --parameters infra/azure/main.bicepparam
```

`what-if` runs the same preflight authorization check as a real deployment, and reports its failure
as `InvalidTemplateDeployment` wrapping `Authorization failed for template resource
'switchback-prod-no-delete'` — so grepping for `AuthorizationFailed` alone will miss it.

### Connection-string shape

On the Burstable tier every URL uses port **5432** and none carries `pgbouncer=true`:

```
postgresql://sbadmin:…@<host>:5432/switchback?sslmode=verify-full&sslaccept=strict
postgresql://sbapp:…@<host>:5432/switchback?sslmode=verify-full&sslaccept=strict
```

`sslmode=verify-full` rather than `require` is load-bearing — see the note at the foot of
`postgres.bicep`. `require` encrypts the session and then accepts whatever certificate it is
handed, which on an endpoint reachable from all of IPv4 authenticates nothing.

`sslaccept=strict` sits alongside it for Prisma, and it is the half that authenticates the server
to a Prisma client. Measured against Prisma 6.19.3: `sslaccept=strict` makes the engine check the
certificate chain against the platform trust store and the hostname against the certificate — full
verification, not chain-only. Prisma does read `sslmode`, but understands only
`disable`/`prefer`/`require`; `verify-full` is not a value it recognises, so that parameter does
nothing for Prisma and is present for libpq, which needs it and would reject `sslaccept` as an
invalid option. Neither parameter makes TLS mandatory for Prisma — `require_secure_transport` on
the server does that. libpq consumers — `psql`, `pg_dump`, `pg_restore`, the workflows — read
`sslmode=verify-full` and verify.

A URL carrying `sslmode=verify-full` alone therefore leaves a Prisma client's TLS unverified, which
is the state the deployed app settings are in; see the note at the foot of `postgres.bicep`.

libpq looks for a root store in `~/.postgresql/root.crt` and fails closed when it is absent, so
anything running `psql`, `pg_dump` or `pg_restore` against these URLs must also set
`PGSSLROOTCERT` to a bundle containing DigiCert Global Root G2 and Microsoft RSA Root CA 2017. On
Debian and Ubuntu that is `/etc/ssl/certs/ca-certificates.crt`; both roots are already in it.

#### `DATABASE_AUTH`: the switch that takes the password out

Each application consumer moves off its password on its own, by setting one variable. It defaults
to `password`, so a deploy that does not set it behaves exactly as before.

| Value          | Who sets it             | Credential                                                 |
| -------------- | ----------------------- | ---------------------------------------------------------- |
| `password`     | default                 | the password in `DATABASE_URL`                             |
| `entra`        | Function App, operators | `DefaultAzureCredential` — managed identity, or `az login` |
| `entra-vercel` | Vercel                  | the per-request OIDC token, exchanged for an access token  |

Under either Entra value `DATABASE_URL` must carry **no password** and the username becomes the
Entra-mapped role for that consumer's own principal — `sbapp_vercel` on Vercel, `sbapp_func` on the
Function App:

```
postgresql://sbapp_vercel@<host>:5432/switchback?sslmode=verify-full
postgresql://sbapp_func@<host>:5432/switchback?sslmode=verify-full
```

A URL that still has a password in it is rejected at construction rather than quietly preferred, so
a half-finished cutover fails loudly. `entra-vercel` additionally needs `AZURE_TENANT_ID` and
`AZURE_CLIENT_ID` (the **client** id of `id-switchback-vercel-publisher`, not its principal id).

On this path Prisma is driven through `@prisma/adapter-pg`, which means `sslmode` is finally read
and enforced — and also that `connection_limit` and `pool_timeout` in the URL stop having any
effect, because the adapter bypasses the connection string. Both pool sizes are set in
`packages/db/src/client.ts` instead.

`DATABASE_URL` and `DIRECT_DATABASE_URL` are identical on this tier, and that is correct rather
than redundant — `schema.prisma` declares `directUrl` against it for the `db push` CI runs, and
keeping the split means the eventual General Purpose escalation is a pure environment-variable
change with no code diff. On General Purpose, `DATABASE_URL` moves to `:6432` and gains
`&pgbouncer=true`.

Do **not** add `connection_limit` to either URL. `backgroundUrl()` in `packages/db/src/client.ts`
only injects `connection_limit=10` when the URL does not already carry one, so setting a smaller
value on `DATABASE_URL` silently shrinks the _ingest_ pool too — while `COMMIT_CONCURRENCY` in
`packages/ingest/src/pipeline.ts` still derives six concurrent commits from the unchanged constant.
Six commits against five connections is a pool timeout on every drain.

### Redeploying

Re-running the template is a no-op, not a second server. `main.bicep`'s header lists the properties
`what-if` reports and which never converge; read that before concluding it has drifted.

**The admin password is written only when you supply one.** ARM cannot read the current password
back, so any value passed is written — which used to make every redeploy a rotation risk, because
`PGADMIN_PASSWORD` was required. It is not any more: `main.bicepparam` falls back to empty and
`postgres.bicep` omits the property entirely when it is empty, so an ordinary redeploy leaves the
live credential untouched. Export `PGADMIN_PASSWORD` only when creating the server or when you mean
to rotate, and when you rotate, every connection string carrying the old value stops working —
including the ones Vercel is serving the site with.

If you do intend to keep a value, put it where [Read this first](#read-this-first) already counts it:
`~/.switchback/pg-sbadmin-password`, owner-readable only, and the `DIRECT_DATABASE_URL` repository
secret. Not the `$TMP` file, which the deploy procedure shreds; not Vercel, which is deliberately
never given the admin credential. The repository secret is readable only by a workflow that prints
it — the API returns names and timestamps, never values — which is both why it counts as a copy and
why it sets the blast radius. A value kept anywhere else is outside that inventory, and the inventory
goes stale without saying so.

Deleting a Flexible Server deletes all of its backups, irrecoverably, which is what the resource
group's `CanNotDelete` lock exists to prevent.

### The delete lock

`switchback-prod-no-delete` is **in place** on `rg-switchback-prod-northcentralus`. Confirm with:

```bash
az lock list --resource-group rg-switchback-prod-northcentralus -o table
```

It is declared in `main.bicep` (module `deleteLock`, in `lock.bicep`), so deploying as a principal
that can write locks maintains it:

```bash
unset DEPLOY_DELETE_LOCK          # or export DEPLOY_DELETE_LOCK=true
unset PGADMIN_PASSWORD            # this deployment has no reason to write the credential
# …then deploy exactly as under "Deploy"
```

Placing the lock needs no admin password; the `unset` above is what keeps it that way. Export it
here only if you also mean to rotate — and rotating breaks every
connection string carrying the old value, including the ones Vercel is serving the site with.

If the lock has to be replaced by hand instead — by an Owner who is not running the deployment —
the name must match the template **exactly**, or the next deployment adds a second lock beside the
first and `what-if` reports `switchback-prod-no-delete` as a `Create` in perpetuity:

```bash
az lock create --name switchback-prod-no-delete --lock-type CanNotDelete \
  --resource-group rg-switchback-prod-northcentralus \
  --notes "Production database for Switchback. This group holds the Postgres server and its only backups, plus the Log Analytics workspace carrying the connection audit log and the alerts that would notice a problem. Deleting the server destroys every user account, every recorded GPS track and 19,157 trails, and the backups go with it. Declared in infra/azure/main.bicep. Removing this lock is a deliberate act: say why, in the pull request that does it."
```

Copy the `--notes` text from `lockNotes` in `main.bicep` rather than writing your own: `what-if`
compares declared properties, not just existence, so notes that differ read as a permanent `Modify`
— the same never-converging diff as a wrong name, in a quieter costume. The live notes match
`lockNotes` character for character, and `what-if` reports the lock as `NoChange`.

---

## The least-privilege application role

`sbapp` is the credential Vercel carries. ARM cannot run SQL, so `postgres.bicep` names the role
but cannot create it. This step does, and has to be run again against any rebuilt server.

Pick a _different_ password from `sbadmin`'s — the whole point is that a leak of the web credential
is not a leak of the admin one. Connect as `sbadmin` with `psql`, then:

```sql
-- Substitute the sbapp password by hand. Deliberately a plain top-level statement rather than
-- a DO $$ … $$ block: a statement executed through PL/pgSQL `EXECUTE format(…%L…)` is quoted
-- back verbatim in PostgreSQL's `CONTEXT:` line when it raises, which means a failure prints
-- the password in cleartext to whatever is reading stderr. A top-level statement's error does
-- not quote its own text. If you do wrap this in a DO block, pass `-v VERBOSITY=terse` to psql,
-- which suppresses DETAIL/HINT/CONTEXT.
CREATE ROLE sbapp LOGIN PASSWORD '…';
-- …or, if it already exists:
-- ALTER ROLE sbapp LOGIN PASSWORD '…';

REVOKE ALL ON SCHEMA public FROM sbapp;
GRANT CONNECT ON DATABASE switchback TO sbapp;
GRANT USAGE ON SCHEMA public TO sbapp;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sbapp;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sbapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO sbapp;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO sbapp;
```

The two `ALTER DEFAULT PRIVILEGES` statements are the ones people leave out. Without them the
grants cover the tables that exist right now, and the next `prisma db push` that adds a table
produces a `permission denied` on a table the app has never seen — at runtime, in production, on
whichever page reads it first.

Then confirm the boundary rather than assuming it:

```sql
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls,
       pg_has_role(rolname, 'azure_pg_admin', 'member') AS is_pg_admin
FROM pg_roles WHERE rolname = 'sbapp';
```

All six should be false. Then assert it from the other side, by connecting _as_ `sbapp` and trying
the thing it must not be able to do — the version that a misread catalogue cannot fool. Run it
against any rebuilt server; **it is supposed to fail**:

```bash
psql "postgresql://sbapp:PASSWORD@psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com:5432/switchback?sslmode=verify-full" \
  -v ON_ERROR_STOP=1 -c 'CREATE TABLE least_privilege_probe (id int)'
```

A `permission denied` error and a non-zero exit is the pass. A created table is the failure: drop
it, and re-run the `REVOKE`/`GRANT` block above.

---

## Taking the password out

A separate cutover, not yet run, and its order is not negotiable — turning `passwordAuth` off while
any consumer still needs one takes the site down, and the way back is an ARM write that itself
authenticates against Entra.

Two flags carry it, and each is a rollback rather than a one-way door. `DATABASE_AUTH` moves one
consumer at a time and defaults to `password`, so a consumer that misbehaves is reverted by unsetting
one environment variable and redeploying. `passwordAuthEnabled` in `main.bicepparam` is the server
side and stays `true` until every consumer has been proved on a token.

1. **Done: the Function App is on Entra.** `databaseAuth='entra'` and an `INGEST_DATABASE_URL`
   naming `sbapp_func` with no password in it, deployed 2026-08-08T17:27:04Z. `entraPoolConfig`
   refuses a URL that still carries a password, so a half-done flip fails at connect rather than
   quietly preferring it. The deployment wrote two application settings on the Function App and
   touched no `Microsoft.DBforPostgreSQL` resource — `ingest.bicep` declares none — so it cost an
   app restart, not a server one. The proof is the `ingestPump` heartbeat, whose gauges come out of
   `ingest_jobs`: `dead=1 staleLeases=1` at 17:45:12Z and `staleLeases=0` at 17:46:00Z.

   Reverting is `databaseAuth='password'` with a `databaseUrl` carrying `sbapp`'s password,
   redeployed. That deployment rewrites the whole application-settings collection, so export the
   live `INGEST_PACKAGE_URL` with it — the parameter has no fallback, so an unset one fails the
   build rather than moving the app onto another package.

   **Do not move the Function App onto the shared identity.** The shared identity's
   Service Bus Data Receiver was revoked on 2026-08-08 precisely because it is drain capability for
   every Vercel deployment, previews included; a worker running as that identity would need the
   grant back, and `ingest.bicep` no longer declares it. Two principals with two Postgres roles is
   the cheaper arrangement, and it is what is deployed.

2. Run `Postgres identity` → `provision`, **from `master`** — the CI identity's federated credential
   trusts no other ref, and a dispatch from a branch fails at `azure/login` with `AADSTS700213`. It
   applies `roles.sql` against `postgres` and `grants.sql` against `switchback`, then asserts the
   result: each role mapped to the object id the run was given, no grant held directly rather than
   inherited, no membership beyond `sbapp`, and `CREATE TABLE` refused when it `SET ROLE`s into each.
   Against the deployed estate every write in it is idempotent — both roles exist, both memberships
   already hold — so what the run is worth is the assertions. It is not the read-only door, though:
   that is `inspect`, which asserts nothing. And it repairs nothing. Creation is guarded on the
   role's _name_, so an identity recreated since leaves a role mapped to an object id that no longer
   exists, and the job raises rather than remapping it.
3. Convert Vercel **Production**, and only Production: set `DATABASE_AUTH=entra-vercel` and rewrite
   `DATABASE_URL` to the password-free form naming `sbapp_vercel`. `AZURE_TENANT_ID` and
   `AZURE_CLIENT_ID` are already set there, which is the whole of what `entra-vercel` needs beyond
   the URL. Redeploy, then prove a signed-in read and a write — `session.findUnique` is the canary.
   The way back is deleting `DATABASE_AUTH`, restoring the password-carrying `DATABASE_URL`, and
   redeploying: absent resolves to `password`, but neither variable reaches the running deployment
   until a new build.

   **Preview is out of scope and cannot be brought into it as the estate stands**, so there is no
   rehearsal environment for this step. Preview holds no `DATABASE_URL` — `npx vercel env ls` lists
   that variable and `DIRECT_DATABASE_URL` under Production alone — so there is no connection there
   to move; and `apps/web/src/env.ts` refuses any `VERCEL_ENV` other than `production` whose
   `DATABASE_URL` or `DIRECT_DATABASE_URL` names `psql-switchback-prod-37ywppu5p7fri`, so it cannot
   be handed the production URL to rehearse against, password-free or not. What replaces the
   rehearsal is the size of the rollback: two variables and a redeploy, with the server still
   accepting passwords until step 6. Preview becomes a rehearsal again on the day it has a database
   of its own — see [Preview has no database](#preview-has-no-database).

4. Deploy `ingest.bicep` with the step-1 parameters and prove a tile ingests end to end. Use the
   export set in [Deploying it](#deploying-it) rather than a shorter one: every variable there has
   no fallback, so a missing one fails the build instead of writing a wrong value. Confirm the
   settings landed with `az functionapp config appsettings list -o json` — an ARM
   application-settings write replaces the collection whole, and that read is the only thing that
   can confirm what it wrote.
5. Re-prove **both** administrator doors in the same hour: `Postgres identity` → `inspect` from
   `master`, and the owner connecting from their own machine with ProtonVPN disconnected. Not "it
   worked last week".
6. Only now set `passwordAuthEnabled = false` and deploy.

One thing to settle before step 6, and one already settled. The `migrate` job in `ci.yml` mints its
own token and reads neither `secrets.DATABASE_URL` nor `secrets.DIRECT_DATABASE_URL`, and both
halves of it have run on `master` over that token. The unconditional half — `azure/login` and grant
convergence — ran in run 31246622902. The half gated on `packages/db/prisma/` changing ran in run
31183187247, which carried `244edf6` and its change to `spatial.sql`: `assert-pg-admin.ts`,
`npm run db:generate` and `npm run db:push` each reported `success` against production, and those
same three steps report `skipped` in 31246622902, which is what tells the two halves apart. No
no-op schema commit is outstanding. What does still need settling is `.env` on the owner's machine,
which points at production — point it at the local Docker Postgres first, or every db script,
`npm run dev` and the e2e suite stop working at step 6 with a connection error and no explanation.

After step 6 the recorded `sbadmin` password stops being break-glass. It is not a door any more; the
server refuses password authentication outright, and from step 6 onward the template needs no
password at all — so the accidental-rotation hazard is gone rather than dormant.

**Rolling step 6 back — set `passwordAuthEnabled = true` and export the password with it.**

```bash
# The recorded value. Without it the deploy omits the property and writes no password.
export PGADMIN_PASSWORD="$(cat ~/.switchback/pg-sbadmin-password)"
```

Then deploy with `passwordAuthEnabled = true`. The export is not optional politeness.
`writeAdministratorPassword` in `postgres.bicep` is `passwordAuthEnabled && !empty(...)`, so a
reversal run with no password exported omits `administratorLoginPassword` from the payload
entirely and **still reports success** — leaving password authentication switched on over whatever
verifier the server happens to hold. Exporting the recorded value makes the reversal write a
credential known to work, which costs nothing if the old verifier survived and is the whole
rollback if it did not.

Whether the SCRAM verifier survives a Disable → Enable cycle is **UNVERIFIED**. Nothing in this
repository establishes it either way, Microsoft's documentation does not say, and measuring it
needs a throwaway Flexible Server the subscription cannot currently afford (~$57/month, and it is
already over its credit with the spending limit on). Treat the recorded password as the thing that
makes the reversal work rather than as a formality, and do not clear the hash on the way in — an
inert hash costs nothing while `passwordAuth` is Disabled and is the cheap half of the way back.

**Never deploy this resource group in Complete mode.** Incremental deployments leave undeclared
children alone, so the `administrators` entries survive a run with an accidentally-empty
`entraAdministrators`. Complete mode would remove both administrators in one operation, and with
passwords off that is a total lockout with no way to grant anything back.

---

## Loading bulk data into this server

The local route to Azure **corrupts TLS records under sustained `COPY`**
(`SSL error: sslv3 alert bad record mac`), which has killed both a 4-way parallel `pg_restore` and a
single-stream one part way through. A GitHub-hosted runner does not have this problem. From a
workstation, load table by table with retries and split the largest table into chunks.

---

## The ingest queue and its worker

`ingest.bicep` adds a Service Bus queue and an Azure Functions worker that drains `ingest_jobs`
continuously, replacing a once-daily Vercel cron that claimed four tiles a run against a backlog of
14,320.

**It is a separate template, at resource-group scope, and that is the point.** It never declares the
server, its database, its firewall rules or its parameters. `administratorLoginPassword` is
`@secure()` with no default and ARM cannot read the current value back, so any deployment that
includes `postgres.bicep` writes whatever it is handed. The live value is recorded — see [Read this
first](#read-this-first) — but ARM cannot consult that record, so handing the wrong value to a
template that declares the server rotates the production credential. Shipping a queue must not be the
same operation as rotating the production password. `main.bicep` is not modified by this work and is
not redeployed by it. There is no lock resource here either: the group's existing `CanNotDelete` does
not block creates.

| Resource        | Value                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------- |
| Namespace       | `sb-switchback-prod-37ywppu5p7fri`, **Standard**, `disableLocalAuth: true` — no SAS         |
| Queue           | `ingest-jobs`, `lockDuration PT5M`, `maxDeliveryCount 5`, TTL `PT1H`, no sessions           |
| Publisher       | `id-switchback-vercel-publisher`, user-assigned, two Vercel federated credentials           |
| Publisher creds | Vercel OIDC token exchanged for an Entra token — **no key anywhere**                        |
| Worker          | `func-switchback-ingest-37ywppu5p7fri`, Linux Consumption (Y1), Node 22                     |
| Worker creds    | System-assigned identity, **Data Sender + Data Receiver scoped to the queue**               |
| Storage         | `stsbingest37ywppu5p7fri`, `allowSharedKeyAccess: false` — the keys authorise nothing       |
| Host storage    | `AzureWebJobsStorage__*` over the worker's identity; no Azure Files content share           |
| Plan            | `plan-switchback-ingest`, Y1 Dynamic, `functionAppScaleLimit: 1`                            |
| Telemetry       | `appi-switchback-ingest`, workspace-based onto the existing `log-switchback-prod`           |
| Alert           | Seven rules onto `ag-switchback-prod` — see [What each alert means](#what-each-alert-means) |
| Cost            | ~$10/month Standard namespace; Consumption and the storage account are inside the free      |

The storage row is checkable in two commands, and the pair is what proves key auth is refused
rather than merely unconfigured:

```bash
az storage blob list --account-name stsbingest37ywppu5p7fri --container-name function-releases \
  --auth-mode key -o json     # ERROR: Key based authentication is not permitted on this storage account.  (exit 1)
az storage blob list --account-name stsbingest37ywppu5p7fri --container-name function-releases \
  --auth-mode login -o json   # the package blob                                                            (exit 0)
```

### What each alert means

Every rule here is meant to satisfy one test: it fires only when a human should do something, and it
stops firing when they no longer should. Counts are breaching fifteen-minute evaluation windows over
the 48 h to 2026-08-09T21:12Z, measured against `AppTraces`/`AppRequests` in
`log-switchback-prod`.

| Rule                                 | Sev | Fires when                                                                                           | Clears when                           | 48 h |
| ------------------------------------ | --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------- | ---- |
| `switchback-ingest-worker-silent`    | 2   | No `queue-health` heartbeat for 30 min                                                               | A heartbeat lands                     | 34   |
| `switchback-db-token-alarm`          | 1   | A Vercel token renewal failed, or a token is nearly expired                                          | The 15-min window comes back empty    | 1    |
| `switchback-ingest-ground-lost`      | 2   | Trails uncommitted, a job buried, a subtree stuck, a signal stranded, a double commit, a tile wedged | 15 min pass with none of them         | 5    |
| `switchback-ingest-pump-failing`     | 2   | 3 of the last 4 windows carried a rejected `ingestPump`                                              | Two consecutive clean windows         | 0    |
| `switchback-ingest-overpass-limited` | 2   | More than 8 Overpass 429s in a rolling hour                                                          | The trailing hour drops to 8 or fewer | 0    |
| `switchback-ingest-deadletter`       | 2   | A message is sitting in the dead-letter queue                                                        | The queue is drained                  | 0    |
| `switchback-ingest-drain-degraded`   | 3   | A job failed and was rescheduled, a lease expired, a drain was rejected                              | The 15-min window comes back empty    | 6    |
| `switchback-ingest-queue-distress`   | 3   | Any distress gauge non-zero                                                                          | Every gauge returns to zero           | 61   |
| `switchback-ingest-overpass-skipped` | 3   | More than 4 refused side queries in 15 min                                                           | The window falls back to 4 or fewer   | 0    |

**The live estate is behind this template, and the table describes the template.** Read from Azure on
2026-08-10 the resource group holds six scheduled query rules — `drain-failed`, `queue-distress`,
`worker-silent`, `overpass-limited`, `overpass-skipped`, `switchback-db-token-alarm` — plus three
metric alerts. `switchback-ingest-drain-failed` is the rule this template replaces with
`ground-lost`, `drain-degraded` and `pump-failing`. Nothing in this section is live until
`ingest.bicep` is deployed; check with
`az monitor scheduled-query list -g rg-switchback-prod-northcentralus -o json` before trusting it.
`switchback-db-token-alarm`'s single window is the deliberate probe
`scripts/alarm-channel-probe.ts` emitted at 2026-08-09T20:56Z and 20:59Z, not a real renewal
failure.

**Deploying this template does not delete `switchback-ingest-drain-failed`.** Resource-group
deployments are incremental, so a rule dropped from the template is left running in Azure and will
keep paging on the old union. Delete it by hand once the replacements are deployed and confirmed:

```bash
az monitor scheduled-query delete -g rg-switchback-prod-northcentralus \
  -n switchback-ingest-drain-failed --yes
az monitor scheduled-query list -g rg-switchback-prod-northcentralus \
  --query "[].name" -o json    # must not contain switchback-ingest-drain-failed
```

**`switchback-postgres-connections` is Sev1 at a threshold nothing derived.** It fires on
`active_connections > 300` averaged over 15 minutes. The server's `max_connections` is 429, so 300 is
70% of the server ceiling — but the application's own bound is `BACKGROUND_POOL_SIZE = 10` per
client, and the measured peak over the same 48 h was 24 against a mean of 16. A leak would have to
reach twelve times normal before anything said so, and it is Sev1 when it finally does. Deriving that
threshold from the pool count rather than the server ceiling is a change to `postgres.bicep`, which
this work does not deploy — see [Read this first](#read-this-first) — so it is recorded here rather
than half-changed into a template nobody can apply.

**`worker-silent` is the one that matters most, and it is the one the others drown.** Every other
rule is armed by something the worker emits, so a host that is down, wedged, or serving a build
without `health.ts` reads as a healthy estate to all of them. It fired for a 524-minute heartbeat
gap from 2026-08-08T23:04Z. Act on this before anything else in the table: check the Function App is
Running and that the heartbeat's `build=` matches `origin/master`.

**`ground-lost` does not fire on subdivision, and it does not fire on a retry.** A split is the
designed answer to a dense tile — 9 in the measured window against 7 events across every real fault
— and it is visible without a page: the parent is left `pending` with its children recorded, so
`ensureCoverage` still counts it outstanding, and a split that dies before it writes children throws,
so the failure reaches `drain-degraded`. A job that fails below `maxAttempts` is likewise on
`drain-degraded`, because `failJob` reschedules it. What reaches `ground-lost` is
`switchback-ingest-trail-lost`, which marks ground a tile fetched and could not commit — including on
the split exit, where nothing throws — and `switchback-ingest-job-buried`, the attempt that exhausts
the budget and leaves the row `dead`.

**`overpass-limited` measures a rate.** 16 rate limits in 48 h is the ambient behaviour of a free
public instance, peaking at 4 in any rolling hour; the client retries and rotates three endpoints and
none of the 16 cost a tile its ground. The threshold sits at 8/hour, above that ceiling and below the
~24 refusals one tile produces against a blocked IP. When it fires, the question is whether to back
off, not whether to restart anything.

**`deadletter` reads `Maximum`.** The metric is queue depth, published densely — all 2880
fifteen-minute windows over the 30 d to 2026-08-09 carried a value, every one 0 — so `Maximum`
breaches on the first datapoint above zero, and falls back to 0 once a drained queue fills the
window with zeros. `Minimum` would need the queue non-empty at every datapoint, delaying detection
by up to a window and missing a message dead-lettered and drained inside one; measured on
`ActiveMessages`, the sibling depth gauge, a rolling `Maximum` breached 31 minutes before a rolling
`Minimum` did. `Total` is not offered on this metric. Draining is
[A message dead-lettered](#a-message-dead-lettered).

**`queue-distress` is the noisiest rule in the set, and the noise is a true positive.** Over the 48 h
to 2026-08-09T22:00Z its 1169 heartbeats put `staleLeases` non-zero in 376 of them, against 52 for
`dead`, 3 for `wedgedTiles` and 0 for everything else — so that one gauge decides `isDistressed`
almost by itself. It does not move like a spike: it reads 0 in 793 readings, exactly 3 in 270, and
10 in 41, so no count threshold separates signal from noise here and raising one would only mute it.

What the plateaus say is that the reaper is not clearing what the gauge sees. `staleLeases` counts
`running` jobs whose `lockedAt` is older than `LEASE_TIMEOUT_MS + LEASE_SWEEP_GRACE_MS`, which is a
strict subset of the rows `reclaimExpiredJobs` updates — so one sweep should empty it. Over the same
window `ingestPump` ran 1170 times with 0 failures and logged no caught sweep error, while
`switchback-ingest-lease-expired` was written 3 times. Three reclaims cannot account for 376
non-zero readings. Either the sweep is not reaching `reclaimExpiredJobs` or those rows do not match
its `UPDATE`; the gauge is currently the only thing in the estate saying so, which is why it keeps
its non-zero test.

**`orphanedSplits` has never fired, and it cannot fire for the failure it is often cited against.**
Non-zero in 0 of those 1169 heartbeats, max 0. `countOrphanedSplits` looks for a parent carrying the
split marker with fewer than four children, and `splitTile` upserts all four children _before_ it
writes the marker — so a split that dies partway leaves no marker at all and this gauge sees
nothing. That failure is caught elsewhere: the exception propagates, `failJob` runs, and
`ingest-job-failed` arms `drain-degraded`. What `orphanedSplits` does detect is a subtree deleted
after
a successful split, which is how the six production rows of 2026-08-05 arose. It is wired correctly
and watching a real condition — just not the one a split failure produces.

### Acting on an ingest alert

Every ingest rule auto-clears, so an instance that is still `Fired` is a condition that is still
true. Closing one by hand is for clearing a backlog left by a rule that could not resolve itself,
not for silencing a live fault.

#### `switchback-ingest-ground-lost` — Sev2, act now

Find which arm fired and what it names. Substitute nothing; these run as written.

```bash
APP=e01856b9-3721-4c05-921f-9cb2fcc398c4

az monitor app-insights query --app $APP --offset 24h -o json \
  --analytics-query 'traces | where message has "switchback-ingest-trail-lost" or message has "switchback-ingest-job-buried" or message has "switchback-ingest-subtree-stuck" or message has "switchback-ingest-signal-stranded" or message has "switchback-ingest-double-commit" or message has "switchback-ingest-tile-wedged" | project timestamp, message | order by timestamp desc'
```

The message names the quadkey or dedupe key and, for `trail-lost`, the OSM ids. Then decide by arm:

| Arm                             | What to do                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `trail-lost`                    | Re-queue the tile; the ids re-commit on the next successful run. Confirm with the recovery query below.                     |
| `job-buried`                    | Read `lastError` on the row, fix the cause, then reset the job — a `dead` row is never retried.                             |
| `subtree-stuck` / `tile-wedged` | Inspect `ingest_tiles` for the quadkey; the repair writes the row, so the marker means it happened, not that it is ongoing. |
| `signal-stranded`               | The reaper has stopped. Check `ingestPump` is running — this is the arm that means the repair path itself is down.          |
| `double-commit`                 | Work ran twice under a reclaimed lease. No data loss, but the lease arithmetic needs re-checking.                           |

Confirm ground actually came back, rather than assuming the re-queue worked. `updatedAt` later than
the loss timestamp is the proof:

```bash
bash scripts/pgenv.sh -t -A -F'|' -c \
  "select \"osmType\", \"osmId\", \"updatedAt\" from trails where \"osmType\"='relation' and \"osmId\" in (19292086) order by \"osmId\""
```

#### `switchback-ingest-drain-degraded` — Sev3, look at the rate

Nothing here needs an intervention on a single instance; all three arms recover unaided. A sustained
rate means the recovery is not keeping up. Break it down by arm before doing anything:

```bash
az monitor app-insights query --app $APP --offset 24h -o json \
  --analytics-query 'traces | where message has "ingest-job-failed" or message has "switchback-ingest-lease-expired" | extend arm = iff(message has "switchback-ingest-lease-expired", "lease-expired", "job-failed") | summarize n = count() by arm, kind = extract("(ingest_tile|refresh_tile|ingest_route|enrich_trail|ingest_network)", 1, message) | order by n desc'
```

A single job kind dominating is a defect in that handler, not a queue problem. Read what the rows
themselves say:

```bash
bash scripts/pgenv.sh -t -A -F'|' -c \
  "select kind, count(*), left(replace(\"lastError\", chr(10), ' '), 120) from ingest_jobs where \"lastError\" is not null group by 1, 3 order by 2 desc limit 20"
```

#### `switchback-ingest-pump-failing` — Sev2, ingestion has stopped

Three of the last four windows carried a rejected `ingestPump`, so nothing is reaching the queue.
`worker-silent` stays quiet through this because the heartbeat is written before the publish.

```bash
az monitor app-insights query --app $APP --offset 6h -o json \
  --analytics-query 'requests | where name == "ingestPump" | summarize total = count(), failed = countif(success == false) by bin(timestamp, 15m) | order by timestamp desc'

az functionapp show -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri --query "state" -o json      # expect "Running"

az servicebus queue show -g rg-switchback-prod-northcentralus \
  --namespace-name sb-switchback-prod-37ywppu5p7fri -n ingest-jobs \
  --query "{active:countDetails.activeMessageCount,dead:countDetails.deadLetterMessageCount}" -o json
```

An active count that is not rising while `ingest_jobs` holds due work confirms the publish path is
the broken one.

#### Closing an instance by hand

Needed only for a backlog left `Fired` by a rule that could not self-clear. Requires **Monitoring
Contributor** on the resource group or subscription — the role carries
`Microsoft.AlertsManagement/alerts/*`, which includes `changestate/action`. No password and no
database access; `az login` as any principal holding that role is enough.

```bash
SUB=5cb9e7c3-0e31-4388-94e9-b36eab4bf977

# 1. List the open instances. The key must not be `id`: the table formatter
#    drops a column named exactly that, and the command still exits 0.
az rest --method GET \
  --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.AlertsManagement/alerts?api-version=2019-03-01&timeRange=7d" \
  --query "value[?properties.essentials.alertState!='Closed'].{alertId:id,rule:properties.essentials.alertRule,started:properties.essentials.startDateTime}" -o table

# 2. Close one, by the GUID on the end of its AlertId.
az rest --method POST \
  --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.AlertsManagement/alerts/<alert-guid>/changestate?api-version=2019-03-01&newState=Closed"
```

Read the evidence before closing: the alert names the arm that armed it, and the query behind it is
in [What each alert means](#what-each-alert-means). Closing without repairing the tile leaves the
ground missing and the next window silent.

In the portal the same action is **Monitor → Alerts → Alert state → Close**, which the on-call can
reach without the CLI.

Verified against the live subscription on 2026-08-09: the same POST against a non-existent GUID
returns `CustomerError: Alert was not found`, not `AuthorizationFailed`, so the route and the
principal's rights are both real —

```bash
az rest --method POST --url ".../alerts/00000000-0000-0000-0000-000000000000/changestate?api-version=2019-03-01&newState=Closed"
# ERROR: Not Found({"code":"CustomerError","message":"Alert was not found. ..."})   (exit 1)
```

The rules query `traces` and `requests`, not `AppTraces`/`AppRequests`, and that is correct: they are
scoped to the `appi-switchback-ingest` component, where the classic aliases are the only ones that
resolve. Both directions are checkable —

```bash
az monitor app-insights query --app appi-switchback-ingest -g rg-switchback-prod-northcentralus \
  --offset 48h --analytics-query "traces | summarize n=count()"      # 32007  (exit 0)
az monitor log-analytics query -w c188de03-100d-4608-9502-65e12323d986 \
  --analytics-query "AppTraces | where TimeGenerated>ago(48h) | summarize n=count()"   # 32007  (exit 0)
```

`AppTraces` against the component and `traces` against the workspace both fail with
`BadArgumentError`, so neither alias is silently returning an empty set.

### The Overpass clamp — the thing to check in review

Overpass allots request slots per client IP and `packages/ingest/src/overpass.ts` serializes at two
because exceeding that is what gets an IP blocked. Functions Consumption auto-scales, which fights
that directly. Every link in the chain that stops it is readable from configuration:

| Factor               | Set by                                                                             | Value |
| -------------------- | ---------------------------------------------------------------------------------- | ----- |
| Host instances       | `siteConfig.functionAppScaleLimit` (+ `WEBSITE_MAX_DYNAMIC_APPLICATION_SCALE_OUT`) | 1     |
| Node processes       | `FUNCTIONS_WORKER_PROCESS_COUNT`                                                   | 1     |
| `OverpassClient`s    | module singleton, `packages/ingest/src/config.ts`                                  | 1     |
| Requests per client  | `OVERPASS_MAX_CONCURRENT`                                                          | 2     |
| **In flight, total** | per host instance                                                                  | **2** |

`host.json`'s `maxConcurrentCalls: 1` is set too, but the argument does not rest on it — the host
multiplies that by the instance's core count. The load-bearing property is that Consumption runs one
host instance for the whole app, so every invocation shares one Node process and one client.

**This table bounds the Function App, which is now the only thing that drains.** The Vercel path is
deleted, so every row above describes the process that actually makes Overpass requests rather than
one side of a fan-out. The last row is what holds the bound across host instances:
`INGEST_MAX_DRAINERS = 1`, enforced by an advisory lock in `packages/ingest/src/drain-slot.ts`.
`docs/architecture.md` states the resulting bound in full and is the one place that does.

**`functionAppScaleLimit` caps scale-out, not instance count.** Consumption still replaces instances,
and for a few seconds around a replacement two hosts of this app run at once with a client each — the
17:32 trace on 2026-08-03 has instance `0--f7e39076-13` taking sequence 1 and `0--3f3e4037-7d`
starting 13 s later and taking sequence 2, with no evidence the first had stopped fetching. So: 2
sustained, up to 4 across a recycle. Fair use is about sustained load, so that is the honest number to
quote rather than an unqualified deployment-wide 2.

Vercel makes **zero** Overpass requests, and that is now a property of the deployment rather than of
an environment variable. The three call sites that could reach Overpass from a Vercel process —
`/api/cron/drain`, `trails.kickIngest` and `routes.kickNetwork` — are deleted rather than gated. A
Vercel process enqueues a row and publishes a Service Bus message; it holds no `OverpassClient` and
has no drain to run.

That is what makes the number checkable. While the path existed behind a flag, the bound was a
property of _a Vercel environment_: Production and Preview held the flag independently, an
environment with it absent read as `postgres` and drained inline at 2 per warm lambda, and giving
Preview a database was enough to bring a second drainer back. None of those states is reachable now
— the code that would drain is not in the bundle.

The deployment-wide figure is therefore the Azure one: 2 sustained, up to 4 across a recycle.
Raising any row in the table above is not a throughput knob.

### Deploying it

```bash
az provider register --namespace Microsoft.ServiceBus --wait   # NotRegistered by default

export INGEST_DATABASE_URL="…"                       # the sbapp connection string
export INGEST_OVERPASS_USER_AGENT="Switchback/0.1 (+https://switchback-three.vercel.app/attribution)"
export INGEST_TRAIL_IDENTITY=claim                   # the live value — no default, state it
export INGEST_SUBDIVIDE_MAX_ZOOM=11                  # the live value — no default, state it
export INGEST_PACKAGE_URL="$(az functionapp config appsettings list \
  -g rg-switchback-prod-northcentralus -n func-switchback-ingest-37ywppu5p7fri \
  --query "[?name=='WEBSITE_RUN_FROM_PACKAGE'].value | [0]" -o tsv)"

az deployment group create \
  --name switchback-ingest --resource-group rg-switchback-prod-northcentralus \
  --template-file infra/azure/ingest.bicep \
  --parameters infra/azure/ingest.bicepparam

unset INGEST_DATABASE_URL
```

Those five exports are the whole set with no fallback, and a missing one fails the build with
`BCP427` naming the variable — before ARM is called. Every one of them names a live control, and an
application-settings write replaces the collection whole, so any default would revert one:

| Export                       | Live value                              | What a default would do                                                                                                   |
| ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `INGEST_DATABASE_URL`        | the `sbapp` connection string           | deploy a worker that cannot reach Postgres                                                                                |
| `INGEST_OVERPASS_USER_AGENT` | a contact URL that reaches this project | run unattended under a placeholder, which is what mirrors block for                                                       |
| `INGEST_TRAIL_IDENTITY`      | `claim`                                 | revert to `osm-id`, silently — `identity.ts` reads an absent variable and `osm-id` identically                            |
| `INGEST_SUBDIVIDE_MAX_ZOOM`  | `11`                                    | write `9`, which turns subdivision **off**: `canSubdivide(9, 9)` is false, so a dense z9 tile is failed rather than split |
| `INGEST_PACKAGE_URL`         | the zip the host currently runs         | point the app at another build, or leave it codeless                                                                      |

`ingest.bicepparam` reads two more from the environment — `TERRAIN_TILE_URL` and `MAPILLARY_TOKEN` —
and both fall back to absent, which is what the app already holds, so leaving them unexported
deploys the deployed value.

Confirm the two flags landed rather than assuming it:

```bash
az functionapp config appsettings list -g rg-switchback-prod-northcentralus \
  -n func-switchback-ingest-37ywppu5p7fri \
  --query "[?name=='INGEST_TRAIL_IDENTITY' || name=='INGEST_SUBDIVIDE_MAX_ZOOM'].[name,value]" -o tsv
# expect: INGEST_TRAIL_IDENTITY claim / INGEST_SUBDIVIDE_MAX_ZOOM 11
```

`INGEST_OVERPASS_USER_AGENT` is the one an operator has to get right rather than copy, and it has
bitten. It must carry an `http(s)://` contact URL that reaches _this_ project —
`assertUsableUserAgent` in `packages/ingest/src/overpass.ts` throws inside the handler on a
placeholder or on a host it knows is not ours, so the worker dead-letters every tile after five
deliveries with a message that names the database rather than the user agent. `switchback.app` is on
that rejected list by name: it reads like ours, is registered to somebody else, and was what the
Function App actually sent on every Overpass request until 2026-08-03. Only the shape can be checked
in code — that a URL reaches you is the one thing the operator has to get right.
`INGEST_TRAIL_IDENTITY` has no default on purpose: the deployment overwrites the Function App's
setting with whatever the parameter resolves to, and a default would let a routine deploy silently
change how trails are identified across a tile seam.

**The template declares the package URL; the package itself is pushed by a script.** Linux
Consumption runs the code from `WEBSITE_RUN_FROM_PACKAGE`, which `ingest.bicep` declares from
`packageUrl` — so a template-only deploy writes back the URL that is already live, provided
`INGEST_PACKAGE_URL` names it. What no template can do is upload the per-commit zip, which is what
the script below is for. For the same reason a setting added by hand in the portal is erased by the
next deployment: worker environment belongs in the template.

**`az deployment group what-if` cannot check any of this.** ARM redacts `siteConfig.appSettings` to
`*******` in both the before and after payloads, because the collection can hold secrets — so no
application setting appears in a what-if at any confidence level, and a plan that looks clean says
nothing about `WEBSITE_RUN_FROM_PACKAGE`, `DATABASE_AUTH` or the two ingest flags. What-if is still
worth running for the resource-level change list, and it is what proves no
`Microsoft.DBforPostgreSQL` resource is in the change set. Settings are confirmed after the fact,
with the `az functionapp config appsettings list` reads below.

```bash
bash .github/scripts/deploy-worker.sh apps/ingest-worker/dist.zip "$(git rev-parse HEAD)"
```

That script is the whole sequence — upload the bundle to the `function-releases` container, point
`WEBSITE_RUN_FROM_PACKAGE` at it, sync the trigger cache, and wait for the running host to emit
`switchback-ingest-queue-health build=<commit>`, a line only the package built from that commit can
produce. It fails if the uploaded blob is short, if the settings write did not land, or if that
heartbeat does not arrive, so a stale deploy cannot report success. `ci.yml`'s `deploy ingest worker`
job invokes the same file on every push to master; running it by hand and letting CI run it are the
same code path, which is the point.

**Never `az functionapp deployment source config-zip` on this app.** The CLI decides between the
blob path and a Kudu `/api/zipdeploy` by reading the plan to see whether it is Consumption, inside a
bare `except:`. `id-switchback-worker-deploy` is Website Contributor on the _site_, which does not
carry read on the plan resource, so the lookup fails, is swallowed, and the app is treated as
non-Consumption — and the Kudu fallback is refused with **409**, because a site whose
`WEBSITE_RUN_FROM_PACKAGE` names an external URL cannot also be extracted into. The same command
succeeds for an operator who can read the plan, which is what made this look like a working deploy
path for as long as only a workstation ran it.

**The package URL carries no SAS.** `config-zip` mints one with a 520-week expiry. The Function App's
system-assigned identity holds Storage Blob Data Reader on `function-releases` instead — the
mechanism Microsoft documents for external package URLs and recommends over a SAS — so the setting is
an ordinary blob URL that can be read out, logged and pasted without redaction.

**Subscription Owner is not enough to run the script by hand.** The upload is `--auth-mode login`,
and blob data access is a data-plane role that Owner does not imply: without one the script stops on
`You do not have the required permissions needed to perform this operation`, before it has touched
the app. CI is covered by the grant `ingest.bicep` gives `id-switchback-worker-deploy`; a person
needs their own, which is not in the template because a template is the wrong place to enumerate
humans. `az role assignment create` rejects a container scope here with `MissingSubscription`, so
place it through ARM:

```bash
OBJECT_ID="$(az ad signed-in-user show --query id -o tsv)"
SCOPE=/subscriptions/5cb9e7c3-0e31-4388-94e9-b36eab4bf977/resourceGroups/rg-switchback-prod-northcentralus/providers/Microsoft.Storage/storageAccounts/stsbingest37ywppu5p7fri/blobServices/default/containers/function-releases
cat >/tmp/grant.json <<JSON
{"properties":{
  "roleDefinitionId":"/subscriptions/5cb9e7c3-0e31-4388-94e9-b36eab4bf977/providers/Microsoft.Authorization/roleDefinitions/ba92f5b4-2d11-453d-a403-e96b0029c9fe",
  "principalId":"$OBJECT_ID","principalType":"User"}}
JSON
az rest --method PUT --body @/tmp/grant.json \
  --url "https://management.azure.com$SCOPE/providers/Microsoft.Authorization/roleAssignments/$(uuidgen)?api-version=2022-04-01"
```

`ba92f5b4-2d11-453d-a403-e96b0029c9fe` is Storage Blob Data Contributor. The scope is the one
container: it reaches neither `azure-webjobs-secrets`, where the host keys live, nor the lease blobs
beside it.

The trigger sync inside it is not optional and cost half an hour to find. When the package the app
runs from changes, the host comes up reporting
`0 functions loaded` / "No functions were found", `az functionapp function list` returns `[]`, and
nothing ever wakes it — a Consumption app with no registered triggers has nothing to scale on, so it
sits there indefinitely and a restart does not help. The call the script makes is:

```bash
az rest --method POST --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/rg-switchback-prod-northcentralus/providers/Microsoft.Web/sites/func-switchback-ingest-37ywppu5p7fri/syncfunctiontriggers?api-version=2023-12-01"
```

Within a minute `az functionapp function list` shows `ingestDrain` and `ingestPump`.

**Zip the bundle with forward slashes.** Windows PowerShell 5.1's `Compress-Archive` writes entry
names with `\`, which the Linux host reads as one long filename rather than a path — so `node_modules`
never lands in `wwwroot` and the worker dies indexing with `Cannot find module '@azure/functions'`,
under a `0 functions found (Custom)` that looks identical to a package that never mounted.
`[IO.Compression.ZipFile]::CreateFromDirectory` from `pwsh` normalises them. Observed 2026-08-05.

**`az functionapp function list` lags the host.** It returned `[]` for ten minutes after a deploy the
host had already indexed. `curl -H "x-functions-key: <master>" https://<app>.azurewebsites.net/admin/functions`
asks the host itself and is the answer to trust. So is the queue depth: `az servicebus queue show …
--query countDetails` moved to 8 while Application Insights was still a tick behind.

`what-if` is safe and is the check worth running before any deploy — nothing under
`Microsoft.DBforPostgreSQL` may appear as a create or a modify.

**Role assignments are ordinary resources in the templates, and nothing grants access by hand.**
`Microsoft.Authorization/roleAssignments/write` is in Contributor's `notActions`, so the deploying
service principal (`cf940ed6-…`, display name `plant`) holds **Role Based Access Control
Administrator** (`f58310d9-a9f6-439a-9e8d-f62e7b41a168`) at this resource group, unconditioned —
assignment `8baf9393-029a-4226-a882-992a8146d775`, created 2026-08-03. That is a standing ability to
grant any role here to any principal, and it is the price of keeping grants in Bicep.

**Deleting a `roleAssignment` from Bicep is not a revocation.** Resource-group deployments are
Incremental — ARM never removes a resource merely because the template stopped declaring it, and
`what-if` shows nothing, because from ARM's point of view nothing changed. An earlier revision of
`ingest.bicep` granted the worker **Azure Service Bus Data Owner**; that resource was deleted from
the file and the assignment stayed live for a day, which is a wildcard over `Microsoft.ServiceBus` in
`actions` as well as `dataActions` on the queue the worker drains. Removing it took an explicit
delete, and the resource-group `CanNotDelete` lock refuses one at any scope inside the group, so it
took three steps as an Owner:

```bash
LOCK=/subscriptions/$SUB/resourceGroups/rg-switchback-prod-northcentralus/providers/Microsoft.Authorization/locks/switchback-prod-no-delete
QUEUE=/subscriptions/$SUB/resourcegroups/rg-switchback-prod-northcentralus/providers/Microsoft.ServiceBus/namespaces/sb-switchback-prod-37ywppu5p7fri/queues/ingest-jobs

az rest --method DELETE --url "https://management.azure.com$LOCK?api-version=2020-05-01"
az rest --method DELETE --url "https://management.azure.com$QUEUE/providers/Microsoft.Authorization/roleAssignments/74ca4647-7b88-50e2-b472-8f3daa7c7a42?api-version=2022-04-01"
az rest --method PUT    --url "https://management.azure.com$LOCK?api-version=2020-05-01" --body @lock.json
```

Done on 2026-08-03T18:10Z, along with the dead `vercel-send` SAS rule on the queue, which
`disableLocalAuth: true` had already made unusable but which the template also does not declare.
`az role assignment list` and `az role assignment delete` both fail here with a spurious
`MissingSubscription`; ARM REST is the working path.

That first re-PUT put back a 178-character paraphrase, not `main.bicep`'s body — so for eight hours
the only text an operator met when the lock blocked them was missing the sentence demanding a pull
request, and production drifted from the template in the one resource guarding irreversible data
loss. Re-PUT verbatim at 2026-08-03T20:07Z from `lockNotes` in `main.bicep`, now 445 characters and
byte-identical; `az rest --method GET .../locks` is how to check. Read `lock.json` out of the
template rather than typing it, which is what went wrong the first time.

**A rebuild from scratch is not affected** — a fresh resource group deployed from `ingest.bicep`
gets exactly the three assignments the template declares. This step existed only to converge the
environment that had already run the older template. To check any environment:

```bash
az rest --method GET --url "https://management.azure.com$QUEUE/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&\$filter=atScope()" \
  --query "value[?contains(properties.scope,'queues/ingest-jobs')].{assignment:name, principal:properties.principalId, role:properties.roleDefinitionId}" -o tsv
```

`atScope()` means _at this scope and above_, not _at this scope_: it returns the queue's own
assignments plus everything inherited, which against this estate is nine rows — three on the queue,
one from the resource group, five from the subscription — so the filter on `properties.scope` is
what narrows it to the queue's own. Dropping `atScope()` returns the same nine here, because a queue
has no child scope for the unfiltered form to add. Three rows:
Data Sender (`69a216fc-…`) and Data Receiver (`4f6d3b9b-…`) for the worker `3db30cfd-…`, and Data
Sender alone for the publisher `c9bfba39-…`. Two things must **not** appear:
`090c5cfd-751d-490a-894a-3ce6f1109419` (Data Owner), and any Data Receiver held by `c9bfba39-…` —
that was assignment `0090d328-0cee-592f-8359-e4cc64940694`, revoked 2026-08-08, and its return would
mean a template or a hand edit put drain capability back on Vercel's identity.

**Finish by leaving the host running, or nothing you just deployed does anything.** The last of the
three brakes is `az functionapp stop`, and a stopped host runs no package however new it is. The
deploy script starts it before it names the new package, and refuses if it does not come up — a
stopped host and a package that failed to mount produce the same silence, and only the state read
tells them apart. By hand:

```bash
az functionapp start -g rg-switchback-prod-northcentralus -n func-switchback-ingest-37ywppu5p7fri
az functionapp show  -g rg-switchback-prod-northcentralus -n func-switchback-ingest-37ywppu5p7fri \
  --query state -o tsv
# expect: Running
```

A stop is not free in both directions. `defaultMessageTimeToLive` is `PT1H` and
`deadLetteringOnMessageExpiration` is `false`, so wake-up signals older than an hour are deleted
silently while the host is down — fifteen expired that way across one maintenance stop. The
`ingest_jobs` rows survive, and the pump republishes from the head of `priority DESC, "runAfter" ASC`
on its next tick, so what a stop costs is the queue's ordering position for anything enqueued during
it rather than the work itself.

### The two things Bicep cannot express

Recorded here for the same reason the `sbapp` role is: they are real steps, they are not in a
template, and a reader would otherwise conclude the template is the whole story.

1. **The standing deploying principal, and its two grants.** An Entra app registration and the
   credentials on it are Microsoft Graph objects, not ARM, and Bicep cannot declare them. `plant`
   (`3ac53469-d72f-4813-b5e8-4bbf937cc76d`, object id `cf940ed6-…`) was created by hand as an
   Owner. It authenticates with a **client secret** valid to 2027-03-01 and carries no federated
   credential at all, so no GitHub workflow can assume it. Its grants are wider than this resource
   group:

   | Role                                    | Scope                               | Assignment               |
   | --------------------------------------- | ----------------------------------- | ------------------------ |
   | Contributor                             | the **subscription** `5cb9e7c3-…`   | `c2098a98-…`, 2026-03-01 |
   | Role Based Access Control Administrator | `rg-switchback-prod-northcentralus` | `8baf9393-…`, 2026-08-03 |

   ```bash
   az role assignment list --assignee 3ac53469-d72f-4813-b5e8-4bbf937cc76d --all \
     --query '[].{role:roleDefinitionName,scope:scope,name:name}' -o json
   az ad app federated-credential list --id 3ac53469-d72f-4813-b5e8-4bbf937cc76d -o json   # []
   ```

   **CI is not this principal, and no `AZURE_*` secret exists.** Every `azure/login` in a workflow
   presents a _user-assigned managed identity_, whose federated credentials are ARM resources and
   so live in the templates rather than in a bootstrap command:

   | Consumer                                                             | Client id from                                               | Identity                                   |
   | -------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------ |
   | `postgres-entra.yml`, `ci.yml`'s `migrate`, `token-expiry-probe.yml` | a literal in each workflow, `81c76484-…`                     | `id-switchback-postgres-ci`                |
   | `ci.yml`'s worker deploy                                             | `vars.AZURE_WORKER_DEPLOY_CLIENT_ID`                         | `id-switchback-worker-deploy`              |
   | `infrastructure.yml`                                                 | `vars.AZURE_INFRA_CLIENT_ID` — set nowhere, so the job skips | `id-switchback-infra-deploy`, not deployed |

   That is every `azure/login` in the tree: `grep -rn "client-id:" .github/workflows/` returns six
   occurrences across those four workflows.

   The two that are not literals are repository **variables** — set with `gh variable set`, and
   readable by anyone — not secrets. `gh secret list` holds `DATABASE_URL`, `DIRECT_DATABASE_URL`
   and `VERCEL_DEPLOY_HOOK` and nothing else.

2. **Managed identity to Postgres carries the worker.** `DATABASE_AUTH=entra` is set on
   `func-switchback-ingest-37ywppu5p7fri` and `DATABASE_URL` there names `sbapp_func` with no
   password. Measured on the server: `activeDirectoryAuth: Enabled`, `passwordAuth: Enabled`,
   `tenantId: f0f92920-…`. Measured in the catalog: role `sbapp_func` exists, carries no password,
   is Entra-mapped to the worker's principal `3db30cfd-…`, and is a member of `sbapp`, so it has
   the table grants by inheritance.

   Vercel is what remains — `DATABASE_AUTH=entra-vercel` and a `databaseUrl` naming `sbapp_vercel`.
   Both writes are to Vercel, not to the server resource, so the password-rotation hazard at the
   top of this section is not in that path either.

### Vercel's three variables

None of these is a secret; the credential is the per-deployment OIDC token, which is minted by
Vercel and never stored. Read them off the deployment outputs:

```bash
az deployment group show -g rg-switchback-prod-northcentralus -n switchback-ingest \
  --query "properties.outputs.{namespace:serviceBusFullyQualifiedNamespace.value,\
client:publisherClientId.value,tenant:publisherTenantId.value}" -o json
```

→ `SERVICE_BUS_NAMESPACE`, `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` on the Vercel project. The
exchange fails silently at Entra if the Vercel **team or project is renamed** — the `sub` claim
follows the new name and the federated credential does not. Fixing that is a one-parameter redeploy
of this template.

---

## Known follow-up

Operational items outstanding are in [Read this first](#read-this-first). This one is code:

- **`packages/db/scripts/apply-spatial.ts`** constructs a bare `new PrismaClient()`, so all of
  `spatial.sql` — including three `CREATE EXTENSION` and every `CREATE INDEX` — runs over
  `DATABASE_URL`, the _pooled_ endpoint. Harmless on Burstable, where both URLs are the same 5432
  endpoint. It becomes DDL through a transaction-mode pooler the moment General Purpose is adopted,
  which is precisely what the `url`/`directUrl` split exists to prevent. One line: read
  `DIRECT_DATABASE_URL ?? DATABASE_URL` into `datasourceUrl`.
