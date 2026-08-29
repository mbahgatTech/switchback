# Ingest metrics

Read-only measurement of the ingest queue against live data. Seven psql scripts, one per question,
each printing labelled sections so a whole run can be pasted into an issue as evidence.

Nothing here writes. Every statement is a `SELECT`, and the runner sets
`default_transaction_read_only` on top of that so a mistake fails rather than lands.

## Running

`scripts/pgenv.sh` opens a production session with an Entra token and never prints it:

```sh
PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=120000' \
  bash scripts/pgenv.sh -f scripts/ingest-metrics/00-context.sql
```

Against any other database, point `psql` at a URL directly:

```sh
psql -X -v ON_ERROR_STOP=1 -f scripts/ingest-metrics/01-tile-cost.sql "$DATABASE_URL"
```

Files 02 and 03 take a window. It defaults to one hour for 02 and a week for 03, and
`-v win_hours=24` overrides it:

```sh
bash scripts/pgenv.sh -v win_hours=24 -f scripts/ingest-metrics/02-drain-concurrency.sql
```

Run `00-context.sql` first. It prints the clock, the row counts and the oldest and newest timestamps
in each table — the span every other file's numbers are only meaningful inside.

## The files

| File                       | Question                   | Reports                                                                                                                                  |
| -------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `00-context.sql`           | What is being measured     | Connection, row counts, observable span, database size against the 85% admission ceiling                                                 |
| `01-tile-cost.sql`         | What a tile costs          | `fetchMs` percentiles by zoom, `trailCount` distribution, the cross-tabulation of the two, a linearity regression, where the tail starts |
| `02-drain-concurrency.sql` | Concurrency achieved       | The sweep line over `lockedAt`/`completedAt` from `docs/architecture.md`, peak per day, time spent at each level, lease durations        |
| `03-throughput.sql`        | Jobs and tiles per hour    | Hourly and daily completion rates, active-hour distribution, the ceiling the measured fetch time implies                                 |
| `04-queue-depth.sql`       | Depth now and historically | The exact number `admitIngest` compares to 513, reconstructed depth per day, the backlog in hours at the observed rate                   |
| `05-failure-taxonomy.sql`  | What fails                 | Failures bucketed on the literal messages the code writes, plus every distinct message normalised as the check on those buckets          |
| `06-split-cycle.sql`       | Subdivision                | Tiles by zoom, split parents and their children's outcomes, orphaned splits, the Overpass time the cycle discards                        |

## What the data cannot say

Three properties of the schema bound every number these scripts produce. They are restated in each
file that they affect, and reading a result without them produces confident wrong answers.

**A revived job overwrites its own history.** `enqueue` resets a `done`, `failed` or `dead` row in
place — same row, `completedAt` cleared — because a `dedupeKey` lives forever and a tile has to stay
ingestable. So `ingest_jobs` holds one row per unit of work ever queued, not one per attempt: only
the most recent cycle of each is visible. Rates are exact for recent hours and a lower bound for old
ones. `ingest_tiles."fetchedAt"` has the same shape.

**`fetchMs` means two different things.** `processTile` writes the wall clock of a successful fetch;
`splitTile` writes the wall clock of the invocation that ran out of clock and subdivided. The second
is censored — the tile cost at least that much and the true figure was never observed — so pooling
them understates dense tiles and overstates the median. Every percentile in `01-tile-cost.sql`
separates them on the split marker in `lastError`.

**A refused ingest leaves no row.** `admitIngest` returns `'queue-depth'` and writes a
`console.warn`; nothing is persisted. Whether the 513 ceiling has ever actually refused a request is
answerable only from the drainer's runtime logs — grep for `ingest refused: queue depth`. Section Q4
of `04-queue-depth.sql` reconstructs when the ceiling _would_ have been tripped from enqueue and
completion edges, which is the nearest the database can come and is a weaker claim.

The same limit applies to claim conflicts. `writeOutcome` returns false when a lease has already
been reclaimed, `drainJobs` counts it as `lost` in its log line, and the row records nothing. The
database-side trace is a stale lease and the `lease expired after N min with no outcome` the reaper
writes afterwards, both of which `05-failure-taxonomy.sql` counts.

## Constants these scripts hard-code

Literals appear inline rather than being read from the environment, because the database does not
know them and a script that guessed would be worse than one that states its assumption. Each is
named where it is used.

| Value  | Meaning                                       | Source                                |
| ------ | --------------------------------------------- | ------------------------------------- |
| 513    | `MAX_TILE_QUEUE_DEPTH`, 18 h of drain at 28.5 | `packages/ingest/src/backpressure.ts` |
| 28.5   | `ESTATE_DRAIN_TILES_PER_HOUR`                 | `packages/ingest/src/drain-rate.ts`   |
| 20,000 | `DERIVED_QUEUE_WARN_DEPTH`                    | `packages/ingest/src/backpressure.ts` |
| 0.85   | `MAX_STORAGE_FRACTION`                        | `packages/ingest/src/backpressure.ts` |
| 12 min | `LEASE_TIMEOUT_MS`, host timeout plus margin  | `packages/ingest/src/jobs.ts`         |
| 5      | `maxAttempts` default                         | `packages/db/prisma/schema.prisma`    |
| 190 s  | `OVERPASS_MAX_TOTAL_MS` default               | `packages/ingest/src/config.ts`       |
| 9      | `INGEST_ZOOM`, the tile grain                 | `packages/geo/src/tiles.ts`           |

Changing any of them in the code changes what these scripts should compare against.
