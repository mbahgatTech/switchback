# Work Order: The nightly browser suite reads a trail CI never ingests

---

## 1. Metadata

| Field           | Value                                                     |
| --------------- | --------------------------------------------------------- |
| id              | `WO-ci-pipeline-green`                                    |
| version         | `1`                                                       |
| status          | `Active`                                                  |
| repo_target     | `switchback`                                              |
| base_sha        | `1789198ff095cbe84a442e163b7dd2ac28a96341`                |
| created_at      | `2026-08-29T00:00:00-07:00`                               |
| harness_version | `3.1.0`                                                   |
| overrides       | none — the repository ships no `AGENTS.md` or `CLAUDE.md` |
| supersedes      | N/A                                                       |

> The dispatch brief named `7d593956` as the base. That commit is `#61`, four commits behind
> the tip. `origin/master` is `1789198`, and this work is cut from it.

---

## 2. Problem statement

Every scheduled CI run since 2026-08-10 has failed, and the whole pipeline is held red by one
job. Three cases in `e2e/review.spec.ts` fail identically on every run with `No trail
"greider-lakes-trail" in this database`, and the deploy jobs downstream never start. The
browser suite is the only gate that opens a browser, so while it is red nothing in the
repository can show an honest green tick.

---

## 3. Scope

**In**

- The trail `e2e/review.spec.ts` files its reports against.
- A regression guard that fails in `gates` — on every pull request — when the browser suite
  names a trail CI does not produce.
- The `ci.yml` comments that count the fixtures and the specs depending on them.

**Out**

- The `Unique constraint failed on the fields: (slug)` line in the ingest step. It is not the
  defect (§ Root cause), it is retried successfully, and it appears in the last green run too.
- The number of Overpass queries CI makes. One per day is a deliberate fair-use decision,
  argued at length at the top of `ci.yml`, and nothing here revisits it.
- `packages/ingest/src/publish.ts` reporting no publisher identity under CI. That is correct:
  CI has no Service Bus, and the message says so.
- Anything under "Observed, not addressed".

---

## 4. Definition of Done

| id  | predicate                                                                                    | verification                                                                                     |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D1  | The root cause is named with evidence from the logs, not inferred                            | § Root cause below cites run ids, log lines and the commit that removed the mechanism            |
| D2  | `npm run test:e2e` passes locally, all 50 cases                                              | `npx playwright test` exits 0, `50 passed`                                                       |
| D3  | The suite passes repeatedly, not once                                                        | two consecutive full runs, both `50 passed`, exit 0                                              |
| D4  | The three reviews cases still exercise the real form, the real routers and the real database | `e2e/review.spec.ts` is unchanged apart from nothing — the specs are not touched at all          |
| D5  | A trail the suite opens that CI cannot produce fails a unit test, not a nightly browser run  | `npx vitest run test/e2e-trail-sources.test.ts` exits 0, and fails when the declaration is wrong |
| D6  | Nothing else regressed                                                                       | `npm run format:check`, `npm run typecheck`, `npm run lint`, `npm test` each exit 0              |
| D7  | CI is green on the pull request                                                              | run URL with conclusion `success`, browser suite included via `workflow_dispatch`                |

---

## 5. Assumptions & defaults

| #   | Ambiguity                                                                                               | Default chosen                                    | Why                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Fix by seeding the trail offline, or by pointing the spec at a different real trail on the Vesper sheet | Seed it offline, under a reserved `fixture-` slug | `seed-e2e.ts` already states the rule and applies it to two other specs: a spec that is not about the pipeline, opening a trail the one tile does not hold, takes a fixture. `review.spec.ts` is the third such spec. Naming another OSM trail would re-create the same fragility — an upstream rename would red the pipeline again, silently, and only at 04:11 UTC. |
| A2  | Where the third fixture lives geographically                                                            | New Zealand, beside the other two                 | The existing comment gives the reason: a fixture inside the Vesper or Snowdon viewport changes what a map spec counts.                                                                                                                                                                                                                                                |
| A3  | Whether to reuse `fixture-photographed-trail` for the reports                                           | No — a third shape                                | The reviews specs write `rating`/`reviewCount` onto their trail, and the gallery spec asserts on the same row. One spec's writes must not be another's preconditions.                                                                                                                                                                                                 |
| A4  | Whether the guard belongs in `e2e/` or in the unit suite                                                | The unit suite, `test/`                           | `test/` is where this repository already keeps invariants about the CI workflow itself. A guard that only runs inside the browser suite is a guard that only reports at 04:11 UTC, which is the failure mode being fixed.                                                                                                                                             |

---

## 6. Design sketch

### Root cause

**A test/infra defect, not a product defect.** The application is behaving as designed. The
browser suite depends on data that CI's one-query budget does not produce, and passed for
months only because of a side effect the product deliberately removed.

The chain, with its evidence:

1. `e2e/fixtures.ts` points the reviews specs at `greider-lakes-trail`, described in its own
   comment as "a quieter trail on the same sheet".
2. It is not on that sheet. Overpass returns `Greider Lakes Trail` as ways `68523637` and
   `68757103`, at 47.9692 °N and 47.9613 °N. The tile `ci.yml` ingests is the z9 quadkey
   under `--at 48.01213,-121.51188`, which is `021230013`, whose southern edge is 47.98992 °N.
   Both ways fall in `021230031`, the tile immediately south.
3. Until 2026-08-09 that neighbouring tile was ingested anyway — by the web application, mid
   test-run, through `packages/api/src/inline-drain.ts`. The last green scheduled run
   ([31296301847](https://github.com/mbahgatTech/switchback/actions/runs/31296301847)) logs
   `[WebServer] assembled { quadkey: '021230031', elements: 752, trails: 316 }` during
   `npm run test:e2e`, and the three reviews cases pass 40 seconds later.
4. `fbdade4` — _Make Service Bus the only way a tile is ingested (#64)_, merged 2026-08-09
   07:24 UTC — deleted `inline-drain.ts`. The request path now only publishes a job, and CI
   has no Service Bus identity, so every run since logs
   `switchback-ingest-publish-failed no usable publisher identity for this deployment` and no
   neighbouring tile is ever ingested.
5. The first scheduled run after that merge
   ([31359383694](https://github.com/mbahgatTech/switchback/actions/runs/31359383694),
   2026-08-10) failed on exactly the three cases, and every scheduled run since has failed the
   same way. The failure is deterministic, not flaky: same three cases, same message, 17 runs.

**The `slug` unique violation in the ingest step is a red herring.** It is a lost race between
concurrent commits for the same name, `commitWithSlugRetry` retries it, and the last _green_
run raised it twice while committing all 212 trails.

### Before and after

```mermaid
flowchart LR
    subgraph before["before #64 — passed by accident"]
        B1[ci: ingest tile 021230013] --> B2[(database)]
        B3[spec opens the sheet] --> B4[web app: inline drain]
        B4 -->|Overpass, unbudgeted| B2
        B4 -.->|tile 021230031:<br/>greider-lakes-trail| B2
    end
    subgraph after["after #64 — the trail never arrives"]
        A1[ci: ingest tile 021230013] --> A2[(database)]
        A3[spec opens the sheet] --> A4[web app: publish job]
        A4 -->|no identity in CI| A5[dropped]
    end
```

```mermaid
flowchart LR
    C1[ci: seed-e2e.ts] -->|fixture-photographed-trail<br/>fixture-early-high-point<br/>fixture-report-trail| C2[(database)]
    C3[ci: ingest tile 021230013] -->|Overpass, once a day| C2
    C4[e2e/trails.ts<br/>SUITE_TRAILS] -.->|held by<br/>test/e2e-trail-sources.test.ts| C1
    C4 -.-> C3
```

### What changes

`packages/db/scripts/e2e-fixtures.ts` — the `Shape` type and the shapes, lifted out of
`seed-e2e.ts` so that the seeding script and the guard read one list rather than two. A third
shape joins them: `fixture-report-trail`, a short day hike with no photographs, which is all
the reviews specs need from a trail.

`e2e/trails.ts` — the trail constants, lifted out of `e2e/fixtures.ts` so a Node test can
import them without loading Playwright's runner, plus one new export:

```ts
export const SUITE_TRAILS: readonly SuiteTrail[];

type SuiteTrail =
  | { slug: string; from: 'seeded' }
  | { slug: string; from: 'ingested'; at: readonly [lng: number, lat: number] };
```

`e2e/fixtures.ts` re-exports them, so no spec changes.

`test/e2e-trail-sources.test.ts` — three cases holding the declaration to CI: every trail
constant is declared, every `seeded` slug is one `seed-e2e.ts` writes, and every `ingested`
slug sits inside the tile the workflow's own `--at` resolves to.

---

## 7. Task breakdown

| id    | task                                                                                                                                 | acceptance check                                                             | status |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ------ |
| T-001 | Lift the fixture shapes into `packages/db/scripts/e2e-fixtures.ts`; `seed-e2e.ts` imports them                                       | `npx tsx packages/db/scripts/seed-e2e.ts` writes the same two trails, exit 0 | `todo` |
| T-002 | Add the `fixture-report-trail` shape                                                                                                 | the seed prints three lines, one per fixture, exit 0                         | `todo` |
| T-003 | Lift the trail constants into `e2e/trails.ts`, add `SUITE_TRAILS`, re-export from `fixtures.ts`, point `REPORT_TRAIL` at the fixture | `npm run typecheck` exits 0                                                  | `todo` |
| T-004 | Add `test/e2e-trail-sources.test.ts`, observed failing first for each of its three cases                                             | `npx vitest run test/e2e-trail-sources.test.ts` exits 0, 3 passed            | `todo` |
| T-005 | Correct the fixture counts in the `ci.yml` comments                                                                                  | `npm run format:check` exits 0 and the comment names three trails            | `todo` |
| T-006 | Full local verification: seed, ingest, browser suite twice, and every hermetic gate                                                  | see § Iteration log for pasted output                                        | `todo` |

---

## 8. Test plan

**Unit** — `test/e2e-trail-sources.test.ts`, three cases against the declaration that broke:

- _names every trail the suite opens_ — happy path. Every exported constant carrying a `slug`
  appears in `SUITE_TRAILS`; a new trail added without a source fails here.
- _seeds every trail the ingested tile does not hold_ — the failure case. `seeded` slugs and
  `seed-e2e.ts`'s shapes are the same set, in both directions.
- _ingests the tile every other trail sits in_ — the edge case, and the one that would have
  caught this defect. Each `ingested` trail's coordinate resolves to the quadkey the
  workflow's own `--at` resolves to, both read rather than restated.

**Integration** — `e2e/review.spec.ts`, unchanged. Filing a report through the rendered form,
reading it back off the trail page, filing one into a held tRPC batch, and withdrawing one:
all still against the real Next server, the real routers and the real Postgres.

**Edge cases** — the guard reads `ci.yml` and `e2e/trails.ts` rather than restating either, so
a workflow edited to ingest a different tile, a constant renamed, or a fixture deleted each
fail it. A vacuous harvest — no trails found, no `--at` found — fails rather than passes.

**Regression** — the other 47 browser cases, and the four hermetic gates. Two consecutive
full browser runs, because a suite that passes once has not been shown to be deterministic.

---

## 9. Iteration log

```yaml
- seq: 1
  at: 2026-08-29T00:00:00-07:00
  state: RESEARCH -> WORK_ORDER
  event: root_cause_identified
  detail: >-
    17 consecutive scheduled runs fail on the same three e2e/review.spec.ts cases with
    `No trail "greider-lakes-trail" in this database`. Overpass places that trail at
    47.96N, in z9 tile 021230031; ci.yml ingests 021230013, southern edge 47.98992N. The
    last green run (31296301847) shows the web app ingesting 021230031 itself mid-suite via
    packages/api/src/inline-drain.ts, which fbdade4 (#64) deleted on 2026-08-09.
  decision: test/infra defect. Seed the trail offline under a reserved `fixture-` slug, as
    seed-e2e.ts already does for the two other specs that open trails off the tile.
  budget: { implement: 0/3, review: 0/3, replan: 0/2, total: 1/8 }
```
