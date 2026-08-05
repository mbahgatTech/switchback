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
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_func') THEN
    PERFORM pg_catalog.pgaadauth_create_principal_with_oid(
      'sbapp_func', :'func_oid', 'service', false, false);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_vercel') THEN
    PERFORM pg_catalog.pgaadauth_create_principal_with_oid(
      'sbapp_vercel', :'vercel_oid', 'service', false, false);
  END IF;
END
$$;
