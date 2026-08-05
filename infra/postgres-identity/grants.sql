-- What the Entra-mapped roles may do, against the `switchback` database.
--
-- **The specification is `sbapp` itself, by membership rather than by copy.** Every grant the
-- application role holds — CONNECT, USAGE on public, and INSERT/SELECT/UPDATE/DELETE on the
-- tables, including whatever `ALTER DEFAULT PRIVILEGES` hands the next table `prisma db push`
-- creates — is inherited. A second list of GRANTs would be a second thing to keep in step, and
-- the failure mode of it drifting is a web request that cannot read a new column.
--
-- `sbapp` keeps its password until every consumer is moved. After that it stops being a login
-- and becomes only what it already is here: the name of a privilege set.

\set ON_ERROR_STOP on

GRANT sbapp TO sbapp_func;
GRANT sbapp TO sbapp_vercel;

-- Neither may do anything else. `pgaadauth_create_principal_with_oid(..., isAdmin => false)`
-- already creates them without CREATEDB or CREATEROLE and outside `azure_pg_admin`; this
-- states it as an assertion so a role that acquired one later fails this file rather than
-- passing silently.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO offender
    FROM pg_roles
   WHERE rolname IN ('sbapp_func', 'sbapp_vercel')
     AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication);
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'application roles carry attributes they should not: %', offender;
  END IF;

  SELECT string_agg(r.rolname, ', ') INTO offender
    FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.member
    JOIN pg_roles g ON g.oid = m.roleid
   WHERE r.rolname IN ('sbapp_func', 'sbapp_vercel')
     AND g.rolname <> 'sbapp';
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'application roles are members of something other than sbapp: %', offender;
  END IF;
END
$$;
