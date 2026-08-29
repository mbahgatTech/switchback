import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INGEST_ZOOM, lngLatToTile, tileToQuadkey } from '@switchback/geo';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { SHAPES } from '../packages/db/scripts/e2e-shapes';
import * as trails from '../e2e/trails';

/**
 * The browser suite runs nightly, so a trail it opens that CI cannot produce is a defect nobody
 * sees for a day and nobody can reproduce from a pull request. One went unnoticed for a
 * fortnight: `e2e/review.spec.ts` filed its reports against an OSM trail 3 km south of the one
 * tile the workflow ingests, which reached the database only as a side effect of the web app
 * ingesting neighbouring tiles inline. That side effect was removed on purpose, and every
 * scheduled run from 2026-08-10 on failed the same three cases.
 *
 * So every trail slug written anywhere under `e2e/` is checked here — in `gates`, which runs on
 * every push and every pull request. It reads source rather than only `e2e/trails.ts`, because a
 * slug reaches a `page.goto` two ways: through a declared constant, or typed in place. Reading
 * only the declarations measures the declarations.
 */

const workflow = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const specDir = fileURLToPath(new URL('../e2e', import.meta.url));

/** Opts a slug out of the declaration, on the line above the one naming it. */
const EXEMPT = 'not-in-suite:';

/**
 * The exemptions that exist, pinned. Adding one is a failure somebody has to argue for, which is
 * the point: an unbounded opt-out is a gate that discriminates on nothing. Held without a line
 * number so that editing the file above it is not a false alarm.
 */
const EXEMPTED = ['offline.spec.ts  mount-dickerman-trail'];

interface Workflow {
  jobs?: Record<string, { steps?: Array<{ run?: string }> }>;
}

/** Every `run:` block in `ci.yml`, whichever job it belongs to. */
function runSteps(): string[] {
  const parsed = parse(readFileSync(workflow, 'utf8')) as Workflow;
  return Object.values(parsed.jobs ?? {}).flatMap((job) =>
    (job.steps ?? [])
      .map((step) => step.run)
      .filter((run): run is string => typeof run === 'string'),
  );
}

/**
 * The tile the workflow queries, read out of its own `--at` rather than restated here. Editing
 * the workflow to ingest somewhere else has to move the trails with it, or fail this file.
 */
function ingestedQuadkey(): string {
  // Every occurrence, not one per step: a `run: |` block is how a second ingest would actually
  // be added, and a non-global `exec` would count the two inside it as one. The coordinate is
  // matched on its own rather than through `ingest:tile .* --at`, so a newline or `--at=` between
  // them cannot make a tile that is there read as a tile that is not.
  const found = runSteps()
    .filter((run) => run.includes('ingest:tile'))
    .flatMap((run) => [...run.matchAll(/--at[=\s]+(-?[\d.]+),(-?[\d.]+)/gu)]);
  expect(found.length, 'ci.yml must ingest exactly one tile').toBe(1);

  // `--at` is lat,lng — the order every map app shows — and everything downstream is lng/lat.
  const [lat, lng] = [Number(found[0]![1]), Number(found[0]![2])];
  return tileToQuadkey(lngLatToTile(lng, lat, INGEST_ZOOM));
}

/** Every exported constant that names a trail, so a new one cannot be added undeclared. */
function declaredSlugs(): string[] {
  return Object.values(trails).flatMap((value) =>
    typeof value === 'object' && value !== null && 'slug' in value ? [value.slug] : [],
  );
}

/**
 * Every trail slug named in `e2e/` source, by either route a spec can take: the first segment
 * after `/trails/`, and the string a `slug:` property is given. The second is what catches a
 * constant declared beside the Playwright harness rather than in `trails.ts`.
 *
 * Recursive, because `playwright.config.ts` points `testDir` at `e2e/` and its default
 * `testMatch` is recursive — a spec in a subdirectory runs, so it has to be read.
 */
function slugSites(): Array<{ where: string; slug: string; exempt: boolean }> {
  const patterns = [/\/trails\/([a-z0-9-]+)/gu, /\bslug:\s*['"]([a-z0-9-]+)['"]/gu];
  return readdirSync(specDir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith('.ts'))
    .flatMap((name) => {
      const file = name.replaceAll('\\', '/');
      const lines = readFileSync(`${specDir}/${name}`, 'utf8').split('\n');
      return lines.flatMap((line, index) =>
        patterns.flatMap((pattern) =>
          [...line.matchAll(pattern)].map((match) => ({
            where: `${file}  ${String(match[1])}`,
            slug: String(match[1]),
            exempt: (lines[index - 1] ?? '').includes(EXEMPT),
          })),
        ),
      );
    });
}

describe('the trails the browser suite opens', () => {
  it('each say where a CI run gets them', () => {
    const sourced = new Set(trails.SUITE_TRAILS.map((trail) => trail.slug));
    expect(sourced.size).toBeGreaterThan(0);
    expect(declaredSlugs().sort()).toEqual([...sourced].sort());
  });

  it('are seeded when the ingested tile does not hold them', () => {
    const seeded = trails.SUITE_TRAILS.filter((trail) => trail.from === 'seeded').map(
      (trail) => trail.slug,
    );
    // Both directions: a fixture nothing opens is dead weight in a script that runs on every
    // nightly, and a spec opening a fixture nothing writes is the failure this file is about.
    expect(seeded.sort()).toEqual(SHAPES.map((shape) => shape.slug).sort());
  });

  it('keep the ingested one on the tile ci.yml still queries', () => {
    // A tripwire on the workflow's `--at` moving, not proof that the trail is inside the tile —
    // only OSM could say that, and this suite makes no query. What it catches is the two drifting
    // apart, which is how a sheet spec would start opening on ground nobody ingested.
    const quadkey = ingestedQuadkey();
    const ingested = trails.SUITE_TRAILS.filter((trail) => trail.from === 'ingested');
    expect(ingested.length).toBeGreaterThan(0);

    for (const trail of ingested) {
      const [lng, lat] = trail.at;
      expect(tileToQuadkey(lngLatToTile(lng, lat, INGEST_ZOOM)), trail.slug).toBe(quadkey);
    }
  });

  it('include every slug the specs name, however it is written', () => {
    const sites = slugSites();
    const live = sites.filter((site) => !site.exempt);
    // Over the live population, not the whole scan: with one exemption and one hard-coded slug
    // this assertion once passed over nothing at all, and read as though it had checked.
    expect(live.length, 'the scan found no unexempt slug').toBeGreaterThanOrEqual(
      trails.SUITE_TRAILS.length,
    );

    const declared = new Set(trails.SUITE_TRAILS.map((trail) => trail.slug));
    const undeclared = live.filter((site) => !declared.has(site.slug)).map((site) => site.where);
    expect(undeclared, 'add it to SUITE_TRAILS in e2e/trails.ts').toEqual([]);
  });

  it('are exempted only where the exemption is already argued for', () => {
    const exempted = slugSites().filter((site) => site.exempt);
    expect(
      [...new Set(exempted.map((site) => site.where))].sort(),
      `a new ${EXEMPT} needs a case made for it here`,
    ).toEqual([...EXEMPTED].sort());
  });
});

/**
 * The remedy a spec prints when its trail is missing. Wrong advice here is not cosmetic: it sends
 * the reader to reseed a database, or to spend a minute on Overpass, for a trail the other command
 * owns.
 */
describe('what a missing trail tells the reader to run', () => {
  it('sends a seeded fixture to the fixture seed', () => {
    expect(trails.missingTrailAdvice(trails.REPORT_TRAIL.slug)).toContain('db:seed:e2e');
  });

  it('sends an ingested trail to the tile ingest instead', () => {
    const advice = trails.missingTrailAdvice(trails.VESPER.slug);
    expect(advice).toContain('ingest:tile');
    expect(advice).not.toContain('db:seed:e2e');
  });

  it('sends a slug it has never heard of down the ingest path, not the seed one', () => {
    // The safe default: `db:seed:e2e` writes three known rows and would not produce it, so
    // offering that would be advice guaranteed not to work.
    expect(trails.missingTrailAdvice('mount-dickerman-trail')).toContain('ingest:tile');
  });
});
