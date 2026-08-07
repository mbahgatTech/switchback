#!/usr/bin/env bash
# Local-only test database. Never reads .env, never resolves a hostname off this machine.
set -euo pipefail
export DATABASE_URL="postgresql://switchback:switchback@localhost:5433/switchback"
export DIRECT_DATABASE_URL="$DATABASE_URL"
cd "$(dirname "$0")/.."
exec "$@"
