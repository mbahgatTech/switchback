#!/usr/bin/env bash
# Applies one named mutation to tile-completeness.ts, runs the completeness suite, reverts.
# The point is the differential: a mutation the suite does not fail on is a term no test pins.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1

TARGET=scripts/osm-slice/tile-completeness.ts
SUITE=test/osm-slice-completeness.db.test.ts
# `tmp/` is ignored; a path under the system temp is a POSIX path the native Windows node the
# reporter runs on resolves to a `C:\tmp\...` that does not exist.
REPORT=tmp/mutate-completeness.$$.json

MUTATIONS='within|no-exact-intersects|no-type-filter|no-refs-type-filter|no-join-type|hiking-only|no-node-box|no-node-correlation|distinct-declared|distinct-resolved|ords-constant|missing-reversed|missing-by-ref|missing-truncated|missing-deduped'

# The predicate is a tracked file and other agents share this checkout, so a run that starts dirty
# cannot tell its own edit from someone else's, and restoring would discard theirs.
if ! git diff --quiet -- "$TARGET"; then
  echo "REFUSING: $TARGET already has uncommitted changes." >&2
  echo "A previous run may have been killed before its trap restored it; check 'git diff'." >&2
  exit 4
fi

BACKUP=$(mktemp)
cp "$TARGET" "$BACKUP"
restore() {
  cp "$BACKUP" "$TARGET"
  rm -f "$BACKUP" "$BACKUP.mutated" "$REPORT"
  # A trap that silently failed to restore would leave a mutated predicate behind for the next run.
  git diff --quiet -- "$TARGET" || echo "WARNING: $TARGET was not restored cleanly." >&2
}
trap restore EXIT

mkdir -p tmp

FAILED=0 PASSED=0 EXECUTED=0
# The suite's exit code cannot tell a mutation the tests caught from a database they never
# reached: a failed `beforeAll` skips all nine and exits 1 too. So the verdict is read from how
# many tests actually ran and which of them failed.
run_suite() {
  rm -f "$REPORT"
  npx vitest run --reporter=default --reporter=json --outputFile.json="$REPORT" "$SUITE"
  local counts
  counts=$(node -e '
    const fs = require("fs");
    const file = process.argv[1];
    if (!fs.existsSync(file)) { console.log("0 0"); process.exit(0); }
    const r = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`${r.numFailedTests} ${r.numPassedTests}`);
  ' "$REPORT")
  read -r FAILED PASSED <<<"$counts"
  # A reporter that wrote nothing leaves these empty, and an empty count must read as "nothing
  # ran" rather than abort the arithmetic below.
  FAILED=${FAILED:-0}
  PASSED=${PASSED:-0}
  EXECUTED=$((FAILED + PASSED))
}

# Named, because "the suite went red" is the claim a mutation score has to support.
failed_test_names() {
  node -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const file of r.testResults)
      for (const t of file.assertionResults)
        if (t.status === "failed") console.log(`  - ${t.fullName}`);
  ' "$REPORT"
}

case "${1:-}" in
  within) # tile selection: intersects -> contained by
    perl -0pi -e 's/ST_Intersects\(r\.geom, box\.g\)/ST_Within(r.geom, box.g)/' "$TARGET" ;;
  no-exact-intersects) # tile selection keeps only the bounding-box index operator
    perl -0pi -e 's/\(r\.geom && box\.g AND ST_Intersects\(r\.geom, box\.g\)\)/(r.geom && box.g)/' "$TARGET" ;;
  no-type-filter) # member-type discrimination dropped from the counts
    perl -0pi -e "s/count\(\*\) FILTER \(WHERE mtype = 'way'\) AS declared/count(*) AS declared/" "$TARGET"
    perl -0pi -e "s/FILTER \(WHERE mtype = 'way' AND way_id IS NULL\)/FILTER (WHERE way_id IS NULL)/g" "$TARGET" ;;
  no-refs-type-filter) # counts keep it; only the reported members stop discriminating
    perl -0pi -e "s/FILTER \(WHERE mtype = 'way' AND way_id IS NULL\)/FILTER (WHERE way_id IS NULL)/g" "$TARGET" ;;
  no-join-type) # the LEFT JOIN stops discriminating on member type
    perl -0pi -e "s/ON m\.value ->> 'type' = 'way' AND w\.way_id/ON w.way_id/" "$TARGET" ;;
  hiking-only) # the route-value set narrowed to one value
    perl -0pi -e "s/IN \('hiking', 'foot', 'walking', 'running'\)/= 'hiking'/" "$TARGET" ;;
  no-node-box) # node-member clause loses its positional term
    perl -0pi -e 's/n\.relation_id = r\.relation_id AND n\.geom && box\.g/n.relation_id = r.relation_id/' "$TARGET" ;;
  no-node-correlation) # node-member clause loses its correlation term
    perl -0pi -e 's/WHERE n\.relation_id = r\.relation_id AND n\.geom && box\.g/WHERE n.geom && box.g/' "$TARGET" ;;
  distinct-declared) # declared counts distinct ids rather than declared occurrences
    perl -0pi -e "s/count\(\*\) FILTER \(WHERE mtype = 'way'\) AS declared/count(DISTINCT ref) FILTER (WHERE mtype = 'way') AS declared/" "$TARGET" ;;
  distinct-resolved) # resolved counts distinct ids rather than resolved occurrences
    perl -0pi -e 's/count\(way_id\) AS resolved/count(DISTINCT way_id) AS resolved/' "$TARGET" ;;
  ords-constant) # member position replaced by a constant
    perl -0pi -e 's/         m\.ord,/         1 AS ord,/' "$TARGET" ;;
  missing-reversed) # the reported gaps come back in reverse chain order
    perl -0pi -e 's/ORDER BY ord\)/ORDER BY ord DESC)/' "$TARGET" ;;
  missing-by-ref) # the reported gaps are ordered by way id rather than by chain position
    perl -0pi -e 's/ORDER BY ord\)/ORDER BY ref)/' "$TARGET" ;;
  missing-truncated) # only the first gap of each relation reaches the report
    perl -0pi -e 's/missingMembers: row\.missing_members,/missingMembers: row.missing_members.slice(0, 1),/' "$TARGET" ;;
  missing-deduped) # a way missing at two positions is named once
    perl -0pi -e 's/missingMembers: row\.missing_members,/missingMembers: row.missing_members.filter((m, i, a) => a.findIndex((x) => x.ref === m.ref) === i),/' "$TARGET" ;;
  *)
    echo "usage: $0 <${MUTATIONS}>" >&2
    exit 2 ;;
esac

# A pattern that stopped matching would report a green suite for a mutation never applied, which
# reads exactly like coverage.
CHANGED=$(git diff --numstat -- "$TARGET")
if [ -z "$CHANGED" ]; then
  echo "MUTATION '$1' CHANGED NOTHING — the pattern no longer matches the source." >&2
  exit 3
fi
echo "=== mutation '$1' applied: $CHANGED ==="
git --no-pager diff -- "$TARGET"

# The mutation is reverted for the control run, so the two differ in exactly one thing.
cp "$TARGET" "$BACKUP.mutated"
cp "$BACKUP" "$TARGET"
echo "=== positive control: the suite with the mutation reverted ==="
run_suite
if [ "$FAILED" -ne 0 ] || [ "$EXECUTED" -eq 0 ]; then
  echo "NOT EVALUATED: the pristine suite is not green — $PASSED passed, $FAILED failed." >&2
  echo "A verdict read off this run would be the environment's, not the mutation's." >&2
  rm -f "$BACKUP.mutated"
  exit 5
fi
CONTROL_EXECUTED=$EXECUTED
echo "CONTROL: $PASSED passed, 0 failed"

cp "$BACKUP.mutated" "$TARGET"
rm -f "$BACKUP.mutated"
echo "=== suite under mutation ==="
run_suite

if [ "$EXECUTED" -ne "$CONTROL_EXECUTED" ]; then
  echo "NOT EVALUATED: $EXECUTED tests ran under the mutation and $CONTROL_EXECUTED without it." >&2
  echo "The predicate was never exercised, so nothing here is a verdict on '$1'." >&2
  exit 5
fi

if [ "$FAILED" -gt 0 ]; then
  echo "VERDICT killed: '$1' fails $FAILED of $EXECUTED tests —"
  failed_test_names
  exit 0
fi

echo "VERDICT SURVIVED: '$1' passes all $EXECUTED tests. No fixture pins that term." >&2
exit 1
