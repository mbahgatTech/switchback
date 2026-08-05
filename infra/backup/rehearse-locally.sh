#!/usr/bin/env bash
#
# The test for census.sql. Builds a small database with the shapes production has, dumps it,
# restores it into a second database, and asserts the two censuses are byte-identical.
#
#   ./infra/backup/rehearse-locally.sh
#
# Everything runs inside one throwaway Docker container, so no PostgreSQL client is needed on
# the host and nothing touches production. Exit code 0 means the census, the \gexec generation
# it depends on, and the restore recipe in .github/workflows/backup-production-db.yml all
# still agree.
#
# The one thing this does not exercise is the exported transaction snapshot the workflow uses
# to make the census describe exactly the rows the archive holds. Nothing writes to the
# database here, so there is nothing for a snapshot to protect against; that half is only
# meaningful, and only proven, against a live production.
set -euo pipefail

CONTAINER=switchback-backup-rehearsal
IMAGE=postgis/postgis:17-3.5

# Relative paths from the repository root, not absolute ones. `docker cp` on Windows resolves
# an MSYS-style /c/… host path against the current drive and fails on a directory that does
# not exist; a relative path is handled identically on every platform.
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

cleanup
docker run -d --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
until docker exec "$CONTAINER" pg_isready -U postgres -d postgres >/dev/null 2>&1; do sleep 2; done

docker cp infra/backup/census.sql "$CONTAINER:/census.sql"
docker cp infra/backup/rehearsal-fixture.sql "$CONTAINER:/fixture.sql"

# MSYS_NO_PATHCONV is set per call rather than exported: on Git Bash it stops /census.sql
# being rewritten to C:/Program Files/Git/census.sql inside the container's argv, but
# exporting it would also stop the `docker cp` above resolving its host paths.
run() { MSYS_NO_PATHCONV=1 docker exec -i "$CONTAINER" "$@"; }

# `sbadmin` and `sbapp` mirror production's two roles, and the source database is owned by
# sbadmin so that the ownership lines in the census are the ones a real restore has to
# reproduce rather than an artefact of running everything as the superuser.
run psql -U postgres -X -q -v ON_ERROR_STOP=1 \
  -c 'CREATE ROLE sbadmin LOGIN SUPERUSER' \
  -c 'CREATE ROLE sbapp LOGIN' \
  -c "CREATE DATABASE census_source OWNER sbadmin TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'"
run psql -U sbadmin -d census_source -X -q -v ON_ERROR_STOP=1 -f /fixture.sql

run bash -c "psql -U sbadmin -d census_source -X -tAq -v ON_ERROR_STOP=1 \
  -c 'BEGIN' -f /census.sql -c 'COMMIT' > /source.txt"

run pg_dump -U sbadmin -d census_source --format=custom --compress=9 --file=/source.dump
run pg_dump -U sbadmin -d census_source --format=plain --schema-only --file=/schema.sql

run psql -U postgres -X -q -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE census_restored OWNER sbadmin TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C.UTF-8' LC_CTYPE 'C.UTF-8'"
run psql -U sbadmin -d census_restored -X -q -v ON_ERROR_STOP=1 \
  -c "ALTER DATABASE census_restored SET default_text_search_config = 'pg_catalog.simple'"
run pg_restore -U sbadmin -d census_restored --exit-on-error /source.dump

run bash -c "psql -U sbadmin -d census_restored -X -tAq -v ON_ERROR_STOP=1 \
  -c 'BEGIN' -f /census.sql -c 'COMMIT' > /restored.txt"

echo
run grep -E '^(rows|geo|srs|db)\|' /restored.txt

echo
if run diff -u /source.txt /restored.txt; then
  echo "PASS — $(run bash -c 'wc -l < /source.txt' | tr -d '[:space:]') census lines identical after a full dump and restore."
else
  echo 'FAIL — the restored copy does not match the source.'
  exit 1
fi
