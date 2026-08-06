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

-- Whatever the branch above did, these two must now exist and be mapped to the object ids
-- this run was given — not merely exist. Creation is guarded on the role's *name*, so a
-- Function App or user-assigned identity that has been recreated since keeps a role that
-- matches nothing, and a count would still say two. That failure surfaces at first use.
--
-- The oids travel through `set_config` because psql does not interpolate `:'var'` inside a
-- dollar-quoted body — it hands the block to the server verbatim and the server reports
-- `syntax error at or near ":"`.
SELECT set_config('switchback.func_oid', :'func_oid', false),
       set_config('switchback.vercel_oid', :'vercel_oid', false);

-- The whole row is printed as JSON rather than picking columns out of it: the documented
-- result column is `rolename` and the server's is `rolname`, so naming them is a way to fail
-- on a typo instead of on the fact being checked.
SELECT 'principal|' || row_to_json(p)::text
  FROM pg_catalog.pgaadauth_list_principals(false) p
 WHERE p.rolname IN ('sbapp_func', 'sbapp_vercel')
 ORDER BY 1;

DO $$
DECLARE
  wrong text;
BEGIN
  SELECT string_agg(expected.rolname, ', ') INTO wrong
    FROM (VALUES ('sbapp_func', current_setting('switchback.func_oid')),
                 ('sbapp_vercel', current_setting('switchback.vercel_oid'))) AS expected(rolname, objectid)
    LEFT JOIN pg_catalog.pgaadauth_list_principals(false) p
      ON p.rolname = expected.rolname
     AND lower(p.objectid::text) = lower(expected.objectid)
   WHERE p.rolname IS NULL;
  IF wrong IS NOT NULL THEN
    RAISE EXCEPTION 'missing, or mapped to a different Entra object id: %', wrong;
  END IF;
END
$$;
