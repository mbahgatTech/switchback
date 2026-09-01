#!/usr/bin/env bash
# Slice a Geofabrik extract down to what the ingest queries select, load it into PostGIS, and
# report what it costs on disk. Reads nothing from the network; writes only its own database.
set -euo pipefail

PBF=${1:?usage: measure-extract.sh <extract.pbf> <dbname>}
DB=${2:?usage: measure-extract.sh <extract.pbf> <dbname>}

WORK=$(cd "$(dirname "$PBF")" && pwd)
BASE=$(basename "$PBF")
STYLE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

OSMIUM_IMAGE=${OSMIUM_IMAGE:-sb-osmium:1}
OSM2PGSQL_IMAGE=${OSM2PGSQL_IMAGE:-sb-osm2pgsql:1}
PGHOST_IN_CONTAINER=${PGHOST_IN_CONTAINER:-host.docker.internal}
PGPORT=${PGPORT:-5433}
PGUSER=${PGUSER:-switchback}
PGPASSWORD=${PGPASSWORD:-switchback}
export MSYS_NO_PATHCONV=1

osmium() { docker run --rm -v "$WORK:/data" "$OSMIUM_IMAGE" osmium "$@"; }
psql_db() { docker exec -e PGPASSWORD="$PGPASSWORD" switchback-db psql -U "$PGUSER" -d "$1" -v ON_ERROR_STOP=1 -qtAc "$2"; }

# `tags-filter` without `-R`: referenced ways and nodes are what carries the geometry, and
# dropping them yields relations with nothing to assemble and ways with no coordinates.
echo "== filtering trail slice =="
time osmium tags-filter --overwrite -o "/data/${BASE%.osm.pbf}.trail.pbf" "/data/$BASE" \
  'r/route=hiking,foot,walking,running' \
  'w/highway=path,footway,track,bridleway,steps,cycleway'

echo "== filtering network slice =="
time osmium tags-filter --overwrite -o "/data/${BASE%.osm.pbf}.network.pbf" "/data/$BASE" \
  'w/highway=path,footway,track,bridleway,steps,cycleway,pedestrian,living_street,residential,unclassified,tertiary,service,road'

echo "== creating $DB =="
psql_db postgres "DROP DATABASE IF EXISTS $DB" >/dev/null
psql_db postgres "CREATE DATABASE $DB" >/dev/null
psql_db "$DB" "CREATE EXTENSION IF NOT EXISTS postgis" >/dev/null
psql_db "$DB" "CREATE SCHEMA IF NOT EXISTS osm" >/dev/null

load() {
  local slice=$1 pbf=$2
  echo "== loading $slice slice =="
  # `--slim --drop` builds relation geometries from a node cache and then discards the middle
  # tables, so the measured size is the read-only slice and not the import scaffolding.
  time docker run --rm -v "$WORK:/data" -v "$STYLE_DIR:/style" \
    -e PGPASSWORD="$PGPASSWORD" -e SB_SLICE="$slice" \
    "$OSM2PGSQL_IMAGE" osm2pgsql \
    --output=flex --style=/style/switchback.lua \
    --slim --drop --cache=2000 \
    --host="$PGHOST_IN_CONTAINER" --port="$PGPORT" --user="$PGUSER" --database="$DB" \
    "/data/$pbf"
}

load trail "${BASE%.osm.pbf}.trail.pbf"
load network "${BASE%.osm.pbf}.network.pbf"

echo "== indexing =="
psql_db "$DB" "CREATE INDEX ON osm.trail_way USING gist (geom)"
psql_db "$DB" "CREATE INDEX ON osm.trail_relation USING gist (geom)"
psql_db "$DB" "CREATE INDEX ON osm.network_way USING gist (geom)"
psql_db "$DB" "CREATE INDEX ON osm.trail_way (way_id)"
psql_db "$DB" "CREATE INDEX ON osm.trail_way ((tags->>'highway')) WHERE tags ? 'name'"
psql_db "$DB" "VACUUM ANALYZE"

echo "== size =="
psql_db "$DB" "SELECT relname || ' ' || pg_total_relation_size(oid) FROM pg_class WHERE relnamespace = 'osm'::regnamespace AND relkind = 'r' ORDER BY relname"
