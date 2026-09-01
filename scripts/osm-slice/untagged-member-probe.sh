#!/usr/bin/env bash
# Loads untagged-member-probe.osm through switchback.lua and checks that a relation's dropped way
# member is either kept or reported. Writes only its own throwaway database, and drops it after.
set -euo pipefail

# The invariant below is a REGRESSION TEST, not a claim that the loader is broken. Branch B is what
# holds today: osm2pgsql never calls the style's way callback for an untagged way, so way 100 is
# gone before switchback.lua can decide anything, and only the completeness predicate can see it.
# A future loader that keeps untagged relation members satisfies branch A instead, and the check
# stays green without being edited. What it forbids is the third state — the way silently absent
# AND the predicate blind to it — which is the permanent data loss the gate exists to prevent.

# Unique per run: the container is shared, and a fixed name means a second probe drops the
# database this one is loading into. `$$` is this shell's pid; the trap below drops it either way.
DB=${PROBE_DB:-osm_untagged_member_probe_$$}
STYLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$STYLE_DIR/../.." && pwd)

OSM2PGSQL_IMAGE=${OSM2PGSQL_IMAGE:-sb-osm2pgsql:1}
PGHOST_IN_CONTAINER=${PGHOST_IN_CONTAINER:-host.docker.internal}
PGPORT=${PGPORT:-5433}
PGUSER=${PGUSER:-switchback}
PGPASSWORD=${PGPASSWORD:-switchback}
PGCONTAINER=${PGCONTAINER:-switchback-db}
export MSYS_NO_PATHCONV=1

# The fixture's own <bounds>, which sit well outside every element in it — the gap this reproduces
# has to be interior, so no part of the probe may straddle an edge.
BBOX=-122.1010,37.3990,-122.0960,37.4010
RELATION=900
WAY=100

psql_db() {
  docker exec -e PGPASSWORD="$PGPASSWORD" "$PGCONTAINER" \
    psql -U "$PGUSER" -d "$1" -v ON_ERROR_STOP=1 -qtAc "$2"
}

cleanup() {
  psql_db postgres "DROP DATABASE IF EXISTS $DB" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== osm2pgsql version =="
# `sed -n 1p` rather than `head -1`: head closes the pipe on the first line, and under `pipefail`
# the SIGPIPE that gives the writer fails the whole script.
docker run --rm "$OSM2PGSQL_IMAGE" osm2pgsql --version 2>&1 | sed -n '1p'

echo "== creating $DB =="
psql_db postgres "CREATE DATABASE $DB" >/dev/null
psql_db "$DB" "CREATE EXTENSION IF NOT EXISTS postgis" >/dev/null
psql_db "$DB" "CREATE SCHEMA IF NOT EXISTS osm" >/dev/null

echo "== loading fixture through switchback.lua =="
docker run --rm -v "$STYLE_DIR:/data" -v "$STYLE_DIR:/style" \
  -e PGPASSWORD="$PGPASSWORD" -e SB_SLICE=trail \
  "$OSM2PGSQL_IMAGE" osm2pgsql \
  --output=flex --style=/style/switchback.lua \
  --slim --drop --cache=64 \
  --host="$PGHOST_IN_CONTAINER" --port="$PGPORT" --user="$PGUSER" --database="$DB" \
  /data/untagged-member-probe.osm >/dev/null 2>&1

relation_rows=$(psql_db "$DB" "SELECT count(*) FROM osm.trail_relation WHERE relation_id = $RELATION")
if [ "$relation_rows" != "1" ]; then
  echo "FAIL: relation $RELATION did not load, so neither branch can be evaluated" >&2
  exit 1
fi

way_rows=$(psql_db "$DB" "SELECT count(*) FROM osm.trail_way WHERE way_id = $WAY")
if [ "$way_rows" = "1" ]; then
  echo "PASS: branch A held — way $WAY is present in osm.trail_way"
  exit 0
fi

echo "== way $WAY absent; asking the completeness predicate =="
report=$(cd "$REPO_ROOT" && npx tsx scripts/osm-slice/tile-completeness.ts \
  --database "$DB" --bbox "$BBOX" --json)

# The report is piped in rather than passed as a path: `mktemp` yields a POSIX path that the
# native Windows node binary resolves to a `C:\tmp\...` that does not exist. Node prints a verdict
# and exits 0 either way, so a crash here stays distinguishable from an honest "complete".
verdict=$(printf '%s' "$report" | node -e '
  const report = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const hit = report.incomplete.find((r) => r.relationId === Number(process.argv[1]));
  const missing = hit ? hit.missingMembers.map((m) => `${m.ref}@${m.ordinal}`).join(" ") : "";
  console.log(
    hit
      ? `INCOMPLETE ${hit.declared} declared / ${hit.resolved} resolved, missing ${missing}`
      : "COMPLETE",
  );
' "$RELATION") || {
  echo "FAIL: the predicate output could not be read" >&2
  printf '%s\n' "$report" >&2
  exit 1
}

if [ "${verdict#INCOMPLETE}" != "$verdict" ]; then
  echo "PASS: branch B held — way $WAY is absent from osm.trail_way and the predicate reports"
  echo "      relation $RELATION incomplete: ${verdict#INCOMPLETE }"
  exit 0
fi

echo "FAIL: way $WAY is absent from osm.trail_way and the predicate did not report relation" >&2
echo "      $RELATION incomplete. That is the silent-thinness state the gate exists to prevent." >&2
printf '%s\n' "$report" >&2
exit 1
