-- The Entra-mapped login role, and what it may do.
--
-- Idempotent: safe to run on every deployment. `pgaadauth_create_principal_with_oid` is not, so
-- the call is guarded by the role's absence.
--
-- Run against the `postgres` database, not `switchback` — the pgaadauth functions live there and
-- a call from anywhere else fails with "No function matches". The GRANTs that follow do have to
-- run against `switchback`, which is why this file comes in two halves and the workflow runs each
-- against its own database.
--
-- One role, because Vercel production, Vercel preview and the ingest worker are one managed
-- identity. Postgres sees one principal and cannot tell them apart; `application_name` is what
-- distinguishes them in `pg_stat_activity` and in the connection log, and it is attribution
-- rather than a boundary — any client can set it to anything.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------------------
-- Half one: the role. Against `postgres`.
-- ---------------------------------------------------------------------------------------

-- Rename rather than recreate, where the old name is what exists. The Entra mapping is a shared
-- security label keyed on the role's oid, and `ALTER ROLE ... RENAME` does not change the oid, so
-- the mapping follows the name. Recreating is not an alternative:
-- `pgaadauth_create_principal_with_oid` refuses a second role on an object id already mapped.
--
-- A rename drops no session and invalidates no privilege — existing backends hold the oid — so
-- this is safe to run while the application is serving. The assertion below is what turns that
-- from a claim into a check.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_vercel')
     AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_runtime') THEN
    ALTER ROLE sbapp_vercel RENAME TO sbapp_runtime;
    RAISE NOTICE 'renamed sbapp_vercel to sbapp_runtime';
  END IF;
END
$$;

-- By object id rather than by name. The name form looks up the display name in the tenant, which
-- couples the PostgreSQL role name to a mutable Entra label and fails outright for a principal
-- whose display name is not unique. The object id is immutable and is what Azure matches the
-- token against anyway.
--
-- `SELECT ... WHERE NOT EXISTS` rather than the obvious `DO $$ IF NOT EXISTS ... $$`, because
-- psql does not interpolate `:'var'` inside a dollar-quoted body — it hands the block to the
-- server verbatim and the server reports `syntax error at or near ":"`. The function sits in the
-- target list, so it is evaluated only when the guard produces a row.
SELECT pg_catalog.pgaadauth_create_principal_with_oid('sbapp_runtime', :'runtime_oid', 'service', false, false)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_runtime');

-- Whatever the two branches above did, the role must now exist and be mapped to the object id
-- this run was given — not merely exist. Creation is guarded on the role's *name*, so an identity
-- that has been recreated since keeps a role that matches nothing, and a count would still say
-- one. That failure otherwise surfaces at first use, which is a web request.
--
-- This is also the gate on the rename. If `ALTER ROLE ... RENAME` had not carried the security
-- label across, `sbapp_runtime` would exist with no mapping and this raises. The rollback is the
-- inverse rename, and nothing has been dropped.
--
-- The oid travels through `set_config` because psql does not interpolate `:'var'` inside a
-- dollar-quoted body.
SELECT set_config('switchback.runtime_oid', :'runtime_oid', false);

-- The whole row is printed as JSON rather than picking columns out of it: the documented result
-- column is `rolename` and the server's is `rolname`, so naming them is a way to fail on a typo
-- instead of on the fact being checked.
SELECT 'principal|' || row_to_json(p)::text
  FROM pg_catalog.pgaadauth_list_principals(false) p
 WHERE p.rolname = 'sbapp_runtime';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pgaadauth_list_principals(false) p
     WHERE p.rolname = 'sbapp_runtime'
       AND lower(p.objectid::text) = lower(current_setting('switchback.runtime_oid'))
  ) THEN
    RAISE EXCEPTION 'sbapp_runtime is missing, or is mapped to a different Entra object id than %',
      current_setting('switchback.runtime_oid');
  END IF;
END
$$;
