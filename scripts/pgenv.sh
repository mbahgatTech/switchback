#!/usr/bin/env bash
# Read-only production Postgres session via Entra token. Never prints the token.
set -euo pipefail

export PGHOST=psql-switchback-prod-37ywppu5p7fri.postgres.database.azure.com
export PGDATABASE=switchback
export PGSSLMODE=verify-full
PGUSER="$(az ad signed-in-user show --query userPrincipalName -o tsv)"
export PGUSER
PGSSLROOTCERT="$(cygpath -w /usr/ssl/certs/ca-bundle.crt)"
export PGSSLROOTCERT
PGPASSWORD="$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)"
export PGPASSWORD

PSQL="/c/Program Files/PostgreSQL/16/bin/psql.exe"
exec "$PSQL" -v ON_ERROR_STOP=1 "$@"
