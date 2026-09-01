# OSM slice measurement

Whether a local PostGIS slice of OpenStreetMap can replace Overpass as the trail source, measured
rather than argued. Nothing here is imported by the application.

## What each script answers

| script                         | question                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `measure-extract.sh`           | What does slicing an extract cost to build, and on disk?                                                                                  |
| `measure-context-extract.sh`   | Same, for the feature and admin classes the tile context queries read                                                                     |
| `switchback.lua`               | osm2pgsql flex style; `SB_SLICE` picks `trail` (buildTileQuery), `network` (buildNetworkQuery) or `context` (the feature and region pair) |
| `measure-tile-query.ts`        | How fast is the SQL equivalent of `buildTileQuery`, and does it reproduce the committed golden?                                           |
| `measure-context-query.ts`     | The same for `buildRegionQuery` and `buildFeatureQuery`                                                                                   |
| `measure-node-members.ts`      | How much selection area do relation node members add that member-way geometry misses?                                                     |
| `measure-overpass-baseline.ts` | What does the same tile query cost against a live mirror, now?                                                                            |
| `measure-context-baseline.ts`  | What does the region and feature pair cost live?                                                                                          |
| `measure-ingest-tile.ts`       | What does a whole tile cost end to end, with the source `MODE` names?                                                                     |
| `measure-e2e-runs.sh`          | The same, N times, because one run of either arm decides nothing                                                                          |
| `summarise-e2e.ts`             | Both distributions and the speedup, stated every way it can honestly be stated                                                            |
| `measure-env.sh`               | The measurement database and a usable Overpass identity; never reads the repository `.env`                                                |
| `slice-bytes.sql`              | Bytes per km², per slice, with index and page overhead carried in                                                                         |
| `poly-to-wkt.ts`               | Geofabrik `.poly` to WKT, so an extract's area is computed rather than looked up                                                          |
| `diagnose-divergence.ts`       | Which member ways a divergent trail lost, and whether the slice ever held them                                                            |
| `provenance.ts`                | Which tree the harness actually loads — a worktree has no `node_modules` of its own                                                       |
| `disk-arithmetic.py`           | The first gate's densities against the production disk budget                                                                             |
| `disk-widened.py`              | The same including the context slice, at region extent, on deduplicated sizes                                                             |
| `tile-completeness.ts`         | Does every way member a tile's route relations declare resolve to a way the slice holds?                                                  |
| `mutate-completeness.sh`       | Applies one named mutation to that predicate and reruns its suite, so each SQL term's coverage is a differential rather than a claim      |
| `raw-fixtures.ts`              | Reads the golden Overpass recordings and reduces assembled trails to a comparable summary                                                 |
| `untagged-member-probe.osm`    | A route relation with one member the loader keeps and one it drops, no boundary in the file                                               |
| `untagged-member-probe.sh`     | Loads that fixture and holds the gap to being either kept or reported                                                                     |

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

Every script here runs against a plain `master` checkout, including a slice built only by the
command above — no script names a table `measure-extract.sh` does not create. The timing and
completeness numbers need nothing else. The parity half additionally needs one golden summary per
tile, which lives on the fixture branch and is a plain JSON file of tens to hundreds of kilobytes,
not one of the gzipped recordings beside it:

```sh
mkdir -p packages/ingest/test/fixtures/raw/golden
git fetch origin test/golden-overpass-fixtures
git cat-file -p origin/test/golden-overpass-fixtures:packages/ingest/test/fixtures/raw/golden/assemble.tile.021231030.json \
  > packages/ingest/test/fixtures/raw/golden/assemble.tile.021231030.json

tsx scripts/osm-slice/measure-tile-query.ts osm_idaho 021231030 \
  -116.71875 47.5172006978394 -116.015625 47.98992166741418
```

Without that file the run prints its timings and reports parity `UNVERIFIED` rather than failing,
so a measurement is never lost to a missing recording.

`PERTURB=coords|drop|order` damages the SQL answer on purpose. A parity run that has not been seen
failing proves nothing, so the control runs before the result is believed — which means the golden
has to be present for it to say anything.

## Two things that are load-bearing and do not look it

**Ways must arrive ordered by `way_id` ascending.** `chainWays` is greedy and seeds in iteration
order, so arrival order decides which line a branchy name group yields, and therefore the
`Math.min(wayIds)` that becomes the trail's `osmId`. Overpass emits ascending by id; osm2pgsql
clusters by geometry. Serving cluster order reproduces the right trail _count_ with the wrong
trails, which is the failure mode least likely to be noticed — `PERTURB=order` on the sparse tile
holds the count at 145 and still moves one trail in, one out and eight fields. `fetchTileElements`
asserts the ordering rather than trusting the `ORDER BY`.

**An extract is older than a recording.** Geofabrik publishes daily; a golden recorded from a live
mirror is hours newer. Ways created in that window are absent from the slice and read as parity
failures. `diagnose-divergence.ts` separates the two by probing the raw extract for the missing id.

## Two things the load script got wrong, and how they were caught

**A way is selected by the way, not by its centre.** `out center` reports a bounding-box centre,
but Overpass selects on the object: eleven car parks straddling the dense tile's padded edge sit
in its answer with their centre outside the box. Storing only the centre — which is a fifth of the
disk — silently drops them. The ring is kept and matched with `ST_Intersects`; the centre rides
alongside for the answer.

**osm2pgsql already indexes the geometry column.** `measure-extract.sh` created a second GiST
index on every geometry table, and the first gate's disk figures carried both copies — 94 MB of
the 1,056 MB northern California slice. Every size in `disk-widened.py` is measured after dropping
the duplicates.

## The gap a pre-warmed tile cannot recover from

A tile marked `ready` is never re-fetched, so any way the slice lacks that Overpass would have
returned is not a cache miss — it is permanent, invisible loss. `tile-completeness.ts` is the
predicate that makes it visible: it counts the way members a tile's route relations declare
against the ways the slice actually holds, and names every relation where the two disagree.

```sh
tsx scripts/osm-slice/tile-completeness.ts --database osm_norcal --quadkey 023010230
```

The `rel` term is the selection `RELATION_SQL` uses, deliberately. A predicate that selected a
different set of relations than the adapter reads would score a tile the adapter never fetches.

Each gap is reported as a `{ ref, ordinal }` pair: the way id, and its position in the whole member
chain with guideposts and sub-routes counted, so an operator can go to the link that breaks rather
than search a chain hundreds long. Ref and ordinal are aggregated as one object and not as two
arrays paired by index, because reordering one of two arrays annotates every gap with another
member's position while every count in the report stays right.

Every term in the query is one an edit could quietly weaken while the tool still prints a plausible
number, so each has a fixture that separates it from its neighbours:

| term                                                   | the fixture that moves it                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ST_Intersects` rather than `ST_Within`                | a relation crossing the tile edge                                                                                                                            |
| the exact test beside the `&&` index filter            | a relation whose bounding box covers the tile while its line passes around it                                                                                |
| `FILTER (WHERE mtype = 'way')` on the counts           | a complete relation carrying a guidepost node and a sub-route                                                                                                |
| the same filter on the reported members                | an incomplete relation carrying them — the counts are right either way, only the list moves                                                                  |
| `WITH ORDINALITY`, and `ORDER BY ord` on the aggregate | a relation missing three ways at interleaved chain positions, in an order that is neither ref-ascending nor ref-descending                                   |
| counts of occurrences rather than of distinct ids      | a relation declaring one way twice and resolving both, and one missing a way it declares twice — 11 relations in `osm_norcal` declare a duplicate way member |
| `m.value ->> 'type' = 'way'` on the LEFT JOIN          | a node member whose ref collides with a real way id                                                                                                          |
| the route-value set                                    | one relation per selected value plus two excluded ones                                                                                                       |
| both terms of the node-member clause                   | three relations sharing a node-member table                                                                                                                  |

`mutate-completeness.sh` applies each weakening in turn and reruns
`test/osm-slice-completeness.db.test.ts`, which is what makes the coverage a differential:

```sh
bash scripts/osm-slice/mutate-completeness.sh within
```

Its verdict is a **named assertion failure**, not an exit code. A suite that cannot reach its
database exits 1 with every test skipped, which is indistinguishable from a caught mutation if the
exit code is all you read — so each run first reverts the mutation and requires that control run
green, then requires the mutated run to execute the same number of tests and fail at least one,
and prints which. `NOT EVALUATED` (exit 5) is the third outcome.

**The gaps are interior.** `osm2pgsql` never calls the style's way callback for a way carrying no
tags, so an untagged way that a route relation declares as a member is gone before
`switchback.lua` can decide anything — no widening of the extract box brings it back.
`untagged-member-probe.osm` reproduces exactly that in a file whose every element sits well inside
its own `<bounds>`, which is what separates the mechanism from a clipping artefact:

```sh
bash scripts/osm-slice/untagged-member-probe.sh
```

It holds one invariant: **either** way `100` reaches `osm.trail_way`, **or** `tileCompleteness`
reports relation `900` incomplete. Branch B is what holds against osm2pgsql 1.8.0; a loader that
later keeps untagged relation members satisfies branch A and the check stays green unedited. What
it forbids is the third state — the way absent and the predicate blind to it.

`osm.relation_node_member` is built after the fact by `measure-node-members.ts` and never by
`switchback.lua`. Both `tile-completeness.ts` and `measure-tile-query.ts` probe for it and include
the node-member term only when it is really there: naming it unconditionally fails outright on a
loader-built database, and dropping it unconditionally unselects the relations only a member node
puts inside the box — which is the same silent thinness the predicate exists to catch.

The completeness suite needs a database. It creates a scratch one per run, named with the process
id, because the container is shared: two runs against one fixed name give the second a setup
failure and the first a truncated fixture mid-assertion. A run that cannot reach Postgres fails
rather than skipping, so a green suite always means the predicate executed.

## What a regional extract cannot answer

No `boundary=administrative` relation above admin level 6 closes inside a state or region extract:
Idaho's own relation declares 262 member ways and the extract carries 259, and the United States
relation declares 1,710. So `pickRegion` gets its `regionName` — 43 of Idaho's 44 counties close,
and 47 of 47 in northern California, every other failure being an out-of-region fragment — and
never gets a `countryCode`. Whether a continental admin slice closes those rings is **unmeasured**;
it needs an extract this machine has no room for.
