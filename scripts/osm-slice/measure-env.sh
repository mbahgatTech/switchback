#!/usr/bin/env bash
# The measurement database and a usable Overpass identity, for the kill-gate scripts only.
# Never reads the repository `.env`: that file points at production, and `processTile` writes.
set -euo pipefail
export DATABASE_URL="postgresql://switchback:switchback@localhost:5433/switchback_p4"
export DIRECT_DATABASE_URL="$DATABASE_URL"
export OVERPASS_USER_AGENT="Switchback/0.1 (+https://switchback-three.vercel.app/attribution)"
cd "$(dirname "$0")/../.."
exec "$@"
