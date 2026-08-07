-- Retire the roles the single-identity consolidation leaves behind.
--
-- Separate from roles.sql and run by its own workflow action, because this is the one destructive
-- step in the set. `sbapp_func` is the ingest worker's only credential-free door until the worker
-- runs as the shared identity; dropping it early converts a rollback into an outage.
--
-- Run against `switchback`, not `postgres`: DROP ROLE reports ownership dependencies only for the
-- current database, and the objects are here.

\set ON_ERROR_STOP on

-- The precondition is "every consumer has been moved", and the database cannot see it.
--
-- A `pg_stat_activity` sample cannot stand in for it. The ingest worker runs on a Consumption
-- plan: it connects during an invocation and drops out between them, so for most of any minute
-- no backend exists under its role however healthy it is. A guard keyed on that would pass
-- exactly when it matters and drop the role the worker reconnects with two minutes later.
--
-- The Function App's own configuration is the fact that settles it, and it is out of reach from
-- here: `id-switchback-postgres-ci` holds zero Azure RBAC by design, so this job cannot read app
-- settings, and adding Reader to make an automated check possible would widen the blast radius of
-- the one identity kept deliberately narrow. So the assertion is made by the operator, in the
-- dispatch, and recorded in the run — a deliberate claim rather than a check that cannot fail.
--
-- Through `set_config` because psql does not interpolate `:'var'` inside a dollar-quoted body: it
-- hands the block to the server verbatim and the server reports `syntax error at or near ":"`.
SELECT set_config('switchback.consumers_moved', :'consumers_moved', false);

DO $$
DECLARE
  busy text;
BEGIN
  IF current_setting('switchback.consumers_moved', true) IS DISTINCT FROM 'MOVED' THEN
    RAISE EXCEPTION 'consumers_moved was not asserted; confirm every consumer runs as the shared identity, then dispatch retire with consumers_moved=MOVED';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_runtime') THEN
    RAISE EXCEPTION 'sbapp_runtime does not exist; run the provision action first';
  END IF;

  -- Not the safety property above, and not treated as one: a backend connected right now is
  -- proof the claim is wrong, while its absence proves nothing. Cheap, and it catches the case
  -- where someone asserts the move with the old consumer still visibly running.
  SELECT string_agg(DISTINCT usename, ', ') INTO busy
    FROM pg_stat_activity
   WHERE usename IN ('sbapp_func', 'sbapp_vercel');
  IF busy IS NOT NULL THEN
    RAISE EXCEPTION 'still serving connections as %; the move was asserted but has not happened', busy;
  END IF;

  SELECT string_agg(DISTINCT c.relname, ', ') INTO busy
    FROM pg_class c
    JOIN pg_roles r ON r.oid = c.relowner
   WHERE r.rolname IN ('sbapp_func', 'sbapp_vercel', 'sb-token-expiry-probe');
  IF busy IS NOT NULL THEN
    RAISE EXCEPTION 'legacy roles own objects and cannot be dropped: %', busy;
  END IF;
END
$$;

-- `sbapp_func` is the worker's old role and `sbapp_vercel` the web application's, both superseded
-- by `sbapp_runtime`. `sbapp_vercel` is normally already gone — roles.sql renames it — so this
-- covers the case where a role was created under the old name after the rename.
DROP ROLE IF EXISTS sbapp_func;
DROP ROLE IF EXISTS sbapp_vercel;

-- Debris rather than a consumer: a LOGIN role left by the token-expiry soak, whose Entra
-- principal was deleted with the experiment. Nothing can authenticate as it. Dropped here
-- because no other job would, and idempotent because the soak's own teardown may have won.
DROP ROLE IF EXISTS "sb-token-expiry-probe";

SELECT 'remaining|' || rolname || '|login=' || rolcanlogin::text
  FROM pg_roles
 WHERE rolname NOT LIKE 'pg\_%'
 ORDER BY rolname;
