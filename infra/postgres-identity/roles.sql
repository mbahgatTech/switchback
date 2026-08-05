-- The Entra-mapped login roles, and what they may do.
--
-- Idempotent: safe to run on every deployment. `pgaadauth_create_principal_with_oid` is not,
-- so each call is guarded by the role's absence.
--
-- Run against the `postgres` database, not `switchback` — the pgaadauth functions live there
-- and a call from anywhere else fails with "No function matches". The GRANTs that follow do
-- have to run against `switchback`, which is why this file comes in two halves and the
-- workflow runs each against its own database.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------------------
-- Half one: the roles. Against `postgres`.
-- ---------------------------------------------------------------------------------------

-- By object id rather than by name. The name form looks up the display name in the tenant,
-- which couples the PostgreSQL role name to a mutable Entra label and fails outright for a
-- principal whose display name is not unique. The object id is immutable and is what Azure
-- matches the token against anyway.
--
-- `SELECT ... WHERE NOT EXISTS` rather than the obvious `DO $$ IF NOT EXISTS ... $$`, because
-- psql does not interpolate `:'var'` inside a dollar-quoted body — it hands the block to the
-- server verbatim and the server reports `syntax error at or near ":"`. The function sits in
-- the target list, so it is evaluated only when the guard produces a row.
SELECT pg_catalog.pgaadauth_create_principal_with_oid('sbapp_func', :'func_oid', 'service', false, false)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_func');

SELECT pg_catalog.pgaadauth_create_principal_with_oid('sbapp_vercel', :'vercel_oid', 'service', false, false)
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_vercel');

-- Whatever the branch above did, these two must now exist and be Entra-mapped. The whole row
-- is printed as JSON rather than picking columns out of it: the documented result column is
-- `rolename` and the server's is `rolname`, so naming them is a way to fail on a typo instead
-- of on the fact being checked.
SELECT 'principal|' || row_to_json(p)::text
  FROM pg_catalog.pgaadauth_list_principals(false) p
 WHERE p.rolname IN ('sbapp_func', 'sbapp_vercel')
 ORDER BY 1;

DO $$
DECLARE
  found int;
BEGIN
  SELECT count(*) INTO found
    FROM pg_catalog.pgaadauth_list_principals(false) p
   WHERE p.rolname IN ('sbapp_func', 'sbapp_vercel');
  IF found <> 2 THEN
    RAISE EXCEPTION 'expected two Entra-mapped application roles, found %', found;
  END IF;
END
$$;
