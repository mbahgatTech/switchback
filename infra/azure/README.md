# Switchback's production database, on Azure

This directory provisions the PostgreSQL server that Switchback's production site runs on:
one **Azure Database for PostgreSQL Flexible Server**, PostgreSQL 17 with PostGIS, in its own
resource group, described entirely in Bicep.

It replaces **Neon**, and nothing else. The app stays on Vercel, photographs stay in
Cloudflare R2, CI stays on GitHub Actions. This is a database migration, not a platform
migration. **It is done** — production has been serving from Azure since 2026-07-30.

**Neon stays alive.** It is the rollback, it is not deleted, and it costs nothing while idle.
See [Rolling back](#rolling-back-to-neon) — that section is the reason several of the choices
below look under-engineered, and it is deliberate. It is also the section with the largest gap
between what an earlier revision of this file claimed and what was actually in place; read
[Status](#status-as-of-the-last-run) before relying on any of it.

---

## Status, as of the last run

**Production is on Azure.** The cutover happened on **2026-07-30 at about 20:09 UTC**, which is
the timestamp on the `DATABASE_URL` and `DIRECT_DATABASE_URL` repository secrets
(`gh secret list`) and matches the rewrite of the same two variables in Vercel's Production
environment. `https://switchback-three.vercel.app` serves from
`psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com`.

An earlier revision of this section said the opposite — "production has **not** been cut over,
`DATABASE_URL` and `DIRECT_DATABASE_URL` still point at Neon" — for several hours after it had.
That is the worst sentence this file could get wrong: it is the first thing a responder reads at
2am, it would have sent them to the wrong database, and it presents the whole of "Cutting over"
below as still-to-do when steps 3 and 8 re-run against a live system are destructive. The fix is
not just the correction; it is that this section now names **which steps ran and which did not**,
because "the cutover happened" and "the cutover finished" are different claims.

The data was migrated and verified before any of that. All 23 tables were copied from a
`REPEATABLE READ` exported snapshot; the source and target checksum files are byte identical, and
`scripts/verify-migration.ts` reports **72 checks, 72 passed, 0 warnings, 0 failed** — including
the geometry totals, both vertex-for-vertex spot checks, the 192-trail `/nearby` id set, and the
privilege assertions on `sbapp`.

### Which cutover steps actually ran

| Step                                      | State                                                       |
| ----------------------------------------- | ----------------------------------------------------------- |
| 1 Record `T0`                             | done                                                        |
| 2 Save the way back                       | **not done** — and the step as written was wrong. See below |
| 3 Repoint Vercel                          | done, 2026-07-30 ~20:0x UTC                                 |
| 4 Redeploy                                | done                                                        |
| 5 Wait for the alias                      | done                                                        |
| 6 Smoke-test the six routes               | done                                                        |
| 7 Prove it is on Azure                    | done                                                        |
| 8 Update the repository secrets           | done, 20:09:31Z / 20:09:32Z                                 |
| 9 Keep Neon schema-current                | **not done, and not going to be.** See "Rollback expiry"    |
| 10 Delete the `AZURE_*` migration secrets | **not done — outstanding.** See below                       |

**Step 2 was not skipped by accident; it was incoherent.** It said to copy the Neon connection
strings into `NEON_DATABASE_URL` / `NEON_DIRECT_DATABASE_URL` as GitHub repository secrets, and
then rollback step 1 said to read them back out. GitHub Actions secrets cannot be read back —
`gh api repos/mbahgatTech/switchback/actions/secrets/AZURE_DATABASE_URL` returns `name`,
`created_at` and `updated_at`, and no value field, by design. A rollback copy in a write-only
store is not a copy. "Rolling back to Neon" now sources the value from somewhere a human can
actually read at 2am.

**Step 10 is outstanding, and the order matters.** The three `AZURE_*` secrets are still present
(`gh secret list`), two of them carrying `sbadmin`, which is a member of `azure_pg_admin` and can
execute DDL against production. Nothing reads them any more: their only consumer was the
migration workflow, which this change deletes, and `ci.yml`'s `migrate` job reads `DATABASE_URL` /
`DIRECT_DATABASE_URL`. So they should go. They have not gone yet because **they are also the last
remaining copy of the admin password**, and deleting them before that password exists somewhere
readable converts "an unreadable copy exists" into "no copy exists at all". Do these two in this
order:

```bash
# 1. Give the admin password a home that can be read from. Rotating is the honest move here,
#    because the current value cannot be recovered to write down — see "Redeploying".
az postgres flexible-server update \
  --resource-group rg-switchback-prod-northcentralus \
  --name psql-switchback-prod-37ywppu5p7fri \
  --admin-password "$(openssl rand -hex 32)"
# …store it in the password manager, then rebuild and reset any secret carrying it.

# 2. Then, and only then, remove the migration credentials.
gh secret delete AZURE_DATABASE_URL        --repo mbahgatTech/switchback
gh secret delete AZURE_DIRECT_DATABASE_URL --repo mbahgatTech/switchback
gh secret delete AZURE_APP_DATABASE_URL    --repo mbahgatTech/switchback
```

Neither command is a change to this repository, so **merging this branch does not close step
10** and no review of it can. Both act on live state — one on the running server, one on the
repository's secret store — and the first needs a password manager that only a person has. The
step is recorded here as outstanding rather than dropped so that it survives the merge, and the
table above will keep saying `not done` until someone runs the two commands and edits the row.
To check where it stands without reading anything else:

```bash
gh secret list --repo mbahgatTech/switchback | grep AZURE_
```

Three lines means step 10 is still open. No output means it is done, and this section and the
row in the table above should both be updated to say so.

Two things the preflight caught before any data moved, both of which had been wrong in these
files and are now fixed:

- **Collation.** Neon is `C.UTF-8`; this template said `en_US.utf8`, which is what Azure
  creates by default. Byte order against dictionary order — every `ORDER BY name` would have
  silently reordered. The database was dropped and recreated with the source collation.
- **`default_text_search_config`.** Neon is `pg_catalog.simple`; Azure defaults to
  `pg_catalog.english`. No current query consults it (every `to_tsvector`/`websearch_to_tsquery`
  in the codebase names `'english'` explicitly), but it is now matched to the source.

**How it was run.** The migration was executed with the PostgreSQL 17 client from the machine
that owns this repository. There was a `migrate-to-azure.yml` workflow in this repository that
described the same procedure as four dispatchable modes; it has been **deleted**. It was never
run as a workflow — it could not be, being `workflow_dispatch`-only and never on the default
branch — so it was 1,047 lines of untested automation for a job that is finished. Every step it
would have taken is written out below, in order, with its SQL, which is the form that was
actually executed. Keeping an untested destructive `reset` mode reachable from a button, wired to
five credentials, to document a migration that is over, was the wrong trade.

Note also that this path is **not reliable for bulk transfer**: the local route to Azure
corrupts TLS records under sustained `COPY` (`SSL error: sslv3 alert bad record mac`), which
killed both a 4-way parallel restore and a single-stream one part way through. The data was
loaded table by table with retries, and the largest table in 13 chunks. If this ever has to be
done again over the same path, plan for that; a runner does not have the problem.

---

## Contents

| File               | What it is                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `main.bicep`       | Subscription-scoped. Creates the resource group, then calls the modules. Outputs the hostname. |
| `postgres.bicep`   | The server: compute, storage, backups, firewall, server parameters, the database.              |
| `monitoring.bicep` | Log Analytics workspace, the alert action group, and the workload budget.                      |
| `main.bicepparam`  | Every non-secret parameter. Committed. The password is **not** here and never may be.          |
| `README.md`        | This file.                                                                                     |

Verification lives in `scripts/verify-migration.ts`, two directories up, and is run with
`npm run verify:migration`. There is no migration workflow: there was one, it was never
executed, and it has been deleted — see "Status" above and "Verifying" below.

### A note on `$TMP`

Every shell block below writes intermediate files under `$TMP`. Define it once, before the
first block, and use one shell for the whole procedure:

```bash
TMP="${TMPDIR:-/tmp}"
```

An earlier revision used `$TEMP`, which is a Windows environment variable that Git Bash happens
to inherit. It is unset on Linux, on macOS and in a container, where `"$TEMP/pgpw"` expands to
`/pgpw` — a write at the filesystem root that either fails or, running as root, succeeds
somewhere nobody will think to shred. The admin password is the file in question.

---

## What it provisions

| Resource          | Value                                                           |
| ----------------- | --------------------------------------------------------------- |
| Resource group    | `rg-switchback-prod-northcentralus`                             |
| Region            | North Central US (Chicago)                                      |
| Server            | `psql-switchback-prod-<13 deterministic characters>`            |
| Version           | PostgreSQL 17, PostGIS 3.6.1                                    |
| Compute           | Burstable `Standard_B2s` — 2 vCore, 4 GiB, 414 user connections |
| Storage           | 64 GiB Premium SSD (240 IOPS), autogrow on                      |
| Backups           | 14 days, locally redundant, no geo-redundancy                   |
| High availability | None                                                            |
| Database          | `switchback`, collation `C.UTF-8` (matched to Neon)             |
| Admin login       | `sbadmin` (migration/CI); app connects as `sbapp`               |
| Network           | Public, one firewall rule spanning the internet                 |
| Extensions        | `postgis`, `pg_trgm`, `btree_gist` allow-listed                 |

### Cost

| Line                                        | USD / month |
| ------------------------------------------- | ----------- |
| Compute — Burstable `Standard_B2s`          | 49.64       |
| Storage — 64 GiB Premium SSD @ $0.115/GiB   | 7.36        |
| Backup — 14 days, inside the free allotment | 0.00        |
| **Total**                                   | **57.00**   |

Pay-as-you-go list prices for North Central US, verified against the retail API — they are
identical to the East US 2 prices this table originally quoted, so the region change cost
nothing.

**Headroom, honestly.** An earlier revision of this paragraph said the subscription's $150
monthly credit "leaves roughly $93 of headroom". That arithmetic assumed the credit was
dedicated to this workload, and it is not. Measured for July 2026 with
`Microsoft.CostManagement/query`:

| Resource group                                  | USD        |
| ----------------------------------------------- | ---------- |
| `rg-mazenbahgat-8881`                           | 179.85     |
| `me_plant-environment_plant_together_centralus` | 11.52      |
| `plant_together`                                | 0.02       |
| `rg-switchback-prod-northcentralus`             | 0.00       |
| **Subscription total**                          | **191.39** |

So the subscription is already over its $150 credit before this database has billed anything,
and the real headroom for adding to it is **negative**. The spending limit is still `On`
(`subscriptionPolicies.spendingLimit` on the ARM representation of the subscription — current
`az account show` reports it as `null`, which is a CLI regression, not a change of state), and
the subscription is still `Enabled`, which those two facts together do not explain. Establish
that from the billing page rather than from this file before treating the credit as a real
ceiling; it is the one number here that nothing in this repository can verify.

What that changes about the design: nothing, because the design was already sized to the
Burstable tier for exactly this reason. What it changes about the _alerting_ is the whole
budget section of `main.bicep` — a subscription-scoped budget cannot tell you anything about
this database when 94% of the subscription's spend is somebody else's, which is why
`monitoring.bicep` now carries a second, resource-group-scoped budget.

---

## Four decisions that look odd, explained

**North Central US, and not the Virginia region anyone would have picked.** Both East US and
East US 2 are _offer-restricted_ for this subscription: `az postgres flexible-server list-skus
--location eastus2` returns zero supported editions and the explicit reason "Subscriptions are
restricted from provisioning in this region", and `eastus` says the same. There is nothing to
deploy into. The first attempt at this deployment is still in the subscription's history as
`switchback-db | Failed`, `LocationIsOfferRestricted`, for exactly that reason.

Of the four regions that _are_ available — North Central US, Central US, Canada Central,
West US 3 — North Central US (Chicago) is the closest to Vercel's `iad1` and Neon's AWS
`us-east-1`, both of which are in northern Virginia. So the honest version of this decision is
that the database is now roughly 20 ms further from the application than it would have been in
Virginia, rather than the ~1 ms an earlier draft of this file claimed. That matters because a
tRPC call issues several queries and pays the round trip each time; budget it into the
post-cutover watch, where the p95 of `/nearby` is expected to rise. Pricing is identical
($0.068/hr compute, $0.115/GiB storage), so the $57.00 monthly total is unaffected. A Flexible
Server cannot be moved between regions afterwards.

**Burstable, which means no PgBouncer.** Azure's built-in connection pooler is not available on
the Burstable tier. That is a real loss and it is bought deliberately, because the alternative
is worse: General Purpose `Standard_D2ds_v5` plus this storage costs about $137/month, which is
91% of the monthly credit — and the subscription's spending limit _deallocates every resource_
when the credit runs out. Losing a pooler is a smaller problem than the database switching
itself off mid-month. `Standard_B2s` allows 414 user connections against a Vercel fleet that
holds at most ~15 per warm instance, so there is nothing for a pooler to solve here yet.

Not having PgBouncer also deletes an entire failure class: Azure's pooler runs transaction
pooling with `pgbouncer.max_prepared_statements` defaulting to `0`, and Prisma uses named
prepared statements for essentially every query. Getting that wrong produces intermittent
`prepared statement "s0" already exists` that appears only under concurrency — it passes every
smoke test and fails in production.

Escalating later is two values in `main.bicepparam` (`tier = 'GeneralPurpose'`,
`skuName = 'Standard_D2ds_v5'`) and a redeploy. PgBouncer, the pooled port and the
`pgbouncer=true` URL parameter all follow automatically from the tier — see the derivation at
the top of `postgres.bicep`. The signal to watch for is sustained `active_connections` above
~300, or `connection_failed` entries in the server log.

**One firewall rule, `0.0.0.0`–`255.255.255.255`.** Vercel serverless functions on this plan
have no static outbound IP addresses — dedicated egress is an Enterprise feature — and neither
do GitHub-hosted runners. There is no range to allowlist. A private endpoint is not the
alternative it looks like: it would put the server on an Azure virtual network, and Vercel's
functions run in Vercel's own AWS infrastructure with no route into it. Reaching it would need
a site-to-site VPN or ExpressRoute, which costs more than the database and is out of scope.
Azure also refuses to mix public and private access and will not let a server move between
them, so choosing private now would be a one-way door into a dead end.

So the perimeter is a credential, and the compensating controls are the actual security
posture: TLS is mandatory (`require_secure_transport`) and **verified** rather than merely
encrypted (`sslmode=verify-full` for libpq, `sslaccept=strict` for Prisma — without which a
session is encrypted to whoever answers for the hostname), the hostname carries a 13-character
deterministic suffix so scanners walking dictionary names find nothing, the admin password is
high-entropy and SCRAM-only, `connection_throttle.enable` backs off repeated failed logins,
`log_connections`/`log_disconnections` ship to Log Analytics so an unexpected login leaves a
record, and — the one that bounds the blast radius — **the credential Vercel carries is `sbapp`,
not `sbadmin`**: it can read and write rows and is refused `CREATE TABLE`, which
`scripts/verify-migration.ts` asserts by connecting as it and trying.
The residual risk is therefore _leakage_ rather than brute force — which makes the credential
inventory more important than any setting in these files. An inventory is only worth writing
down if it is **counted rather than asserted**, so this one is counted, and the count is not
the flattering one.

#### The sanctioned stores

Two stores are sanctioned for the connection strings the application and CI depend on: GitHub
Actions repository secrets, and Vercel environment variables. Not `.env`, not a parameter file,
not a commit. Everything below is what is actually in them — including the part that predates
this work and that an earlier revision of this section did not know about.

| Store             | Value                                 | Notes                                            |
| ----------------- | ------------------------------------- | ------------------------------------------------ |
| GitHub secret     | `DATABASE_URL`                        | read by `ci.yml`'s `migrate` job                 |
| GitHub secret     | `DIRECT_DATABASE_URL`                 | `prisma db push` runs through this, so `sbadmin` |
| GitHub secret     | `AZURE_DATABASE_URL`                  | `sbadmin`. No consumer left — delete, see Status |
| GitHub secret     | `AZURE_DIRECT_DATABASE_URL`           | `sbadmin`. Ditto                                 |
| GitHub secret     | `AZURE_APP_DATABASE_URL`              | `sbapp`. Ditto                                   |
| Vercel Production | `DATABASE_URL`, `DIRECT_DATABASE_URL` | `sbapp` — the web app never carries `sbadmin`    |
| Vercel Preview    | `DATABASE_URL`, `DIRECT_DATABASE_URL` | separate entries, added after the cutover        |

The values themselves cannot be read back out of GitHub, so that column is the design intent
plus what each consumer demonstrably requires, not a readback. If you need to know what a
secret actually contains, the only honest answer is to set it again from a source you trust.

#### The seventeen this file used to pretend were not there

An earlier revision of this section stated, as a rule, that the strings live "in exactly two
places… and nowhere else", named one exception, and closed with "the auditable count is: two
live strings (GitHub + Vercel), plus two rollback strings in GitHub. Four values… none anywhere
else."

That was false, and measurably so. `npx vercel env ls` against
`mbahgattechs-projects/switchback` lists **seventeen** further variables, every one of them
scoped to _Production **and Preview**_, put there by the Vercel↔Neon marketplace integration
when the project was first linked:

```
POSTGRES_URL   POSTGRES_URL_NO_SSL   POSTGRES_PRISMA_URL   POSTGRES_URL_NON_POOLING
DATABASE_URL_UNPOOLED   POSTGRES_PASSWORD   PGPASSWORD   POSTGRES_USER   PGUSER
POSTGRES_HOST   PGHOST   PGHOST_UNPOOLED   POSTGRES_DATABASE   PGDATABASE
NEON_PROJECT_ID   NEON_AUTH_BASE_URL   VITE_NEON_AUTH_URL
```

Five of those are complete Neon connection strings and two are the bare password. So the real
number of live-credential copies was never four; it was four plus at least seven, and the seven
sat in exactly the location the rule argued against two paragraphs later. The reviewer who
found this was right, and the specific way this file was wrong is worth naming: it audited what
the author had put there, not what was there. An inventory that only counts your own additions
is not an inventory.

Three things follow, and none of them is comfortable.

- **`POSTGRES_URL_NO_SSL` is a connection string with TLS switched off**, in a directory whose
  central security argument (`postgres.bicep`, the note at the foot) is that `sslmode=require`
  is already insufficient because an unauthenticated handshake is a way for the credential to
  leak. A no-SSL string is a strictly worse version of the thing this design refuses.
- **The Preview scope means every preview deployment, from any branch or pull request, is
  handed a working credential** for the database that is the documented rollback and still
  holds every user's email address and GPS history.
- **The migration did not remove any of them,** so cutover changed nothing about this.

They are not this change's fault — Vercel reports them as predating the branch — but they are
this change's problem, because this is the file that publishes the inventory.

**They are also, awkwardly, the thing that makes the rollback executable.** See "Rolling back":
`POSTGRES_URL_NON_POOLING` is a readable Neon connection string, and the rollback needs exactly
one of those. Which is the honest reason they are still there and not deleted in this change:
removing them is a live-production edit to a project whose Preview variables were being changed
by hand while this was written, they are integration-managed and get re-synced if forced (the
integration has to be disconnected first), and until the rollback is retired one of them is
load-bearing.

**So this is a second declared exception, not an omission.** Removing them is the last step of
retiring Neon, alongside deleting the Neon project itself:

```bash
# When Neon is retired — not before, the rollback reads POSTGRES_URL_NON_POOLING.
# Disconnect the Neon storage integration from the Vercel project first, or these come back.
npx vercel env rm POSTGRES_URL_NO_SSL production
npx vercel env rm POSTGRES_URL_NO_SSL preview
# …and the remaining sixteen.
```

If that is not being done today, `POSTGRES_URL_NO_SSL` should still go today: nothing in this
repository reads it (`apps/web/src/env.ts` reads `DATABASE_URL` and `DIRECT_DATABASE_URL`;
`git grep` finds no `POSTGRES_*` or `PG*` reference outside comments), and it is the only one of
the seventeen that is worse than the credential it carries.

Worth stating plainly: this is not a regression. Neon's endpoints are public and
credential-only today, with precisely the same exposure model.

**No geo-redundant backup, no high availability.** Both would be reasonable on a database
without a warm standby. This one has Neon: the disaster procedure is "point `DATABASE_URL`
back at Neon and redeploy", which restores service in minutes with no data loss up to the
cutover. Geo-restore takes minutes to hours, has up to an hour of RPO, and cannot do
point-in-time restore at all. A live, fully populated copy strictly dominates it.

`geoRedundantBackup` is **immutable after creation**. If Neon is ever decommissioned, this
becomes the weak point and changing it means rebuilding the server. Say so out loud at that
time rather than discovering it.

---

## Deploying

### Prerequisite: register the resource provider

The first deployment fails with `MissingSubscriptionRegistration` unless this has run. It is
idempotent and takes a minute or two.

```bash
az account set --subscription 5cb9e7c3-0e31-4388-94e9-b36eab4bf977
az provider register --namespace Microsoft.DBforPostgreSQL --wait
```

### Deploy

The admin password never reaches `argv`, a committed file, or a log line. It is generated into
a file under `$TMP`, exported into the environment, and read from there by
`readEnvironmentVariable` in `main.bicepparam`.

`openssl rand -hex 32` rather than `-base64`, and that is not a style preference: three places
in this repository parse `DATABASE_URL` with the WHATWG URL parser (`apps/web/src/env.ts`,
`packages/db/src/client.ts`, `vitest.config.ts`). A `/` in the userinfo — which base64 emits
about half the time — does **not** throw. It terminates the authority, the host silently
becomes something else, and the failure names nothing useful. Hex has no such characters.

```bash
openssl rand -hex 32 > "$TMP/pgpw"
export PGADMIN_PASSWORD="$(cat "$TMP/pgpw")"

az deployment sub create \
  --name switchback-db \
  --location northcentralus \
  --template-file infra/azure/main.bicep \
  --parameters infra/azure/main.bicepparam
```

**Put that password in a password manager now, before going any further.** This is the only
moment it is readable. It cannot be recovered from ARM (`administratorLoginPassword` is
`@secure()` and is never returned), it cannot be recovered from a GitHub Actions secret (those
are write-only), and it cannot be recovered from Vercel, which is never given it. A redeploy
has to pass the _same_ value, so a password that exists only inside a connection string nobody
can read is a password that has already been lost — the recovery is a rotation, which is a
different and more disruptive procedure. See "Redeploying".

Read the outputs — hostname, ports, and the two connection-string templates, none of which
contains the password:

```bash
az deployment sub show --name switchback-db --query properties.outputs -o json
```

**Preview before applying**, especially on a redeploy:

```bash
az deployment sub what-if \
  --location northcentralus \
  --template-file infra/azure/main.bicep \
  --parameters infra/azure/main.bicepparam
```

### Set the three new repository secrets

**These three are migration-scoped, and on a rebuild today you can skip this section
entirely.** Their only consumer was the deleted `migrate-to-azure.yml`; nothing in the
repository reads `AZURE_DATABASE_URL`, `AZURE_DIRECT_DATABASE_URL` or `AZURE_APP_DATABASE_URL`
now (`git grep -ln 'AZURE_.*DATABASE_URL'` returns this file and nothing else — `ci.yml`'s
`migrate` job reads `DATABASE_URL` / `DIRECT_DATABASE_URL`, and `scripts/verify-migration.ts`
takes `*_VERIFY_URL` from the environment of whoever runs it). A migration executed from a
workstation, which is how this one was executed, needs the three URLs in `$TMP` files and in
that shell — not in a write-only store no step reads back. The step is kept because it is what
was done, and because it is where the still-live secrets came from; if you do run it, **step 10
of "Cutting over" deletes them again**, and the gap between the two is the whole of the exposure
described under "Step 10 is outstanding".

Build each URL from `databaseUrlTemplate` / `directDatabaseUrlTemplate` /
`applicationDatabaseUrlTemplate` with the password substituted, write it to a `$TMP` file, and
pipe it in over stdin. Never `--body`, which puts the value in `argv` and in shell history.

```bash
gh secret set AZURE_DATABASE_URL        --repo mbahgatTech/switchback < "$TMP/azure-pooled"
gh secret set AZURE_DIRECT_DATABASE_URL --repo mbahgatTech/switchback < "$TMP/azure-direct"
gh secret set AZURE_APP_DATABASE_URL    --repo mbahgatTech/switchback < "$TMP/azure-app"
rm -f "$TMP/azure-pooled" "$TMP/azure-direct" "$TMP/azure-app" "$TMP/pgpw"
unset PGADMIN_PASSWORD
```

The `rm` is a shred of scratch files, **not** an archival step. Nothing here is a backup of the
password: see the note under "Deploy" about the password manager, and "Redeploying" about what
it costs to skip it.

The first two are `sbadmin` — the migration and CI credential, which can execute DDL because
`prisma db push` needs it. The third is `sbapp`, the least-privilege role, and it is the only
one Vercel is ever given; pick a _different_ password for it, since the whole point is that a
leak of the web credential is not a leak of the admin one. The role does not exist yet at this
stage — it is created by the role step below, and `scripts/verify-migration.ts` then connects as
it and asserts that `CREATE TABLE` is refused.

The existing `DATABASE_URL` and `DIRECT_DATABASE_URL` secrets keep pointing at Neon. They are
changed at cutover, not before.

On the Burstable tier all three Azure URLs use port **5432** and none carries `pgbouncer=true`:

```
AZURE_DATABASE_URL        postgresql://sbadmin:…@<host>:5432/switchback?sslmode=verify-full&sslaccept=strict
AZURE_DIRECT_DATABASE_URL postgresql://sbadmin:…@<host>:5432/switchback?sslmode=verify-full&sslaccept=strict
AZURE_APP_DATABASE_URL    postgresql://sbapp:…@<host>:5432/switchback?sslmode=verify-full&sslaccept=strict
```

`sslmode=verify-full` rather than `require`, and `sslaccept=strict` alongside it, are both
load-bearing — see the long note at the foot of `postgres.bicep`. `require` encrypts the
session and then accepts whatever certificate it is handed, which on an endpoint reachable from
all of IPv4 authenticates nothing; `verify-full` is the libpq half and `sslaccept=strict` is the
Prisma half, and each client ignores the other's parameter.

One consequence worth knowing before it surprises you: libpq looks for a root store in
`~/.postgresql/root.crt` and fails closed when it is absent, so anything running `psql`,
`pg_dump` or `pg_restore` against these URLs must also set `PGSSLROOTCERT` to a bundle
containing DigiCert Global Root G2 and Microsoft RSA Root CA 2017. On Debian and Ubuntu that is
`/etc/ssl/certs/ca-certificates.crt`; both roots are already in it.

The first two are identical, and that is correct rather than redundant — `schema.prisma`
requires `directUrl` to exist, and keeping the split means the eventual General Purpose
escalation is a pure environment-variable change with no code diff. On General Purpose,
`DATABASE_URL` moves to `:6432` and gains `&pgbouncer=true`.

Do **not** add `connection_limit` to either URL. It looks like a sensible thing to pin and it is
not: `backgroundUrl()` in `packages/db/src/client.ts` only injects `connection_limit=10` when
the URL does not already carry one, so setting a smaller value on `DATABASE_URL` silently
shrinks the _ingest_ pool too — while `COMMIT_CONCURRENCY` in `packages/ingest/src/pipeline.ts`
still derives six concurrent commits from the unchanged constant. Six commits against five
connections is a pool timeout on every drain.

### Redeploying

Re-running the template is a no-op, not a second server: every name is either fixed or a pure
function of the resource group id, so ARM reconciles the existing server.

"No-op" has a precise meaning here, and the header of `main.bicep` carries the measured version
— `az deployment sub what-if` reports a handful of properties that never converge, because they
are provider-assigned (`storage.iops`, `dataEncryption`, `replicationRole`) or because Azure
rewrites them on read (`source: user-override` collapsing to `system-default` on three server
parameters whose values happen to equal the engine default). None of them changes behaviour.
Read that list before concluding the template has drifted.

**The exception with teeth is the password.** ARM cannot read the current password, so whatever
is passed is written. Pass the _same_ value every time. A redeploy with a freshly generated
password silently rotates the admin credential and every connection string carrying it stops
working — including the ones Vercel is using to serve the site.

Which means the password has to exist somewhere a human can read at the moment of the redeploy.
There is exactly one such place and this file has to name it, because an earlier revision did
not and the omission made its own instructions impossible to follow: **a password-manager
entry.** Not the `$TMP` file, which the deploy procedure deletes three steps after creating it.
Not a GitHub Actions secret — those cannot be read back, only overwritten. Not Vercel, which is
deliberately never given the admin credential at all. If the value is not in a password manager
then it is not anywhere, and the sentence "pass the same value every time" is an instruction
nobody can carry out.

**If it has already been lost, rotate rather than guess.** This is a real procedure with real
consequences, not a footnote:

```bash
NEWPW="$(openssl rand -hex 32)"          # …and paste it into the password manager first
az postgres flexible-server update \
  --resource-group rg-switchback-prod-northcentralus \
  --name psql-switchback-prod-37ywppu5p7fri \
  --admin-password "$NEWPW"
```

Every connection string carrying `sbadmin` stops working the instant that returns — so rebuild
and re-set `DIRECT_DATABASE_URL` (and any surviving `AZURE_*` secret) in the same sitting. The
site itself is unaffected: Vercel carries `sbapp`, whose password is separate and is not touched
by this. That separation is the whole reason for the two-role design, and this is the day it
pays for itself.

Add a delete lock once you are happy with it. Deleting a Flexible Server deletes all of its
backups, irrecoverably:

```bash
az lock create --name no-delete --lock-type CanNotDelete \
  --resource-group rg-switchback-prod-northcentralus
```

---

## Creating the least-privilege application role

`sbapp` is the credential Vercel carries. ARM cannot run SQL, so `postgres.bicep` names the
role but cannot create it; this is the step that does, and `scripts/verify-migration.ts` is what
turns it from an intention into a checked claim.

It has been run. It is written out here because it is the only remaining record of it, and
because it has to be run again against any rebuilt server.

Connect as `sbadmin` with `psql`, then:

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
produces a `permission denied` on a table the app has never seen — at runtime, in production,
on whichever page reads it first.

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

`scripts/verify-migration.ts` compares a source and a target and prints a table of pass/fail.
It is the thing that proves a migration rather than assuming it, and it is worth re-running
after any restore, any rebuild, and any cutover.

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
| `AZURE_APP_VERIFY_URL`         | Recorded as a **failure**, not a skip — see below                       |
| `NEON_CHECKSUMS`               | Recorded as a **failure** (`checksums · source file not found at`)      |
| `AZURE_CHECKSUMS`              | Same, for the target                                                    |
| `CHECKSUM_SNAPSHOT_CONSISTENT` | Treated as not `1`, which loosens the ingest-derived tables to warnings |

**None of the first five is optional, and that is deliberate rather than an oversight.** All
five are required inputs; omitting one produces a red run, not a shorter one. The privilege
check says why in its own failure text: the least-privilege role is listed by `postgres.bicep`
as a compensating control for a firewall spanning the whole internet, and a control that was
not checked is exactly what such a list must not contain. Silently skipping it would turn a
missing environment variable into a clean bill of health.

So a green run means every check ran. If you genuinely want a structure-only pass — no
checksums, no privilege assertion — read the red lines and decide they are acceptable, rather
than expecting the script to make that decision for you.

Checksum files are `table|rows|md5` per line, computed in SQL on each side. On the source they
must be taken from _inside the transaction snapshot `pg_dump` used_, and
`CHECKSUM_SNAPSHOT_CONSISTENT=1` is the assertion that they were.

Without that flag the ingest-derived tables (trails, waypoints, tiles, jobs, sessions) are
compared against a _live_ Neon that keeps taking writes, so a difference in those is reported as
a warning rather than a failure. A difference anywhere else is still a failure. `photos` is
deliberately not on the forgiving list: it holds user uploads as well as ingest-derived hero
images, and treating somebody's lost photograph as expected churn is the wrong default.

The first check, before any query, is that the two URLs name different hosts. A verification
run comparing a database to itself passes everything else in the file perfectly, and it is one
copy-paste away.

### What verification actually proves

`pg_restore` exiting 0 proves that a program finished. `scripts/verify-migration.ts` proves
rather more, and every check exists because there is a specific way this can look complete and
not be:

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

The row checksums are computed from _inside the transaction snapshot `pg_dump` used_, so the
comparison is exact rather than racy. Neon keeps taking writes while the dump runs — viewport
ingest fires asynchronously on any `trails.browse` over un-ingested ground — and a naive
after-the-fact count comparison would disagree for entirely innocent reasons, which is worse
than no check because it trains you to wave off a mismatch.

It prints a table of pass/fail and exits non-zero on any failure. It prints no connection
string and no row of user data.

---

## Cutting over

**This has already been done** — see "Status" at the top for what ran and what did not. What
follows is the procedure as executed, kept because the same steps apply to any rebuild, and
because two of them are still outstanding.

Preconditions: verification green, and a low-traffic hour. Avoid 04:17 UTC —
`apps/web/vercel.json` runs the ingest drain cron then.

1. **Record the moment.** Note `T0` in UTC. Anything written to Neon after this exists only
   there.

2. **Save the way back — somewhere you can read it from.** This step used to say to copy the
   Neon strings into `NEON_DATABASE_URL` / `NEON_DIRECT_DATABASE_URL` as GitHub repository
   secrets. **That was wrong and the instruction has been removed rather than repaired.**

   GitHub Actions secrets are write-only. `gh api repos/mbahgatTech/switchback/actions/secrets/
AZURE_DATABASE_URL` returns `name`, `created_at` and `updated_at` and no value field; there
   is no API, CLI flag or UI affordance that returns the contents. A rollback copy in a store
   that cannot be read is not a copy, and rollback step 1 — which said to read them back —
   could never have worked. The step was also never performed, so the mistake stayed
   theoretical, which is the only good thing about it.

   A GitHub secret is still the right home for a value a _workflow_ consumes, because a
   workflow does not need to read it, only to be handed it. It is the wrong home for a value a
   _human_ has to type at 2am. Those are different requirements and this file used to conflate
   them.

   So: put the Neon pooled and direct strings in **the password-manager entry that already
   holds the database credentials**, next to the Azure admin password. Then see "Rolling back",
   which now names two sources that can actually be read.

3. **Repoint production.** Change `DATABASE_URL` and `DIRECT_DATABASE_URL` to the Azure values.
   Note that `DATABASE_URL` currently spans **Production and Preview** as a single entry —
   decide deliberately whether Preview moves too. Leaving Preview on Neon doubles as a live
   rollback rehearsal.

   `DATABASE_URL` may be owned by the Vercel↔Neon marketplace integration rather than by a
   human: its Production+Preview scoping and its shared timestamp with the whole
   `POSTGRES_*`/`PG*`/`NEON_*` block point that way, and integration-managed variables are
   read-only in the UI and get re-synced if forced. If the edit is refused or the value
   reverts, disconnect the Neon _storage integration_ from the Vercel project first — that does
   not delete the Neon database, so the rollback survives — and then set the variable by hand.
   This is the most likely place the cutover stalls.

4. **Redeploy.** An environment-variable change does nothing to a running deployment. This is
   the single most common way a cutover appears to have done nothing. Fire the deploy hook, or
   press Redeploy in the dashboard.

5. **Wait for the alias**, exactly as `ci.yml`'s deploy job does: poll
   `https://switchback-three.vercel.app/api/version` until `.commit` matches and
   `.environment` is `production`.

6. **Smoke-test the six routes** from `ci.yml`: `/`, `/explore`, `/nearby`,
   `/trails/llanberis-path`, `/attribution`, `/manifest.webmanifest`. All 200, no redirects.
   Note that `/api/version` reads no database, so a green `/api/version` proves nothing about
   Postgres — `/nearby` and `/trails/llanberis-path` do.

7. **Prove it is actually on Azure**, which none of the above does. Two checks, both quick:

   - `SELECT count(*) FROM pg_stat_activity WHERE datname = 'switchback'` on Azure should go
     from ~0 to non-zero, while Neon's connection count falls to zero.
   - Post a review through the UI and confirm the row lands in Azure's `reviews` and **not** in
     Neon's. That is the definitive test and it takes thirty seconds.

8. **Update the repository secrets** `DATABASE_URL` and `DIRECT_DATABASE_URL` to the Azure
   values, so `ci.yml`'s `migrate` job pushes schema to the live database.

9. **Keep Neon schema-current while it is the rollback — or accept that it is not.** The
   original instruction here was to add a second `db push` against a `NEON_DIRECT_DATABASE_URL`
   secret to `ci.yml`'s `migrate` job. **That was not done, and it is not being done.** The
   reasoning is in "Rollback expiry" below; the short version is that a second `db push` to a
   database nothing serves is a schema migration running unwatched against the one copy of the
   data that exists if Azure is broken, and the failure mode of _that_ going wrong is worse than
   the failure mode it prevents. What replaces it is stating the consequence out loud rather
   than leaving an unticked instruction that a reader assumes was followed.

10. **Delete the migration secrets.** Once `DATABASE_URL` / `DIRECT_DATABASE_URL` point at
    Azure, the `AZURE_*` trio has done its job and should not outlive it:

    ```bash
    gh secret delete AZURE_DATABASE_URL        --repo mbahgatTech/switchback
    gh secret delete AZURE_DIRECT_DATABASE_URL --repo mbahgatTech/switchback
    gh secret delete AZURE_APP_DATABASE_URL    --repo mbahgatTech/switchback
    ```

    **Outstanding** — see "Status" for why the admin password has to be rotated into a password
    manager first, and why deleting these before that would destroy the last copy of it.

    Two of the three carry `sbadmin`, which is a member of `azure_pg_admin` and can execute DDL
    against production. Before cutover they addressed a database nothing depended on; they now
    address the live one. The whole blast-radius argument of this design is that the credential
    reachable from CI and from Vercel is `sbapp` — leaving a DDL-capable production credential
    in repository secrets, readable by any workflow anyone adds later, is that argument being
    quietly given up.

    An earlier revision justified keeping them by pointing at `assert_target_is_not_live` inside
    `migrate-to-azure.yml`, which refused destructive modes once the target host matched the
    live one. That guard was real and it did work. It is also gone, along with the workflow, so
    the argument it supported no longer stands and these secrets have no compensating control
    and no consumer. Delete them.

### What can be lost, honestly

**Downtime: effectively zero.** Nothing goes offline. The dump is a consistent snapshot that
does not block writers, the restore happens on a database nobody is using, and Vercel switches
the alias atomically.

**Data loss: bounded by the window, not by the dump.** Anything written to Neon between the
snapshot and the moment Vercel starts talking to Azure exists only in Neon. Three sources:

- the drain cron, once a day at 04:17 UTC — just do not migrate in that minute;
- viewport ingest, which is **self-healing**: it is derived from OpenStreetMap and re-queueing
  the tiles regenerates it;
- human writes — `users`, `accounts`, `sessions`, `reviews`, `photos`, `activities`,
  `activity_samples`, `trail_lists`, `trail_list_items`, `completions`, `planned_routes`,
  `lifeline_sessions`, `mobile_refresh_tokens`. **This is the irreplaceable set** and it is
  small. A lost `activities` + `activity_samples` pair is somebody's recorded walk; a lost
  `photos` row leaves an orphaned object in R2 that nothing will ever reference. Losing
  `sessions` rows signs everyone out — cosmetic, self-healing, and the first thing anyone
  notices.

The web app's offline write queue (`apps/web/src/offline/`) replays some in-flight writes after
cutover, which partly cushions this.

**Closing the window is a manual job, and there is no tool here that does it.** Replaying the
rows means `WHERE "createdAt" >= T0` on the human-authored tables above, inserted
`ON CONFLICT (id) DO NOTHING`. Every id in `schema.prisma` is a `cuid()` and there is not one
`autoincrement()` in the file, so there are no sequences to resync and no collisions, and it
would cover **inserts only** — updates and deletes made in the window are not recoverable this
way.

Say plainly what that costs, because an earlier draft of this file described the replay as
though it were a step someone could take: no script in this repository does it. `verify:migration`
only reads, and no `reconcile` script exists. Nor is one trivial in the direction that matters
most: everything here that touches Neon does so read-only, deliberately, and a reconcile in the
rollback direction would have to be the first thing that writes to it.

So plan the cutover on the assumption that **writes in the window are not automatically
recovered**. That is tolerable because of what the window contains, not because the recovery
exists: the window is minutes, ingest is self-healing, and the irreplaceable set is the eleven
human-authored tables — which on this corpus currently holds 1 user, 1 account, 2 sessions,
3 trail lists and 0 reviews, activities or planned routes. Nothing is _lost_ in any case: Neon
is retained intact, so anything stranded there can still be read and replayed by hand later,
deliberately, by someone with both credentials in front of them.

---

## Rolling back to Neon

Neon is retained, populated and reachable. Rolling back is a Vercel change and a redeploy.

1. **Get the Neon connection strings.** Two sources, both readable, in preference order:

   - **The Vercel project already holds them.** The Neon marketplace integration put
     `POSTGRES_URL_NON_POOLING` and `POSTGRES_URL` into this project, scoped to Production and
     Preview, and cutover did not remove them. Read either from the Vercel dashboard, or:

     ```bash
     npx vercel env pull /tmp/neon.env --environment=production
     grep -E '^POSTGRES_URL(_NON_POOLING)?=' /tmp/neon.env
     # …and shred it: rm -f /tmp/neon.env
     ```

     `POSTGRES_URL_NON_POOLING` is the direct endpoint, `POSTGRES_URL` the pooled one. There is
     an irony here worth naming rather than hiding: the seventeen variables the security section
     above criticises are the reason this step has an input at all.

   - **The Neon console**, connection-string panel for the project's branch and role. If the
     password is no longer displayed, reset the role password there and rebuild the URL. This is
     the source that survives the integration being disconnected.

   **Not** from a GitHub Actions secret. `NEON_DATABASE_URL` / `NEON_DIRECT_DATABASE_URL` were
   never created, and had they been they would not be readable — Actions secrets are write-only.
   An earlier revision of this step said to read them from there, which could not have worked on
   the night it mattered.

   Then set `DATABASE_URL` and `DIRECT_DATABASE_URL` in Vercel → Production back to those values.

2. Redeploy. Poll `/api/version`. Run the six smoke routes.
   **Time to restore service: about 3–5 minutes**, nearly all of it the redeploy.
3. **Push the schema to Neon before trusting it.** Neon's schema is frozen at the cutover commit
   — see "Rollback expiry". If anything has shipped since, reconcile it by hand:

   ```bash
   DATABASE_URL='<neon-pooled>' DIRECT_DATABASE_URL='<neon-direct>' npm run db:push
   ```

   Read the diff Prisma proposes before accepting it. Note that `db:push` loads `.env` through
   `dotenv-cli`, which does not override variables already present in the environment — so the
   two above win, but check the host it prints before answering any prompt.

4. Revert the repository secrets `DATABASE_URL` / `DIRECT_DATABASE_URL` to the Neon values.
5. Reconcile in reverse: rows written to Azure since cutover exist only there. As above, this is
   manual — no script here performs it. Leave Azure intact and replay by hand if the set turns
   out to matter.
6. **Leave Azure running and intact** until the cause is understood. Do not delete the evidence.

**Rollback expiry.** Two things bound it, and the first one is already running.

**Neon's schema is frozen at the cutover commit, and nothing keeps it current.** Cutover step 9
proposed a second `db push` against Neon from `ci.yml`; it was never added and is not going to
be. So the honest statement is: the first schema change shipped after 2026-07-30 20:09 UTC makes
a rollback a two-step operation rather than one — repoint, then `db push` against Neon by hand,
as step 3 above says — and the further past the cutover, the larger the diff that `db push` will
propose against a database holding the only copy of anything Azure has lost. That is survivable
while it is a column or two. It stops being survivable quietly, which is why it is written here
rather than left implied by an unticked checkbox.

**And the Azure-only write set has to stay small enough to replay by hand.** It grows every day.

**Keep Neon for at least 30 days,** and treat the rollback as expiring rather than permanent.
Neon suspends idle compute automatically and retains the data, so a warm rollback costs nothing
while it lasts.

### Signals that the cutover went wrong

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

That last row is the one with no five-minute fix. The recovery is either to wait for the next
billing month or to remove the spending limit, which converts the subscription to
pay-as-you-go and starts charging a card. Roll back to Neon while deciding, and read the budget
section of `main.bicep`.

Watch for an hour after cutover: Vercel function error rate, Azure active connections and CPU,
and the p95 of `/nearby`. If any of the first four appear and are not fixable in five minutes,
**roll back first and diagnose afterwards** — Neon is warm and the cost of rolling back is one
redeploy.

---

## Known follow-ups, deliberately not done here

Operational steps that are outstanding are in [Status](#status-as-of-the-last-run), not here —
rotating the admin password into a password manager, deleting the three `AZURE_*` secrets, and
removing the Neon integration's seventeen Vercel variables when Neon is retired. This section is
for code that belongs to the application rather than to the infrastructure.

- ~~**`packages/db/scripts/seed.ts`, `seed-reviews.ts`, `seed-tracks.ts`**~~ — **done in this
  change, not left for later.** All three gated on `/neon\.tech|amazonaws\.com|supabase\.co/`,
  which Azure's hostname matches none of, so after cutover the guard that stops someone seeding
  production would have _silently permitted it_. `postgres\.database\.azure\.com` is now in the
  pattern in all three files, with the Neon alternate kept so Neon stays refused while it is the
  rollback. It was listed here as a follow-up and that was the wrong call: a safety net that
  fails open, and fails open exactly when everyone is distracted by a migration, belongs in the
  change that creates the exposure.

- **`packages/db/scripts/apply-spatial.ts`** constructs a bare `new PrismaClient()`, so all of
  `spatial.sql` — including three `CREATE EXTENSION` and every `CREATE INDEX` — runs over
  `DATABASE_URL`, the _pooled_ endpoint. Harmless on the Burstable tier, where both URLs are
  the same 5432 endpoint. It becomes DDL through a transaction-mode pooler the moment General
  Purpose is adopted, which is precisely what the `url`/`directUrl` split exists to prevent.
  One line: read `DIRECT_DATABASE_URL ?? DATABASE_URL` into `datasourceUrl`.

- **Three comments name Neon** where they now mean Azure: `packages/db/prisma/schema.prisma`
  (why `directUrl` exists), `packages/db/src/client.ts` (why the global stash exists), and
  `.github/workflows/ci.yml` (the `migrate` job, and the claim that the CI PostGIS image
  matches production — CI runs 3.5, Azure ships 3.6.1, and that skew is worth recording rather
  than papering over).
