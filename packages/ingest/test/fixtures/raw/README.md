# Recorded Overpass answers

Every Overpass answer shape the ingest pipeline reads, recorded once so no test or benchmark
queries a live mirror. `index.json` lists them; each recording carries the query that produced it.

## What is here

| shape               | subject                  | answer                                                                           |
| ------------------- | ------------------------ | -------------------------------------------------------------------------------- |
| `tile`              | `021231030`              | Sparse z9 tile, Kootenai County, Idaho — 281 elements, 145 trails                |
| `tile`              | `023010230`              | Dense z9 tile, 37.16..37.72 N by 122.34..121.64 W — 4,990 elements, 1,517 trails |
| `feature`           | `021231030`, `023010230` | Waypoints and amenities over each tile's padded box                              |
| `route`             | `1225378`                | The Pacific Crest Trail superroute, whole                                        |
| `route`             | `7470475`                | Trail A, whole, with member geometry inline                                      |
| `relation-skeleton` | `7470475`                | Trail A's member list, no geometry                                               |
| `way-geometry`      | `7470475`                | Geometry for Trail A's seven member ways                                         |
| `parent-route`      | `1247934+1249228`        | The superroute two PCT sections belong to                                        |
| `region`            | `021231030`              | Administrative areas containing the sparse tile's centre                         |
| `network`           | `021231030323`           | Routable ways over one z12 routing tile                                          |
| `tags-by-id`        | `node.12`                | `ele` for twelve peaks in the sparse tile                                        |

`7470475` — "Trail A", 9,081.9 m over three chained ways of the seven it declares — is recorded
three ways because `fetchRelationInParts` claims a skeleton plus way geometry splices back into
what `out body geom` returns. `assemble-golden.test.ts` holds it to that.

## Dates

`timestampOsmBase` is the instant of the planet an answer describes, and is the date that matters.
`recordedAt` is only when the request was made; the two differ by however far behind the mirror was.

## golden/

What `assembleTrails` makes of a recording, one line per trail, coordinates digested rather than
stored. `assembleSummary` in `../../support/raw-fixture.ts` produces it and is the seam a
replacement trail source is diffed through.

Re-derive from what is already committed, with no network:

```sh
npx tsx scripts/enrich-fixture.ts golden tile 021231030 023010230
```

## Re-recording

Needs `OVERPASS_USER_AGENT` carrying a contact URL that reaches a human — see `.env.example`.
Commands are serial by design: a second process is a second queue, and Overpass allots request
slots per client IP.

```sh
export OVERPASS_USER_AGENT="Switchback/0.1 (+https://switchback-three.vercel.app/attribution)"
npx tsx scripts/enrich-fixture.ts tile 021231030
npx tsx scripts/enrich-fixture.ts relation-parts 7470475
npx tsx scripts/enrich-fixture.ts parent-route 1247934 1249228
```

Re-recording a tile moves its golden, and the diff is the review. Run `enrich-fixture.ts` with no
arguments for the full command list.

`enrich-fixture.ts enrich` is a different thing and is not part of this set: it rebuilds
`../enrich/*.json.gz`, whose element counts `enrich-association.test.ts` asserts exactly.
