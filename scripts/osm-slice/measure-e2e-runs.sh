#!/usr/bin/env bash
# N end-to-end runs of one tile in one mode, each a cold insert, summarised as a distribution.
# Identical work measured twice here has differed by 21 s, so a single run decides nothing.
set -euo pipefail

RUNS=${RUNS:-3}
MODE=${MODE:-slice}
QUADKEY=$1
shift
OUT="scripts/tmp/e2e-${MODE}-${QUADKEY}.jsonl"
# Appended, never truncated: runs from different sittings are the same distribution, and a
# re-invocation that discarded the earlier ones would quietly shrink n.
touch "$OUT"

for i in $(seq 1 "$RUNS"); do
  echo "== $MODE run $i/$RUNS ==" >&2
  MODE="$MODE" bash scripts/osm-slice/measure-env.sh \
    tsx scripts/osm-slice/measure-ingest-tile.ts "$QUADKEY" "$@" \
    | tr -d '\n' | sed 's/  */ /g' >> "$OUT"
  echo >> "$OUT"
done

echo "wrote $OUT" >&2
