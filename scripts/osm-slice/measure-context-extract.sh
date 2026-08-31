#!/usr/bin/env bash
# Slice the feature and admin classes the tile context queries read into an existing slice
# database, and report what they cost on disk. Reads nothing from the network.
set -euo pipefail

PBF=${1:?usage: measure-context-extract.sh <extract.pbf> <dbname>}
DB=${2:?usage: measure-context-extract.sh <extract.pbf> <dbname>}

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

CONTEXT_PBF="${BASE%.osm.pbf}.context.pbf"

osmium() { docker run --rm -v "$WORK:/data" "$OSMIUM_IMAGE" osmium "$@"; }
psql_db() { docker exec -e PGPASSWORD="$PGPASSWORD" switchback-db psql -U "$PGUSER" -d "$1" -v ON_ERROR_STOP=1 -qtAc "$2"; }

# Referenced objects are kept (no `-R`): an admin relation without its member ways is a boundary
# with no ring, and a parking way without its nodes has no envelope to take a centre from.
# `SKIP_FILTER=1` reuses an existing context pbf, so a reload can be re-measured without
# re-reading the whole extract.
if [ "${SKIP_FILTER:-0}" = "1" ] && [ -f "$WORK/$CONTEXT_PBF" ]; then
  echo "== reusing $CONTEXT_PBF =="
else
echo "== filtering context slice =="
time osmium tags-filter --overwrite -o "/data/$CONTEXT_PBF" "/data/$BASE" \
  'n/natural=peak,hill,saddle,spring,water,cave_entrance' \
  'n/mountain_pass=yes' \
  'n/tourism=viewpoint,camp_site,alpine_hut,wilderness_hut' \
  'n/waterway=waterfall' \
  'n/amenity=parking,toilets,shelter,drinking_water' \
  'n/barrier=gate,stile' \
  'n/ford=yes' \
  'n/information=guidepost' \
  'w/amenity=parking' \
  'w/natural=glacier' \
  'r/admin_level=2,4,5,6'
fi

echo "== loading context slice =="
time docker run --rm -v "$WORK:/data" -v "$STYLE_DIR:/style" \
  -e PGPASSWORD="$PGPASSWORD" -e SB_SLICE=context \
  "$OSM2PGSQL_IMAGE" osm2pgsql \
  --output=flex --style=/style/switchback.lua \
  --slim --drop --cache=2000 \
  --host="$PGHOST_IN_CONTAINER" --port="$PGPORT" --user="$PGUSER" --database="$DB" \
  "/data/$CONTEXT_PBF"

# Overpass returns a way when the way meets the bbox, not when its centre does: eleven Burlingame
# and Santa Cruz car parks straddle the dense tile's edge with their centre outside it. So the
# ring is kept and matched with `ST_Intersects`, and `center` — the centre of the envelope, which
# is what `out center` emits — is precomputed beside it rather than instead of it.
echo "== taking the centre, keeping the ring =="
psql_db "$DB" "ALTER TABLE osm.feature_way ADD COLUMN center geometry(Point,4326)"
psql_db "$DB" "UPDATE osm.feature_way SET center = ST_Centroid(ST_Envelope(geom))"
psql_db "$DB" "VACUUM FULL osm.feature_way"

echo "== indexing =="
psql_db "$DB" "CREATE INDEX ON osm.feature_node USING gist (geom)"
psql_db "$DB" "CREATE INDEX ON osm.feature_way USING gist (geom)"
psql_db "$DB" "CREATE INDEX ON osm.admin_area USING gist (geom)"
psql_db "$DB" "VACUUM ANALYZE"

echo "== size =="
psql_db "$DB" "SELECT relname || ' ' || pg_total_relation_size(oid) FROM pg_class WHERE relnamespace = 'osm'::regnamespace AND relkind = 'r' ORDER BY relname"
psql_db "$DB" "SELECT 'admin_area rows ' || count(*) || ' null_geom ' || count(*) FILTER (WHERE geom IS NULL) FROM osm.admin_area"
# What dropping the ring would have saved, measured rather than assumed, since the centre-only
# table is the cheaper slice that the parity run rejects.
psql_db "$DB" "SELECT 'feature_way ring bytes ' || sum(pg_column_size(geom)) || ' centre bytes ' || sum(pg_column_size(center)) FROM osm.feature_way"
