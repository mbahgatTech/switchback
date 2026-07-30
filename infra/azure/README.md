# Switchback's production database, on Azure

This directory provisions the PostgreSQL server that Switchback's production site runs on:
one **Azure Database for PostgreSQL Flexible Server**, PostgreSQL 17 with PostGIS, in its own
resource group, described entirely in Bicep.

It replaces **Neon**, and nothing else. The app stays on Vercel, photographs stay in
Cloudflare R2, CI stays on GitHub Actions. This is a database migration, not a platform
migration.

**Neon stays alive.** It is the rollback, it is not deleted, and it costs nothing while idle.
See [Rolling back](#rolling-back-to-neon) — that section is the reason several of the choices
below look under-engineered, and it is deliberate.

---

## Status, as of the last run

The server exists and **the data has been migrated and verified.** All 23 tables were copied
from a `REPEATABLE READ` exported snapshot; the source and target checksum files are byte
identical, and `scripts/verify-migration.ts` reports **72 checks, 72 passed, 0 warnings,
0 failed** — including the geometry totals, both vertex-for-vertex spot checks, the 192-trail
`/nearby` id set, and the privilege assertions on `sbapp`.

Production has **not** been cut over. `DATABASE_URL` and `DIRECT_DATABASE_URL` still point at
Neon in both Vercel and the repository secrets; the cutover below is a deliberate manual step.

Two things the preflight caught before any data moved, both of which had been wrong in these
files and are now fixed:

- **Collation.** Neon is `C.UTF-8`; this template said `en_US.utf8`, which is what Azure
  creates by default. Byte order against dictionary order — every `ORDER BY name` would have
  silently reordered. The database was dropped and recreated with the source collation.
- **`default_text_search_config`.** Neon is `pg_catalog.simple`; Azure defaults to
  `pg_catalog.english`. No current query consults it (every `to_tsvector`/`websearch_to_tsquery`
  in the codebase names `'english'` explicitly), but it is now matched to the source.

**How it was run, and why that matters.** The migration was executed with the PostgreSQL 17
client from the machine that owns this repository, not from a GitHub Actions runner, because
`migrate-to-azure.yml` is `workflow_dispatch`-only and cannot be dispatched until it exists on
the default branch. The workflow remains the documented mechanism and every step below was run
in its order, with its SQL — but it has still never been executed _as a workflow_, and that is
the one claim in this directory nobody should treat as tested. Run `preflight`, then `verify`,
from a runner once it lands on `master`.

Note also that this path is **not reliable for bulk transfer**: the local route to Azure
corrupts TLS records under sustained `COPY` (`SSL error: sslv3 alert bad record mac`), which
killed both a 4-way parallel restore and a single-stream one part way through. The data was
loaded table by table with retries, and the largest table in 13 chunks. A runner does not have
this problem, and it is the reason the workflow exists.

---

## Contents

| File              | What it is                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `main.bicep`      | Subscription-scoped. Creates the resource group, then calls the module. Outputs the hostname. |
| `postgres.bicep`  | The server: compute, storage, backups, firewall, server parameters, the database.             |
| `main.bicepparam` | Every non-secret parameter. Committed. The password is **not** here and never may be.         |
| `README.md`       | This file.                                                                                    |

The migration itself lives in `.github/workflows/migrate-to-azure.yml` and
`scripts/verify-migration.ts`, one directory up.

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
nothing. The subscription paying for this carries a $150
monthly credit, so this leaves roughly $93 of headroom — enough to absorb an autogrow step,
Microsoft Defender for open-source relational databases (~$15), and a diagnostic setting,
without approaching the ceiling.

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
The residual risk is therefore _leakage_ rather than brute force — which makes one operational
rule more important than any setting in these files:

> The connection strings live in exactly two places — GitHub Actions repository secrets and
> Vercel production environment variables — and nowhere else. Not in `.env`, not in a parameter
> file, not in a runbook, not in a commit.

That rule has exactly one exception, and naming it here is the point — an unwritten exception
is how a rule stops being auditable. **The rollback copies of the Neon strings stay in the
GitHub repository secrets, where they already are.** `DATABASE_URL` and `DIRECT_DATABASE_URL`
hold Neon today; at cutover they are repointed at Azure, and the Neon values move to
`NEON_DATABASE_URL` / `NEON_DIRECT_DATABASE_URL` **as repository secrets only**. They are not
pre-staged into Vercel: an environment variable sitting unused in a production project is
another place the credential can be read, screenshotted or exported by anyone with project
access, and the rollback does not need it there — step 1 of the rollback pastes the value in by
hand, from the secret, at the moment it is needed.

So the auditable count is: two live strings (GitHub + Vercel), plus two rollback strings in
GitHub. Four values, all in one of the two sanctioned stores, and none anywhere else.

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
a file under `$TEMP`, exported into the environment, and read from there by
`readEnvironmentVariable` in `main.bicepparam`.

`openssl rand -hex 32` rather than `-base64`, and that is not a style preference: three places
in this repository parse `DATABASE_URL` with the WHATWG URL parser (`apps/web/src/env.ts`,
`packages/db/src/client.ts`, `vitest.config.ts`). A `/` in the userinfo — which base64 emits
about half the time — does **not** throw. It terminates the authority, the host silently
becomes something else, and the failure names nothing useful. Hex has no such characters.

```bash
openssl rand -hex 32 > "$TEMP/pgpw"
export PGADMIN_PASSWORD="$(cat "$TEMP/pgpw")"

az deployment sub create \
  --name switchback-db \
  --location northcentralus \
  --template-file infra/azure/main.bicep \
  --parameters infra/azure/main.bicepparam
```

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

Build each URL from `databaseUrlTemplate` / `directDatabaseUrlTemplate` /
`applicationDatabaseUrlTemplate` with the password substituted, write it to a `$TEMP` file, and
pipe it in over stdin. Never `--body`, which puts the value in `argv` and in shell history.

```bash
gh secret set AZURE_DATABASE_URL        --repo mbahgatTech/switchback < "$TEMP/azure-pooled"
gh secret set AZURE_DIRECT_DATABASE_URL --repo mbahgatTech/switchback < "$TEMP/azure-direct"
gh secret set AZURE_APP_DATABASE_URL    --repo mbahgatTech/switchback < "$TEMP/azure-app"
rm -f "$TEMP/azure-pooled" "$TEMP/azure-direct" "$TEMP/azure-app" "$TEMP/pgpw"
unset PGADMIN_PASSWORD
```

The first two are `sbadmin` — the migration and CI credential, which can execute DDL because
`prisma db push` needs it. The third is `sbapp`, the least-privilege role, and it is the only
one Vercel is ever given; pick a _different_ password for it, since the whole point is that a
leak of the web credential is not a leak of the admin one. The role does not exist yet at this
stage: `migrate` mode creates it from this secret, and `scripts/verify-migration.ts` then
connects as it and asserts that `CREATE TABLE` is refused.

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
`pg_dump` or `pg_restore` against these URLs must also set `PGSSLROOTCERT`. The migration
workflow points it at the runner's system bundle, which already contains DigiCert Global
Root G2 and Microsoft RSA Root CA 2017.

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

**With one exception.** ARM cannot read the current password, so whatever is passed is written.
Pass the _same_ value every time. A redeploy with a freshly generated password silently rotates
the admin credential and every connection string carrying it stops working — including the ones
Vercel is using to serve the site.

Add a delete lock once you are happy with it. Deleting a Flexible Server deletes all of its
backups, irrecoverably:

```bash
az lock create --name no-delete --lock-type CanNotDelete \
  --resource-group rg-switchback-prod-northcentralus
```

---

## Running the migration

Everything that opens a Postgres socket runs on a GitHub Actions runner, because the machine
that owns this repository cannot reach port 5432 — a VPN is the default route there and
black-holes it. Everything that talks to Azure's control plane (`az`) runs locally over 443.
That split is why the workflow needs no Azure credentials at all.

The workflow is **`Migrate Neon → Azure`** in the Actions tab, or:

```bash
gh workflow run migrate-to-azure.yml --repo mbahgatTech/switchback -f mode=preflight
```

It has four modes.

### 1. `preflight` — read-only, changes nothing

Run this first, always. It proves:

- the runner has PostgreSQL **17** client tools (the image ships 16, and `pg_dump` refuses to
  dump a newer server — this is the first thing that goes wrong if nobody looks);
- both endpoints are reachable and what version they are;
- the negotiated TLS version on each side;
- the two databases have the **same collation** — a mismatch restores fine and then silently
  reorders every `ORDER BY name` and rebuilds the partial unique index on `trail_lists` under
  different rules, so preflight refuses to continue;
- `postgis`, `pg_trgm` and `btree_gist` can actually be created on the target. This is the
  classic first failure of an Azure PostgreSQL migration: ARM records `azure.extensions`, the
  portal shows the value, and `CREATE EXTENSION` still fails because the engine kept its
  default. Preflight creates them inside a transaction and rolls back, so it proves the
  allowlist without leaving anything behind.

### 2. `migrate` — the real thing

Dump from Neon, restore into Azure, converge the schema, `VACUUM ANALYZE`, verify. Refuses a
target that already has tables unless `allow_overwrite` is ticked.

Neon is never written to: every connection to it carries
`default_transaction_read_only=on`, so that is a guarantee the server enforces rather than an
intention. The dump never leaves the runner — no artifact upload, ever. It contains every
user's email address, every recorded GPS track and every session token.

Expect roughly 20–40 minutes end to end for the ~382 MB corpus.

### 3. `verify` — verification alone

Re-checks whatever is already in the target. Useful after a cutover. Because it compares
against a _live_ Neon rather than a frozen snapshot, differences in ingest-derived tables
(trails, waypoints, tiles, jobs, sessions) are reported as warnings rather than failures.
Everything else is still a failure.

### 4. `reset` — wind a rehearsal back

Drops every non-extension table **and every non-extension enum type** in the target's `public`
schema. Three guards, all of which must pass:

1. The host must be `*.postgres.database.azure.com`.
2. The target must not be the host `secrets.DIRECT_DATABASE_URL` currently names — i.e. it
   refuses the moment production is served from it. This is the guard that survives the
   cutover; the first one does not, because after cutover production _is_ an Azure Flexible
   Server.
3. `confirm_reset` must be `<database>-<today's UTC date>`, e.g. `switchback-2026-07-30`. The
   old form was the database name alone, which is printed in `main.bicepparam`, in this file
   and in the workflow — a confirmation token written down in the repository is not a
   confirmation. This one has to be constructed at the moment of use and stops working at
   midnight UTC.

Extension-owned objects are skipped deliberately. `spatial_ref_sys` belongs to postgis and
cannot be dropped while the extension exists; a loop that tried would abort atomically and drop
_nothing_ — measured on a populated target, 24 tables before and 24 after. The enum types are
dropped because `pre-data` creates 16 of them and leaving them behind makes the _next_ migrate
fail 16 times with `type "ActivityType" already exists` before loading a row.

### A rehearsal

Do this days before the real run, not on the day:

```
preflight  →  migrate  →  read the verification table  →  reset
```

It measures the real dump and restore times, so the cutover window is a number rather than a
guess, and it surfaces every ordering problem while nothing is at stake. Then the real run is
the same `migrate` against a database that is empty again.

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

Preconditions: verification green, a rehearsal done, and a low-traffic hour. Avoid 04:17 UTC —
`apps/web/vercel.json` runs the ingest drain cron then.

1. **Record the moment.** Note `T0` in UTC. Anything written to Neon after this exists only
   there.

2. **Save the way back first — in the repository secrets, not in Vercel.** Copy the _current_
   Neon values into `NEON_DATABASE_URL` and `NEON_DIRECT_DATABASE_URL` as GitHub repository
   secrets, over stdin, the same way every other secret here is set:

   ```bash
   gh secret set NEON_DATABASE_URL        --repo mbahgatTech/switchback < "$TEMP/neon-pooled"
   gh secret set NEON_DIRECT_DATABASE_URL --repo mbahgatTech/switchback < "$TEMP/neon-direct"
   rm -f "$TEMP/neon-pooled" "$TEMP/neon-direct"
   ```

   Deliberately **not** as Vercel environment variables. An unused variable sitting in a
   production project is one more place a live credential can be read or exported, and the
   rollback gains nothing from it being there — rollback step 1 pastes the value into Vercel by
   hand at the moment it is needed, which is the same number of keystrokes. See the rule and
   its single named exception near the top of this file.

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

9. **Keep Neon schema-current while it is the rollback.** Add a second `db push` against the
   `NEON_DIRECT_DATABASE_URL` secret saved in step 2 to `ci.yml`'s `migrate` job. Without it,
   the first schema change shipped after cutover silently expires the rollback: the env var
   flips to Azure, Neon's schema freezes at the cutover commit, and a rollback three weeks
   later lands the app on a database missing a column. Remove the step when Neon is retired.

10. **Delete the migration secrets.** Once `DATABASE_URL` / `DIRECT_DATABASE_URL` point at
    Azure, the `AZURE_*` trio has done its job and should not outlive it:

    ```bash
    gh secret delete AZURE_DATABASE_URL        --repo mbahgatTech/switchback
    gh secret delete AZURE_DIRECT_DATABASE_URL --repo mbahgatTech/switchback
    gh secret delete AZURE_APP_DATABASE_URL    --repo mbahgatTech/switchback
    ```

    This is defence in depth rather than the primary control. `migrate-to-azure.yml` is
    `workflow_dispatch`-only and must live on the default branch to be dispatchable at all, so
    it stays visible in the Actions tab forever; its `reset` and `allow_overwrite` paths are
    already refused after cutover by `assert_target_is_not_live`, which compares the target
    against the host in `secrets.DIRECT_DATABASE_URL` and so flips from "permit" to "refuse" at
    the exact moment this step is taken. Deleting the secrets removes the input those paths
    read, so the guard and the absence of a credential fail in the same direction.

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
though it were a step someone could take: `migrate-to-azure.yml` has no mode that does it.
`migrate` refuses a non-empty target, `verify` only reads, `reset` only destroys, and no
`reconcile` script exists. Nor is one easy to add in the direction that matters most — the
workflow's standing guarantee is that it _never writes to Neon_ (every connection to it carries
`default_transaction_read_only=on`), and the rollback direction would have to break it.

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

1. Vercel → Production environment variables: set `DATABASE_URL` and `DIRECT_DATABASE_URL` back
   to the Neon values, read from the `NEON_DATABASE_URL` / `NEON_DIRECT_DATABASE_URL`
   repository secrets saved in step 2 of the cutover. They are in GitHub rather than pre-staged
   in Vercel on purpose — see the rule and its named exception near the top of this file.
2. Redeploy. Poll `/api/version`. Run the six smoke routes.
   **Time to restore service: about 3–5 minutes**, nearly all of it the redeploy.
3. Revert the repository secrets `DATABASE_URL` / `DIRECT_DATABASE_URL` to the Neon values.
4. Reconcile in reverse: rows written to Azure since cutover exist only there. As above, this
   is manual — no mode of `migrate-to-azure.yml` performs it, and the workflow cannot be the
   vehicle in this direction because it is built never to write to Neon. Leave Azure intact and
   replay by hand if the set turns out to matter.
5. **Leave Azure running and intact** until the cause is understood. Do not delete the evidence.

**Rollback expiry.** The rollback is clean only while both hold: no schema change has shipped
since cutover _unless_ step 9 of the cutover kept Neon in sync, and the Azure-only write set is
still small enough to replay. **Keep Neon for at least 30 days.** Neon suspends idle compute
automatically and retains the data, so a warm rollback costs nothing.

### Signals that the cutover went wrong

A 500 on its own tells you nothing. These do:

| Symptom                                                             | Cause                                                            |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `/api/version` fine, `/nearby` and `/trails/*` 500                  | Prisma cannot reach Azure — firewall, TLS, or wrong port         |
| `prepared statement "s0" already exists`                            | Pooled URL missing `pgbouncer=true` (General Purpose only)       |
| `SSL connection required`                                           | `sslmode=verify-full` missing from a URL                         |
| `function st_dwithin(geography, geography, numeric) does not exist` | PostGIS not created, or not on `search_path`                     |
| `/nearby` correct but slower than 3 s                               | `trails_geom_geography_gist` missing or unused — sequential scan |
| Search returns nothing for a trail you know exists                  | `trails_search_vector_gin` or `trails_name_trgm` missing         |
| Everyone signed out                                                 | `sessions` rows lost in the window. Expected, self-healing       |
| Every page 1–2 s slower                                             | Wrong region. Not fixable in place                               |
| Azure active connections pinned at the ceiling                      | Pool sizing — check `BACKGROUND_POOL_SIZE` against the tier      |

Watch for an hour after cutover: Vercel function error rate, Azure active connections and CPU,
and the p95 of `/nearby`. If any of the first four appear and are not fixable in five minutes,
**roll back first and diagnose afterwards** — Neon is warm and the cost of rolling back is one
redeploy.

---

## Known follow-ups, deliberately not done here

Three small changes belong to the application rather than to the infrastructure, and are left
for a separate reviewable commit:

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
