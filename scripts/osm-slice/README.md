# OSM slice measurement

Whether a local PostGIS slice of OpenStreetMap can replace Overpass as the trail source, measured
rather than argued. Nothing here is imported by the application.

## What each script answers

| script | question |
| --- | --- |
| `measure-extract.sh` | What does slicing an extract cost to build, and on disk? |
| `switchback.lua` | osm2pgsql flex style; `SB_SLICE=trail` mirrors `buildTileQuery`, `SB_SLICE=network` mirrors `buildNetworkQuery` |
| `measure-tile-query.ts` | How fast is the SQL equivalent of `buildTileQuery`, and does it reproduce the committed golden? |
| `measure-overpass-baseline.ts` | What does the same tile query cost against a live mirror, now? |
| `measure-context-baseline.ts` | What does the region and feature pair cost, which the trail slice does not replace? |
| `measure-ingest-tile.ts` | What does a whole tile cost end to end with the trail source swapped? |
| `slice-bytes.sql` | Bytes per km², per slice, with index and page overhead carried in |
| `poly-to-wkt.ts` | Geofabrik `.poly` to WKT, so an extract's area is computed rather than looked up |
| `diagnose-divergence.ts` | Which member ways a divergent trail lost, and whether the slice ever held them |
| `provenance.ts` | Which tree the harness actually loads — a worktree has no `node_modules` of its own |
| `disk-arithmetic.py` | Measured densities against the production disk budget |

## Running it

`osmium-tool` and `osm2pgsql` are used as container images; neither is installed on a developer
machine. `measure-extract.sh` reads their names from `OSMIUM_IMAGE` and `OSM2PGSQL_IMAGE`, so any
image carrying the binary will do. The ones measured against were Debian bookworm plus apt —
osmium 1.15.0 / libosmium 2.19.0, and osm2pgsql 1.8.0:

```sh
docker build -t sb-osmium:1 - <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osmium-tool \
 && rm -rf /var/lib/apt/lists/*
EOF

docker build -t sb-osm2pgsql:1 - <<'EOF'
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends osm2pgsql postgresql-client \
    ca-certificates && rm -rf /var/lib/apt/lists/*
EOF

scripts/osm-slice/measure-extract.sh /path/to/idaho-latest.osm.pbf osm_idaho
```

`tags-filter` runs **without `-R`**. The referenced ways and nodes are what carry the geometry;
dropping them yields route relations with nothing to assemble and ways with no coordinates, and
the slice still looks healthy.

The parity harness reads the golden Overpass recordings in
`packages/ingest/test/fixtures/raw/`, so it needs no network:

```sh
tsx scripts/osm-slice/measure-tile-query.ts osm_idaho 021231030 \
  -116.71875 47.5172006978394 -116.015625 47.98992166741418
```

`PERTURB=coords|drop|order` damages the SQL answer on purpose. A parity run that has not been seen
failing proves nothing, so the control runs before the result is believed.

## Two things that are load-bearing and do not look it

**Ways must arrive ordered by `way_id` ascending.** `chainWays` is greedy and seeds in iteration
order, so arrival order decides which line a branchy name group yields, and therefore the
`Math.min(wayIds)` that becomes the trail's `osmId`. Overpass emits ascending by id; osm2pgsql
clusters by geometry. Serving cluster order reproduces the right trail *count* with the wrong
trails, which is the failure mode least likely to be noticed.

**An extract is older than a recording.** Geofabrik publishes daily; a golden recorded from a live
mirror is hours newer. Ways created in that window are absent from the slice and read as parity
failures. `diagnose-divergence.ts` separates the two by probing the raw extract for the missing id.
