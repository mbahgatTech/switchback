-- What the Entra-mapped role may do, against the `switchback` database.
--
-- **The specification is `sbapp` itself, by membership rather than by copy.** Every grant the
-- application role holds — CONNECT, USAGE on public, and INSERT/SELECT/UPDATE/DELETE on the
-- tables, including whatever `ALTER DEFAULT PRIVILEGES` hands the next table `prisma db push`
-- creates — is inherited. A second list of GRANTs would be a second thing to keep in step, and
-- the failure mode of it drifting is a web request that cannot read a new column.
--
-- `sbapp` keeps its password hash after `passwordAuth` is Disabled, and deliberately. The server
-- refuses password authentication outright at that point, so the hash is inert rather than a live
-- credential — and keeping it means re-enabling passwords is one ARM property flip rather than a
-- flip plus a credential reset needing an administrator who may be the reason you are there.

\set ON_ERROR_STOP on

GRANT sbapp TO sbapp_runtime;

-- It may do nothing else. `pgaadauth_create_principal_with_oid(..., isAdmin => false)` already
-- creates the role without CREATEDB or CREATEROLE and outside `azure_pg_admin`; this states it as
-- an assertion so a role that acquired one later fails this file rather than passing silently.
DO $$
DECLARE
  offender text;
BEGIN
  SELECT string_agg(rolname, ', ') INTO offender
    FROM pg_roles
   WHERE rolname = 'sbapp_runtime'
     AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls OR rolreplication);
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'the runtime role carries attributes it should not: %', offender;
  END IF;

  SELECT string_agg(g.rolname, ', ') INTO offender
    FROM pg_auth_members m
    JOIN pg_roles r ON r.oid = m.member
    JOIN pg_roles g ON g.oid = m.roleid
   WHERE r.rolname = 'sbapp_runtime'
     AND g.rolname <> 'sbapp';
  IF offender IS NOT NULL THEN
    RAISE EXCEPTION 'the runtime role is a member of something other than sbapp: %', offender;
  END IF;
END
$$;
