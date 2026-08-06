-- Retire the roles the single-identity consolidation leaves behind.
--
-- Separate from roles.sql and run by its own workflow action, because this is the one destructive
-- step in the set. `sbapp_func` is the ingest worker's only credential-free door until the worker
-- runs as the shared identity; dropping it early converts a rollback into an outage.
--
-- Run against `switchback`, not `postgres`: DROP ROLE reports ownership dependencies only for the
-- current database, and the objects are here.

\set ON_ERROR_STOP on

-- Three guards, and each names a way this is being run too early.
DO $$
DECLARE
  busy text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sbapp_runtime') THEN
    RAISE EXCEPTION 'sbapp_runtime does not exist; run the provision action first';
  END IF;

  -- A live backend authenticated as sbapp_func is the ingest worker still using it. Dropping the
  -- role would not close the session, but the next connection it opens would be refused, which is
  -- an outage discovered by a timer rather than by this job.
  SELECT string_agg(DISTINCT usename, ', ') INTO busy
    FROM pg_stat_activity
   WHERE usename IN ('sbapp_func', 'sbapp_vercel');
  IF busy IS NOT NULL THEN
    RAISE EXCEPTION 'still serving connections as %; move the consumer before retiring it', busy;
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

-- Debris, not a consumer: a LOGIN role mapped to an Entra principal that no longer exists, left
-- by a token-expiry soak whose teardown did not run. `az ad sp show --id
-- fc638485-a9ec-48ed-8d98-5027e1157218` reports the principal as absent, so nothing can
-- authenticate as this and nothing will notice it going.
DROP ROLE IF EXISTS "sb-token-expiry-probe";

SELECT 'remaining|' || rolname || '|login=' || rolcanlogin::text
  FROM pg_roles
 WHERE rolname NOT LIKE 'pg\_%'
 ORDER BY rolname;
