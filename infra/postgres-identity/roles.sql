-- The Entra-mapped login roles, and what they may do.
--
-- Idempotent: safe to run on every deployment. `pgaadauth_create_principal_with_oid` is not, so
-- each call is guarded by its role's absence.
--
-- Run against the `postgres` database, not `switchback` — the pgaadauth functions live there and
-- a call from anywhere else fails with "No function matches". The GRANTs that follow do have to
-- run against `switchback`, which is why this file comes in two halves and the workflow runs each
-- against its own database.
--
-- Two roles, because there are two principals. `sbapp_vercel` is the shared runtime identity
-- `id-switchback-vercel-publisher`, which Vercel production and preview both federate to;
-- `sbapp_func` is the ingest worker's own system-assigned principal. Consolidating the worker
-- onto the shared identity was considered and rejected: the worker's Service Bus trigger receives
-- as whatever principal the site runs under, so it would need Data Receiver on `ingest-jobs` back
-- on an identity every Vercel preview carries.
--
-- Postgres cannot tell Vercel production from preview — one identity, one object id, one role.
-- `application_name` distinguishes them in `pg_stat_activity` and in the connection log, and it is
-- attribution rather than a boundary: any client can set it to anything.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------------------
-- Half one: the roles. Against `postgres`.
-- ---------------------------------------------------------------------------------------

-- By object id rather than by name. The name form looks up the display name in the tenant, which
-- couples the PostgreSQL role name to a mutable Entra label and fails outright for a principal
-- whose display name is not unique. The object id is immutable and is what Azure matches the
-- token against anyway.
--
-- `SELECT ... WHERE NOT EXISTS` rather than the obvious `DO $$ IF NOT EXISTS ... $$`, because
-- psql does not interpolate `:'var'` inside a dollar-quoted body — it hands the block to the
-- server verbatim and the server reports `syntax error at or near ":"`. The function sits in the
-- target list, so it is evaluated only when the guard produces a row.
SELECT pg_catalog.pgaadauth_create_principal_with_oid('sbapp_vercel', :'runtime_oid', 'service', false, false)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_vercel');

SELECT pg_catalog.pgaadauth_create_principal_with_oid('sbapp_func', :'worker_oid', 'service', false, false)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_func');

-- Each role must now exist **and be mapped to the object id this run was given** — not merely
-- exist. Creation is guarded on the role's *name*, so an identity that has been recreated since
-- keeps a role that matches nothing, and a count would still say two. That failure otherwise
-- surfaces at first use, which is a web request.
--
-- The oids travel through `set_config` because psql does not interpolate `:'var'` inside a
-- dollar-quoted body.
SELECT set_config('switchback.runtime_oid', :'runtime_oid', false);
SELECT set_config('switchback.worker_oid', :'worker_oid', false);

-- The whole row is printed as JSON rather than picking columns out of it: the documented result
-- column is `rolename` and the server's is `rolname`, so naming them is a way to fail on a typo
-- instead of on the fact being checked.
SELECT 'principal|' || row_to_json(p)::text
  FROM pg_catalog.pgaadauth_list_principals(false) p
 WHERE p.rolname IN ('sbapp_vercel', 'sbapp_func')
 ORDER BY 1;

DO $$
DECLARE
  expected CONSTANT text[][] := ARRAY[
    ARRAY['sbapp_vercel', current_setting('switchback.runtime_oid')],
    ARRAY['sbapp_func', current_setting('switchback.worker_oid')]
  ];
  role text;
  oid_ text;
BEGIN
  FOR i IN 1 .. array_length(expected, 1) LOOP
    role := expected[i][1];
    oid_ := expected[i][2];
    IF NOT EXISTS (
      SELECT 1 FROM pg_catalog.pgaadauth_list_principals(false) p
       WHERE p.rolname = role AND lower(p.objectid::text) = lower(oid_)
    ) THEN
      RAISE EXCEPTION '% is missing, or is mapped to a different Entra object id than %', role, oid_;
    END IF;
  END LOOP;
END
$$;
