#!/usr/bin/env bash
# Applies one named mutation to tile-completeness.ts, runs the completeness suite, reverts.
# The point is the differential: a mutation the suite does not fail on is a term no test pins.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

TARGET=scripts/osm-slice/tile-completeness.ts
BACKUP=$(mktemp)
cp "$TARGET" "$BACKUP"
restore() { cp "$BACKUP" "$TARGET"; rm -f "$BACKUP"; }
trap restore EXIT

case "${1:-}" in
  within)   # tile selection: intersects -> contained by
    perl -0pi -e 's/ST_Intersects\(r\.geom, box\.g\)/ST_Within(r.geom, box.g)/' "$TARGET" ;;
  no-type-filter)   # member-type discrimination dropped in all three places
    perl -0pi -e "s/count\(\*\) FILTER \(WHERE mtype = 'way'\) AS declared/count(*) AS declared/" "$TARGET"
    perl -0pi -e "s/FILTER \(WHERE mtype = 'way' AND way_id IS NULL\)/FILTER (WHERE way_id IS NULL)/g" "$TARGET" ;;
  no-join-type)     # the LEFT JOIN stops discriminating on member type
    perl -0pi -e "s/ON m\.value ->> 'type' = 'way' AND w\.way_id/ON w.way_id/" "$TARGET" ;;
  hiking-only)      # the route-value set narrowed to one value
    perl -0pi -e "s/IN \('hiking', 'foot', 'walking', 'running'\)/= 'hiking'/" "$TARGET" ;;
  no-node-box)      # node-member clause loses its positional term
    perl -0pi -e 's/n\.relation_id = r\.relation_id AND n\.geom && box\.g/n.relation_id = r.relation_id/' "$TARGET" ;;
  no-node-correlation)  # node-member clause loses its correlation term
    perl -0pi -e 's/WHERE n\.relation_id = r\.relation_id AND n\.geom && box\.g/WHERE n.geom && box.g/' "$TARGET" ;;
  *)
    echo "usage: $0 <within|no-type-filter|no-join-type|hiking-only|no-node-box|no-node-correlation>" >&2
    exit 2 ;;
esac

CHANGED=$(git diff --numstat -- "$TARGET")
if [ -z "$CHANGED" ]; then
  echo "MUTATION '$1' CHANGED NOTHING — the pattern no longer matches the source." >&2
  exit 3
fi
echo "=== mutation '$1' applied: $CHANGED ==="
git --no-pager diff -- "$TARGET"

echo "=== suite under mutation ==="
npx vitest run test/osm-slice-completeness.db.test.ts
echo "VITEST_EXIT=$?"
