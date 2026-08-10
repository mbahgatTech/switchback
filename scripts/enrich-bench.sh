#!/bin/sh
# One clean benchmark pass, run alone so nothing else contends for the single core the
# association loop uses. Not part of any gate; invoked by hand.
#
# The PostGIS candidates need DATABASE_URL pointing at a local PostGIS — `npm run db:up` brings
# one up on 5433. They create temporary tables only.
set -e
cd "$(dirname "$0")/.."

BENCH="node --expose-gc --import tsx scripts/enrich-bench.ts"

$BENCH 021231030 --only baseline,grid,postgis,postgis-bulk --pg-margin
echo "=== sparse tile, whole, every candidate ==="

$BENCH 023010230 --only baseline --no-compare
echo "=== dense tile, whole, baseline timing ==="

$BENCH 023010230 --only grid,postgis,postgis-bulk --no-compare
echo "=== dense tile, whole, candidate timing ==="

$BENCH 023010230 --only grid
echo "=== dense tile, whole, grid accuracy ==="

$BENCH 023010230 --sample 60 --only baseline,grid,mutants
echo "=== dense tile, 60-trail sample, mutants ==="
