# Switchback's production database, on Azure

One **Azure Database for PostgreSQL Flexible Server** — PostgreSQL 17 with PostGIS, in its own
resource group, described entirely in Bicep. It replaced **Neon** and nothing else: the app stays
on Vercel, photographs stay in Cloudflare R2, CI stays on GitHub Actions.

**Production has served from Azure since 2026-07-30, about 20:09 UTC.** It is the only copy of
this data. The Neon project that used to be the rollback was deleted on 2026-08-07.

```mermaid
flowchart LR
  V["Vercel<br/>switchback-three.vercel.app"]
  CI["GitHub Actions<br/>ci.yml migrate job"]
  A["Azure Postgres 17 + PostGIS — live<br/>psql-switchback-prod-37ywppu5p7fri<br/>rg-switchback-prod-northcentralus"]
  P["Point-in-time restore<br/>14 days, locally redundant<br/>restores into a new server"]

  V -->|"sbapp, password, DML only"| A
  CI -->|"id-switchback-postgres-ci, Entra token, DDL"| A
  A -.->|"the only recovery"| P
```

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
  it and `DATABASE_URL` at step 7 of the cutover, not before — until then they are the way back if
  the token path in `migrate` fails. It remains unreadable from ARM, so a redeploy still has to be
  given the same value. A copy in the owner's
  password manager was claimed here previously; nobody observed it being made, so it is not counted.
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
- **There is no second copy of this data, and no rollback target.** Neon was deleted on
  2026-08-07 — the Vercel↔Neon marketplace resource was removed, and the endpoint stopped
  answering minutes later. Everything that used to say "roll back to Neon" now resolves to
  point-in-time restore into a **new** Azure server, and nothing else. See
  [Backups](#backups) and [If this server is lost](#if-this-server-is-lost).
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

Free, automatic, and the fastest way back from a bad `db push`. Measured 2026-08-05:

| Fact                   | Value                                                               |
| ---------------------- | ------------------------------------------------------------------- |
| Retention configured   | 14 days, locally redundant, `geoRedundantBackup: Disabled`          |
| Earliest restore point | `2026-07-30T16:32:40Z` — the server's own creation                  |
| Full backups taken     | Daily, one per day since creation, plus continuous transaction logs |
| Server state           | `Ready`, `replicationRole: Primary` — eligible                      |

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

| File                | What it is                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| `main.bicep`        | Subscription-scoped. Creates the resource group, then calls the modules. Outputs the hostname.  |
| `postgres.bicep`    | The server: compute, storage, backups, firewall, server parameters, the database.               |
| `monitoring.bicep`  | Log Analytics workspace, the alert action group, and the workload budget.                       |
| `lock.bicep`        | The resource group's `CanNotDelete` lock. A module because locks are resource-group scoped.     |
| `main.bicepparam`   | Every non-secret parameter. Committed. The password is **not** here and never may be.           |
| `ingest.bicep`      | The ingest queue and its worker. Resource-group scoped, deployed **separately**. See below.     |
| `ingest.bicepparam` | Its non-secret parameters. The connection string is read from the environment, not stored here. |

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
| Database          | `switchback`, collation `C.UTF-8` (matched to Neon)             |
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
  appears in no template — which reads as a broken identity rather than a wrong branch. The token
  path itself has been run: run 31063906113 connected as `id-switchback-postgres-ci` over TLSv1.3
  and reported `is_admin|true`, `server_version|17.10` and the full role and row-count census.
  **That run used a branch credential that has since been deleted, and the `github-master`
  credential this instruction depends on has never been exercised** — every successful `inspect`
  ran on `feat/credential-free-postgres` or a worktree branch, and the one dispatch attempted from
  a feature branch after those credentials were removed failed with `AADSTS700213`. What is proven
  is that the identity can reach the database and is an administrator; what is unproven is the
  `master` ref exchange. `postgres-entra.yml` is added to `master` by this change, so the first
  dispatch from `master` is also the first test of it. Do that while passwords still work — step 6
  of the cutover requires it — rather than discovering it when there is no password to fall back
  on.

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

**Both application roles exist and neither is in use.** Every consumer still authenticates by
password as `sbapp`; `DATABASE_AUTH` is set nowhere. The role names above are what the live catalog
holds, read on 2026-08-06.

`id-switchback-vercel-publisher` is the shared runtime identity: Vercel production, Vercel preview
and — once `infra/azure/ingest.bicep` moves the worker onto it — the ingest worker are all intended
to authenticate as this one principal. The resource name is narrower than the role it will hold
because ARM cannot rename a user-assigned identity; the `component: runtime-identity` tag is where
a portal reader is told what it actually is.

The consolidation renames `sbapp_vercel` to `sbapp_runtime` and then drops `sbapp_func`, in that
order and not together. The rename is the `provision` action of the `Postgres identity` workflow;
it must run from `master`, because the CI identity's federated credential trusts no other ref. The
drop is the separate `retire` action, and it refuses to run unless the dispatch asserts every
consumer has been moved — the database cannot establish that for itself, and a sample of
`pg_stat_activity` cannot stand in for it, because the worker scales to zero between invocations
and shows no backend for most of any minute however healthy it is.

The application role holds its privileges by membership in `sbapp` rather than by a copied list of
grants, so it cannot drift from it — including for a table `prisma db push` creates tomorrow, which
`sbapp`'s default privileges already cover. `infra/postgres-identity/` holds the SQL, and the
`provision` action of the `Postgres identity` workflow applies and re-verifies it.

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

Neither needs the admin password. `main.bicepparam` falls back to empty and `postgres.bicep` omits
`administratorLoginPassword` entirely when it is, so a redeploy converging a budget leaves the live
credential untouched; see [Redeploying](#redeploying).

`main.bicep`'s header lists the rest of the `what-if` change list: provider-assigned residue that
never converges, and the one entry that is a real to-do. Read it before concluding the template has
drifted.

---

## Four decisions that look odd

**North Central US, not Virginia.** Both East US and East US 2 are _offer-restricted_ for this
subscription: `az postgres flexible-server list-skus --location eastus2` returns zero supported
editions and the reason "Subscriptions are restricted from provisioning in this region", and
`eastus` says the same. Of the four regions available — North Central US, Central US, Canada
Central, West US 3 — Chicago is closest to Vercel's `iad1` and Neon's AWS `us-east-1`. So the
database is roughly **20 ms further** from the application than Virginia would have been, and a
tRPC call pays that round trip several times. Pricing is identical, so the $57.00 total is
unaffected. A Flexible Server cannot be moved between regions afterwards.

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
  `sbadmin`**. It can read and write rows and is refused `CREATE TABLE`, which
  `scripts/verify-migration.ts` asserts by connecting as it and trying.

The residual risk is therefore _leakage_ rather than brute force, which makes the credential
inventory the thing to keep honest:

| Store             | Value                                 | Notes                                            |
| ----------------- | ------------------------------------- | ------------------------------------------------ |
| GitHub secret     | `DATABASE_URL`                        | read by `ci.yml`'s `migrate` job                 |
| GitHub secret     | `DIRECT_DATABASE_URL`                 | `prisma db push` runs through this, so `sbadmin` |
| Vercel Production | `DATABASE_URL`, `DIRECT_DATABASE_URL` | `sbapp` — the web app never carries `sbadmin`    |
| Vercel Preview    | `DATABASE_URL`, `DIRECT_DATABASE_URL` | separate entries, added after the cutover        |

The three `AZURE_*` GitHub secrets are gone, and so are the seventeen `POSTGRES_*` / `PG*` /
`NEON_*` variables the Vercel↔Neon marketplace integration had put into the project — five of them
complete Neon connection strings, two the bare password, one (`POSTGRES_URL_NO_SSL`) a connection
string with TLS switched off, all scoped to Production **and Preview**. The integration itself is
disconnected, so they do not come back. Verify rather than trust this paragraph:

```bash
gh secret list --repo mbahgatTech/switchback
npx vercel env ls
```

GitHub's values cannot be read back, so the `Notes` column is design intent plus what each consumer
demonstrably requires, not a readback. If you need to know what a secret contains, the only honest
answer is to set it again from a source you trust.

**No geo-redundant backup, no high availability — and, since 2026-08-07, no warm standby either.**
Both settings were chosen when the disaster procedure was "point `DATABASE_URL` back at Neon and
redeploy": minutes to restore, no data loss up to the cutover, so paying for geo-restore (minutes
to hours, up to an hour of RPO, no point-in-time) bought nothing. Neon is now deleted, and that
argument went with it.

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

**Put that password in a password manager now, before going any further.** This is the only moment
it is readable — see [Redeploying](#redeploying) for what depends on it.

Read the outputs — hostname, ports, and the two connection-string templates, none of which contains
the password:

```bash
az deployment sub show --name switchback-db --query properties.outputs -o json
```

Then shred the scratch files. This is **not** an archival step; the password manager above is the
only copy that survives:

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
Entra-mapped role — `sbapp_runtime` for both Vercel and the worker:

```
postgresql://sbapp_runtime@<host>:5432/switchback?sslmode=verify-full
```

A URL that still has a password in it is rejected at construction rather than quietly preferred, so
a half-finished cutover fails loudly. `entra-vercel` additionally needs `AZURE_TENANT_ID` and
`AZURE_CLIENT_ID` (the **client** id of `id-switchback-vercel-publisher`, not its principal id).

On this path Prisma is driven through `@prisma/adapter-pg`, which means `sslmode` is finally read
and enforced — and also that `connection_limit` and `pool_timeout` in the URL stop having any
effect, because the adapter bypasses the connection string. Both pool sizes are set in
`packages/db/src/client.ts` instead.

`DATABASE_URL` and `DIRECT_DATABASE_URL` are identical on this tier, and that is correct rather
than redundant — `schema.prisma` requires `directUrl` to exist, and keeping the split means the
eventual General Purpose escalation is a pure environment-variable change with no code diff. On
General Purpose, `DATABASE_URL` moves to `:6432` and gains `&pgbouncer=true`.

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

If you do intend to keep a value, a password-manager entry is the only place it can live. Not the
`$TMP` file, which the deploy procedure shreds; not a GitHub Actions secret, which cannot be read
back; not Vercel, which is deliberately never given the admin credential.

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

Placing the lock needs no admin password. With `PGADMIN_PASSWORD` unset, `main.bicepparam` falls
back to empty and `postgres.bicep` omits `administratorLoginPassword` entirely, so the live
credential is untouched. Export it here only if you also mean to rotate — and rotating breaks every
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
but cannot create it. This step does, and `scripts/verify-migration.ts` turns it from an intention
into a checked claim. It has been run; it is written out because it has to be run again against any
rebuilt server.

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

All six should be false. `verify:migration` asserts the same thing from the other side, by
connecting _as_ `sbapp` and requiring `CREATE TABLE` to be refused, which is the version that
cannot be fooled by a misread catalogue.

---

## Verifying

`scripts/verify-migration.ts` compares a source and a target and prints a table of pass/fail. Worth
re-running after any restore, any rebuild, and any cutover. It prints no connection string and no
row of user data, and exits non-zero on any failure. `NEON_*` in the variable names is where the
source happened to be the first time; the script reads any two PostgreSQL URLs, and the Neon
project itself is gone.

```bash
export NEON_VERIFY_URL='postgresql://…@…neon.tech/switchback?sslmode=verify-full'
export AZURE_VERIFY_URL='postgresql://sbadmin:…@…postgres.database.azure.com:5432/switchback?sslmode=verify-full&sslaccept=strict'
export AZURE_APP_VERIFY_URL='postgresql://sbapp:…@…postgres.database.azure.com:5432/switchback?sslmode=verify-full&sslaccept=strict'
export NEON_CHECKSUMS="$TMP/neon-checksums.txt"
export AZURE_CHECKSUMS="$TMP/azure-checksums.txt"
npm run verify:migration
```

| Variable                       | If omitted                                                              |
| ------------------------------ | ----------------------------------------------------------------------- |
| `NEON_VERIFY_URL`              | The script prints a usage error and exits 1 before connecting           |
| `AZURE_VERIFY_URL`             | Same                                                                    |
| `AZURE_APP_VERIFY_URL`         | Recorded as a **failure**, not a skip                                   |
| `NEON_CHECKSUMS`               | Recorded as a **failure** (`checksums · source file not found at`)      |
| `AZURE_CHECKSUMS`              | Same, for the target                                                    |
| `CHECKSUM_SNAPSHOT_CONSISTENT` | Treated as not `1`, which loosens the ingest-derived tables to warnings |

**None of the first five is optional.** Omitting one produces a red run, not a shorter one: the
least-privilege role is listed by `postgres.bicep` as a compensating control for a firewall
spanning the whole internet, and silently skipping its check would turn a missing environment
variable into a clean bill of health. A green run means every check ran.

Checksum files are `table|rows|md5` per line, computed in SQL on each side. On the source they must
be taken from _inside the transaction snapshot `pg_dump` used_, and `CHECKSUM_SNAPSHOT_CONSISTENT=1`
is the assertion that they were. Without it the ingest-derived tables (trails, waypoints, tiles,
jobs, sessions) are compared against a source that keeps taking writes, so a difference in those
is a warning rather than a failure. `photos` is deliberately not on the forgiving list: it holds
user uploads as well as ingest-derived hero images, and treating somebody's lost photograph as
expected churn is the wrong default.

### What each check catches

`pg_restore` exiting 0 proves that a program finished. This proves rather more, and every check
exists because there is a specific way a migration can look complete and not be:

| Check                                                 | Catches                                                                             |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Source and target hosts differ                        | A run comparing a database to itself, which otherwise passes everything             |
| Per-table `count(*)` + `md5` of every row, both sides | A missing table, a short table, a corrupted row, a lost geometry or tsvector        |
| Absolute row-count floors                             | A restore that loaded nothing — two empty databases match perfectly                 |
| Every table from `schema.prisma` present              | A table that never arrived                                                          |
| All 8 indexes from `spatial.sql`, by name             | An index that did not rebuild                                                       |
| `trails_centroid_gist` **absent**                     | The one index `spatial.sql` deliberately drops                                      |
| `pg_index.indisvalid`                                 | An index that rebuilt broken                                                        |
| Foreign-key count matches source                      | A `post-data` section that never ran                                                |
| `default_text_search_config`, collation               | Future ingest tokenising differently from the rows that arrived                     |
| `sum(ST_Length(geom::geography))`, `sum(ST_NPoints)`  | Truncated or altered geometry                                                       |
| `DISTINCT ST_SRID = {4326}` exactly                   | A lost SRID — every row count stays perfect and every distance goes wrong           |
| NULL-geometry counts per column                       | Rows arriving without their geometry                                                |
| Two named trails compared by WKB hash                 | Truncation on the longest line in the corpus                                        |
| `trailIdsNear` id set, both sides                     | Different answers to the query the product runs                                     |
| `EXPLAIN` names `trails_geom_geography_gist`          | An index that is present, valid, and _unused_ — 3,850 ms versus 178 ms on `/nearby` |

The last migration run reported **72 checks, 72 passed, 0 warnings, 0 failed**, with source and
target checksum files byte identical.

---

## Cutting over

**Already done.** Kept because the same steps apply to any rebuild. Read it as a procedure, not as a
description of the estate: the source database it repeatedly tells you to preserve was deleted on
2026-08-07, and what replaced the rollback is [If this server is lost](#if-this-server-is-lost).

### Taking the password out

A separate cutover, not yet run, and its order is not negotiable — turning `passwordAuth` off while
any consumer still needs one takes the site down, and the way back is an ARM write that itself
authenticates against Entra.

Two flags carry it, and each is a rollback rather than a one-way door. `DATABASE_AUTH` moves one
consumer at a time and defaults to `password`, so a consumer that misbehaves is reverted by unsetting
one environment variable and redeploying. `passwordAuthEnabled` in `main.bicepparam` is the server
side and stays `true` until every consumer has been proved on a token.

1. Deploy the shared identity, and — in `infra/azure/ingest.bicep` — move the Function App onto it:
   `identity.type` to `SystemAssigned,UserAssigned`, `AZURE_CLIENT_ID` and
   `ServiceBusConnection__clientId` set to `cd074036-4c63-4d1e-8ebb-72f448bb95a2`, and the Service
   Bus **Data Receiver** grant declared by `ingest.bicep`, because `ingest.bicep` owns the queue.

   That grant is not a new capability, and the ordering below depends on knowing so. Read live with
   `az role assignment list --all`, the shared identity **already holds** Data Receiver on
   `ingest-jobs` — assignment `0090d328-0cee-592f-8359-e4cc64940694`, alongside Data Sender
   `f1b97f59-263a-5e18-a1c0-40ce18436d52`. It was deployed before the grant moved out of this
   template, and incremental ARM does not delete what a template stops declaring, so its absence
   from the Bicep here is not a revocation. Revoking it was attempted and refused: the delete
   returns `ScopeLocked` naming `switchback-prod-no-delete`, the resource group's `CanNotDelete`
   lock, and lifting that is an Owner action.

   The grant is inert while no Service Bus receive code exists in this repository, and it becomes
   real capability — for every Vercel deployment, preview included, because the shared identity is
   also Vercel's — the moment the worker's code merges. Revocation being locked, `ingest.bicep`
   adopts it instead: resource `publisherReceiver`, named by the literal assignment id rather than
   `guid(...)`, so the template converges on this assignment rather than proposing a second grant of
   the same role to the same principal at the same scope. Adoption records the grant; it does not
   reduce it. Revoking still requires lifting `switchback-prod-no-delete` first, and that stays open
   as an Owner action.

2. Run `Postgres identity` → `provision`, **from `master`** — the CI identity's federated credential
   trusts no other ref, and a dispatch from a branch fails at `azure/login` with `AADSTS700213`. It
   renames `sbapp_vercel` to `sbapp_runtime` and then asserts the Entra mapping followed the rename.
   If the assertion fails, the inverse rename is the rollback and nothing has been dropped.
3. Set `DATABASE_AUTH=entra-vercel` on Vercel preview, then production, with password-free URLs
   naming `sbapp_runtime`. Prove a signed-in read and a write — `session.findUnique` is the canary.
4. Set `DATABASE_AUTH=entra` on the Function App and prove a tile ingests end to end.
5. Drop the Function App's system-assigned identity, delete the two role assignments it leaves
   behind — removing a `roleAssignment` from Bicep is not a revocation — and run `Postgres identity`
   → `retire` with `consumers_moved=MOVED`. The retire action asks for that assertion because the
   database cannot check it: the worker scales to zero between invocations, so `pg_stat_activity`
   shows no backend under its role whether or not it has been moved.
6. Re-prove **both** administrator doors in the same hour: `Postgres identity` → `inspect` from
   `master`, and the owner connecting from their own machine with ProtonVPN disconnected. Not "it
   worked last week".
7. Only now set `passwordAuthEnabled = false` and deploy.

Two things to settle before step 7. The `migrate` job in `ci.yml` mints its own token and no longer
reads `secrets.DIRECT_DATABASE_URL`; prove it by pushing a no-op change under `packages/db/prisma/`
while passwords still work, so a failure is a red run rather than an outage. And `.env` on the
owner's machine points at production — point it at the local Docker Postgres first, or every db
script, `npm run dev` and the e2e suite stop working at step 7 with a connection error and no
explanation.

After step 7 the recorded `sbadmin` password stops being break-glass. It is not a door any more; the
server refuses password authentication outright. From step 7 onward the template needs no password
at all: `administratorLoginPassword` defaults to empty and is omitted from the payload, so the
accidental-rotation hazard is gone rather than dormant.

**Rolling step 7 back — set `passwordAuthEnabled = true` and export the password with it.**

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

### Cutting over from Neon

Preconditions: verification green, and a low-traffic hour. Avoid 04:17 UTC —
`apps/web/vercel.json` runs the ingest drain cron then.

1. **Record the moment.** Note `T0` in UTC. Anything written to Neon after this exists only there.

2. **Save the way back — somewhere you can read it.** Not a GitHub Actions secret: those are
   write-only, so a rollback copy in one is not a copy. Put the Neon pooled and direct strings
   where a human can read them at 2am — here, `~/.sb-neon.url` and `~/.sb-neon-pooled.url`, plus
   the password-manager entry that holds the database credentials.

3. **Repoint production.** Change `DATABASE_URL` and `DIRECT_DATABASE_URL` in Vercel to the Azure
   values. Decide deliberately whether Preview moves too; leaving Preview on Neon doubles as a live
   rollback rehearsal. If the edit is refused or the value reverts, an integration owns the
   variable — disconnect the Neon _storage integration_ first (that does not delete the Neon
   database, so the rollback survives), then set it by hand. This is where a cutover stalls.

4. **Redeploy.** An environment-variable change does nothing to a running deployment, which is the
   single most common way a cutover appears to have done nothing. Fire the deploy hook, or press
   Redeploy in the dashboard.

5. **Wait for the alias**, exactly as `ci.yml`'s deploy job does: poll
   `https://switchback-three.vercel.app/api/version` until `.commit` matches and `.environment` is
   `production`.

6. **Smoke-test the six routes** from `ci.yml`: `/`, `/explore`, `/nearby`,
   `/trails/llanberis-path`, `/attribution`, `/manifest.webmanifest`. All 200, no redirects.

7. **Prove it is actually on Azure**, which none of the above does. Two checks:

   - `SELECT count(*) FROM pg_stat_activity WHERE datname = 'switchback'` on Azure should go from
     ~0 to non-zero, while Neon's connection count falls to zero.
   - Post a review through the UI and confirm the row lands in Azure's `reviews` and **not** in
     Neon's. That is the definitive test and it takes thirty seconds.

8. **Update the repository secrets** `DATABASE_URL` and `DIRECT_DATABASE_URL` to the Azure values,
   so `ci.yml`'s `migrate` job pushes schema to the live database.

9. **Delete any migration-scoped secrets.** Two of the three `AZURE_*` secrets carried `sbadmin`, a
   member of `azure_pg_admin` that can execute DDL against production. Before cutover they
   addressed a database nothing depended on; afterwards they addressed the live one, readable by
   any workflow anyone adds later. That is the blast-radius argument being quietly given up.

   **Done — and the caveat is which half of it is provable.** Only the deletion is:

   ```bash
   gh secret list --repo mbahgatTech/switchback | grep AZURE_
   ```

   No output means the deletion happened. **What it cannot tell you is whether the step ran in the
   right order.** Those two secrets were also the last remaining copy of the admin password. The
   instruction was to give it a home a human can read _before_ deleting them, precisely because
   deleting first converts "an unreadable copy exists" into "no copy exists at all" — and a
   password manager leaves no evidence anything here can query. **Treat the admin password as
   unconfirmed rather than safe** until someone who ran the step says otherwise.

### What can be lost, honestly

**Downtime: effectively zero.** The dump is a consistent snapshot that does not block writers, the
restore happens on a database nobody is using, and Vercel switches the alias atomically.

**Data loss: bounded by the window, not by the dump.** Anything written to Neon between the
snapshot and the moment Vercel starts talking to Azure exists only in Neon. Three sources:

- the drain cron, once a day at 04:17 UTC — just do not migrate in that minute;
- viewport ingest, which is **self-healing**: it is derived from OpenStreetMap and re-queueing the
  tiles regenerates it;
- human writes — `users`, `accounts`, `sessions`, `reviews`, `photos`, `activities`,
  `activity_samples`, `trail_lists`, `trail_list_items`, `completions`, `planned_routes`,
  `lifeline_sessions`, `mobile_refresh_tokens`. **This is the irreplaceable set.** A lost
  `activities` + `activity_samples` pair is somebody's recorded walk; a lost `photos` row leaves an
  orphaned object in R2 that nothing will ever reference. Losing `sessions` rows signs everyone out
  — cosmetic, self-healing, and the first thing anyone notices.

The web app's offline write queue (`apps/web/src/offline/`) replays some in-flight writes after
cutover, which partly cushions this.

**Closing the window is a manual job and no script here does it.** `verify:migration` only reads,
and no `reconcile` script exists. Replaying means `WHERE "createdAt" >= T0` on the human-authored
tables above, inserted `ON CONFLICT (id) DO NOTHING` — every id in `schema.prisma` is a `cuid()`
and there is not one `autoincrement()`, so there are no sequences to resync and no collisions. It
covers **inserts only**; updates and deletes made in the window are not recoverable this way. So
plan any cutover on the assumption that **writes in the window are not automatically recovered** —
tolerable because the window is minutes, ingest is self-healing and the irreplaceable set is small,
not because the recovery exists. That last clause used to be softened by the source database being
kept: anything stranded there could still be read and replayed by hand. Neon was deleted on
2026-08-07, so on any future move the window is the loss, and the only way to shrink it is to keep
it short.

### If you ever have to move the data again

The local route to Azure **corrupts TLS records under sustained `COPY`**
(`SSL error: sslv3 alert bad record mac`), which killed both a 4-way parallel restore and a
single-stream one part way through. The data was loaded table by table with retries, the largest
table in 13 chunks. A runner does not have this problem; plan for it if you are on a workstation.

Two things the preflight caught before any data moved, both now fixed in these files:

- **Collation.** Neon is `C.UTF-8`; this template said `en_US.utf8`, which is Azure's default. Byte
  order against dictionary order — every `ORDER BY name` would have silently reordered.
- **`default_text_search_config`.** Neon is `pg_catalog.simple`; Azure defaults to
  `pg_catalog.english`. No current query consults it (every `to_tsvector` /
  `websearch_to_tsquery` in the codebase names `'english'` explicitly), but it is matched anyway.

---

## The ingest queue and its worker

`ingest.bicep` adds a Service Bus queue and an Azure Functions worker that drains `ingest_jobs`
continuously, replacing a once-daily Vercel cron that claimed four tiles a run against a backlog of
14,320.

**It is a separate template, at resource-group scope, and that is the point.** It never declares the
server, its database, its firewall rules or its parameters. `administratorLoginPassword` is
`@secure()` with no default and ARM cannot read the current value back, so any deployment that
includes `postgres.bicep` writes whatever it is handed — and the live password is unconfirmed (see
[Read this first](#read-this-first)). Shipping a queue must not be the same operation as rotating the
production password. `main.bicep` is not modified by this work and is not redeployed by it. There is
no lock resource here either: the group's existing `CanNotDelete` does not block creates.

| Resource        | Value                                                                                  |
| --------------- | -------------------------------------------------------------------------------------- |
| Namespace       | `sb-switchback-prod-37ywppu5p7fri`, **Standard**, `disableLocalAuth: true` — no SAS    |
| Queue           | `ingest-jobs`, `lockDuration PT5M`, `maxDeliveryCount 5`, TTL `PT1H`, no sessions      |
| Publisher       | `id-switchback-vercel-publisher`, user-assigned, two Vercel federated credentials      |
| Publisher creds | Vercel OIDC token exchanged for an Entra token — **no key anywhere**                   |
| Worker          | `func-switchback-ingest-37ywppu5p7fri`, Linux Consumption (Y1), Node 22                |
| Worker creds    | System-assigned identity, **Data Sender + Data Receiver scoped to the queue**          |
| Plan            | `plan-switchback-ingest`, Y1 Dynamic, `functionAppScaleLimit: 1`                       |
| Telemetry       | `appi-switchback-ingest`, workspace-based onto the existing `log-switchback-prod`      |
| Alert           | `switchback-ingest-deadletter`, `DeadletteredMessages > 0` → `ag-switchback-prod`      |
| Cost            | ~$10/month Standard namespace; Consumption and the storage account are inside the free |

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

**This table bounds the Function App, which drains nothing today.** `INGEST_QUEUE_DRIVER` is
`postgres`, so Vercel owns the drain and every row above except the last is a property of the wrong
process — a lambda is a process, and Vercel starts as many as the traffic wants. What bounds the
fleet is `INGEST_MAX_DRAINERS = 1`, enforced across processes by an advisory lock in
`packages/ingest/src/drain-slot.ts`; `docs/architecture.md` states the resulting bound in full and
is the one place that does.

**`functionAppScaleLimit` caps scale-out, not instance count.** Consumption still replaces instances,
and for a few seconds around a replacement two hosts of this app run at once with a client each — the
17:32 trace on 2026-08-03 has instance `0--f7e39076-13` taking sequence 1 and `0--3f3e4037-7d`
starting 13 s later and taking sequence 2, with no evidence the first had stopped fetching. So: 2
sustained, up to 4 across a recycle. Fair use is about sustained load, so that is the honest number to
quote rather than an unqualified deployment-wide 2.

Vercel makes **zero** Overpass requests in an environment where `INGEST_QUEUE_DRIVER=servicebus`.
Three call sites in a Vercel process can reach Overpass — `/api/cron/drain`, `trails.kickIngest` and
`routes.kickNetwork` — and all three branch on the flag.

**That is per Vercel environment, not per deployment, and the difference is the whole number.** The
flag is an environment variable and Production and Preview hold it independently, while both resolve
`DATABASE_URL` to `psql-switchback-prod-37ywppu5p7fri` — the production server. So an environment on
`postgres`, or with the variable simply absent (`ingestQueueDriver()` reads anything unrecognised as
`postgres`), is a second drainer against the same `ingest_jobs`, with its own `OverpassClient` at 2
on every warm lambda. At 2026-08-03T23:26Z Production read `postgres` and Preview had no
`INGEST_QUEUE_DRIVER` at all, so the flag-on ceiling then was 2 + 2N, not 2. Check it, do not assume
it:

```bash
vercel env ls production | grep INGEST_QUEUE_DRIVER
vercel env ls preview    | grep INGEST_QUEUE_DRIVER   # absent is the failure mode, and looks like nothing
```

With both environments on `servicebus` the deployment-wide figure is the Azure one: 2 sustained, up
to 4 across a recycle. Raising any row in the table above is not a throughput knob.

### Deploying it

```bash
az provider register --namespace Microsoft.ServiceBus --wait   # NotRegistered by default

export INGEST_DATABASE_URL="…"                       # the sbapp connection string
export INGEST_OVERPASS_USER_AGENT="Switchback/0.1 (+https://switchback-three.vercel.app/attribution)"
export INGEST_QUEUE_DRIVER=postgres                  # or servicebus — no default, state it

az deployment group create \
  --name switchback-ingest --resource-group rg-switchback-prod-northcentralus \
  --template-file infra/azure/ingest.bicep \
  --parameters infra/azure/ingest.bicepparam

unset INGEST_DATABASE_URL
```

Both exported strings are load-bearing and both have bitten. `INGEST_OVERPASS_USER_AGENT` must carry
an `http(s)://` contact URL that reaches _this_ project — `assertUsableUserAgent` in
`packages/ingest/src/overpass.ts` throws inside the handler on a placeholder or on a host it knows is
not ours, so the worker dead-letters every tile after five deliveries with a message that names the
database rather than the user agent. `switchback.app` is on that rejected list by name: it reads like
ours, is registered to somebody else, and was what the Function App actually sent on every Overpass
request until 2026-08-03. Only the shape can be checked in code — that a URL reaches you is the one
thing the operator has to get right.
`INGEST_QUEUE_DRIVER` has no default on purpose: the deployment overwrites the Function App's setting
with whatever the parameter resolves to, and a default would let a routine deploy re-arm the
Postgres/Service Bus fan-out that an operator had just rolled back.

**The template deploy and the package push always run together, template first — and the push is a
script, not a command.** Linux Consumption runs the code from a package URL that
`az functionapp deployment source config-zip` writes into the same application-settings collection an
ARM deployment replaces wholesale. `ingest.bicep` therefore does not declare `WEBSITE_RUN_FROM_PACKAGE`
— and a Bicep deployment on its own leaves the app codeless until the next push. For the same reason,
a setting added by hand in the portal is erased by the next deployment: worker environment belongs in
the template.

```bash
bash .github/scripts/deploy-worker.sh apps/ingest-worker/dist.zip
```

That script is the whole sequence — push, trigger sync, and a wait for the running host to emit
`switchback-ingest-queue-health`, which no build without the current
`apps/ingest-worker/src/health.ts` produces. It fails if the package blob did not change or if no
heartbeat arrives, so a stale deploy cannot report success. `ci.yml`'s `deploy ingest worker` job
invokes the same file on every push to master; running it by hand and letting CI run it are the same
code path, which is the point.

The trigger sync inside it is not optional and cost half an hour to find. After an ARM deployment has
removed `WEBSITE_RUN_FROM_PACKAGE` and the push has put it back, the host comes up reporting
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

**Role assignments are in the template now.** They used to be conditional on
`DEPLOY_ROLE_ASSIGNMENTS`, with an `az role assignment create` in this file for an Owner to run,
because `Microsoft.Authorization/roleAssignments/write` is in Contributor's `notActions`. The
deploying service principal (`cf940ed6-…`, display name `plant`) was granted **Role Based Access
Control Administrator** (`f58310d9-a9f6-439a-9e8d-f62e7b41a168`), unconditioned, at this resource
group, on 2026-08-03 (assignment `8baf9393-029a-4226-a882-992a8146d775`). The parameter, the flag and
the runbook step are all gone: the four queue role assignments are ordinary resources in
`ingest.bicep` and nothing grants access by hand.

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
gets exactly the four assignments the template declares. This step existed only to converge the
environment that had already run the older template. To check any environment:

```bash
az rest --method GET --url "https://management.azure.com$QUEUE/providers/Microsoft.Authorization/roleAssignments?api-version=2022-04-01&\$filter=atScope()" \
  --query "value[?contains(properties.scope,'queues/ingest-jobs')].{assignment:name, principal:properties.principalId, role:properties.roleDefinitionId}" -o tsv
```

`atScope()` also returns what the subscription and the resource group grant — ten rows against this
estate — so the filter on `properties.scope` is what narrows it to the queue's own. Four rows:
Data Sender (`69a216fc-…`) and Data Receiver (`4f6d3b9b-…`) for the worker `3db30cfd-…`, and the
same pair for the publisher `c9bfba39-…`. `090c5cfd-751d-490a-894a-3ce6f1109419` (Data Owner) must
not be among them. The publisher's Receiver, assignment `0090d328-0cee-592f-8359-e4cc64940694`, is
the over-grant `ingest.bicep` adopts by literal id, and the resource group's delete lock is what
prevents revoking it.

### The two things Bicep cannot express

Recorded here for the same reason the `sbapp` role is: they are real steps, they are not in a
template, and a reader would otherwise conclude the template is the whole story.

1. **CI's deployment identity.** Entra app registrations and federated credentials on an _app_ are
   Microsoft Graph objects, not ARM, and Bicep cannot declare them. One time, as an Owner:
   `az ad app create` / `az ad sp create`, an `az ad app federated-credential create` scoped to
   `repo:mbahgatTech/switchback:ref:refs/heads/master`, `Contributor` **and** `Role Based Access
Control Administrator` on this resource group, then `gh secret set AZURE_CLIENT_ID` /
   `AZURE_TENANT_ID` / `AZURE_SUBSCRIPTION_ID`. No long-lived secret is stored.

   The Vercel publisher deliberately does **not** work this way. A federated credential on a
   _user-assigned managed identity_ is an ARM resource, so it is in `ingest.bicep` with everything
   else — see `publisherProduction` and `publisherPreview` there.

2. **Managed identity to Postgres is not done, deliberately.** The worker connects with
   `DATABASE_URL` the way the web app already does. Measured on the server: `activeDirectoryAuth:
Disabled`, `passwordAuth: Enabled`, `tenantId: null`. Turning it on means setting
   `authConfig.activeDirectoryAuth` and `tenantId`, creating an Entra administrator, running
   `pgaadauth_create_principal` for the worker's principal, and swapping the driver to token auth —
   and the first two are writes to the server resource, which is the password hazard at the top of
   this section. Service Bus needs no server change, so both Service Bus connections are keyless
   today and the database connection is not.

### Vercel's three variables

None of these is a secret; the credential is the per-deployment OIDC token, which is minted by
Vercel and never stored. Read them off the deployment outputs:

```bash
az deployment group show -g rg-switchback-prod-northcentralus -n switchback-ingest \
  --query "properties.outputs.{namespace:serviceBusFullyQualifiedNamespace.value,\
client:publisherClientId.value,tenant:publisherTenantId.value}" -o json
```

→ `SERVICE_BUS_NAMESPACE`, `AZURE_CLIENT_ID`, `AZURE_TENANT_ID` on the Vercel project, plus
`INGEST_QUEUE_DRIVER=servicebus`. The exchange fails silently at Entra if the Vercel **team or
project is renamed** — the `sub` claim follows the new name and the federated credential does not.
Fixing that is a one-parameter redeploy of this template.

---

## Known follow-up

Operational items outstanding are in [Read this first](#read-this-first). This one is code:

- **`packages/db/scripts/apply-spatial.ts`** constructs a bare `new PrismaClient()`, so all of
  `spatial.sql` — including three `CREATE EXTENSION` and every `CREATE INDEX` — runs over
  `DATABASE_URL`, the _pooled_ endpoint. Harmless on Burstable, where both URLs are the same 5432
  endpoint. It becomes DDL through a transaction-mode pooler the moment General Purpose is adopted,
  which is precisely what the `url`/`directUrl` split exists to prevent. One line: read
  `DIRECT_DATABASE_URL ?? DATABASE_URL` into `datasourceUrl`.
