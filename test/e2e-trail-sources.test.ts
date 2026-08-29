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
 * So each trail declares where CI gets it, and every claim is checked here — in `gates`, which
 * runs on every push and every pull request. `e2e/trails.ts` holds nothing but those
 * declarations precisely so this file can read them without Playwright's runner.
 */

const workflow = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));
const specDir = fileURLToPath(new URL('../e2e', import.meta.url));

/**
 * Opts one hard-coded slug out of the declaration, on its own line or the one above it.
 * `offline.spec.ts` needs it: its subject is the page for a trail that was never downloaded,
 * which stops being the subject the moment the trail exists.
 */
const EXEMPT = 'not-in-suite:';

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
  const found = runSteps()
    .map((run) => /ingest:tile\b.*--at\s+(-?[\d.]+),(-?[\d.]+)/u.exec(run))
    .filter((match) => match !== null);
  // Exactly one, not the first of several: a second tile would leave every check below describing
  // a workflow that had grown past it, and passing while it did.
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

/** Every `/trails/<slug>` written as a literal under `e2e/`, and whether its line opts out. */
function hardCodedSlugs(): Array<{ where: string; slug: string; exempt: boolean }> {
  const literal = /['`]\/trails\/([a-z0-9-]+)['`]/gu;
  return readdirSync(specDir)
    .filter((name) => name.endsWith('.ts'))
    .flatMap((name) => {
      const lines = readFileSync(`${specDir}/${name}`, 'utf8').split('\n');
      return lines.flatMap((line, index) =>
        [...line.matchAll(literal)].map((match) => ({
          where: `${name}:${index + 1}`,
          slug: String(match[1]),
          exempt: line.includes(EXEMPT) || (lines[index - 1] ?? '').includes(EXEMPT),
        })),
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

  it('are inside the one tile CI ingests when they are not seeded', () => {
    const quadkey = ingestedQuadkey();
    const ingested = trails.SUITE_TRAILS.filter((trail) => trail.from === 'ingested');
    expect(ingested.length).toBeGreaterThan(0);

    for (const trail of ingested) {
      const [lng, lat] = trail.at;
      expect(tileToQuadkey(lngLatToTile(lng, lat, INGEST_ZOOM)), trail.slug).toBe(quadkey);
    }
  });

  it('include the ones a spec writes as a literal rather than importing', () => {
    // Without this the three cases above measure the declaration rather than the suite, and a
    // slug typed straight into a `page.goto` is invisible to all of them — which is the shape
    // greider-lakes-trail would have had if it had never been given a constant.
    const found = hardCodedSlugs();
    expect(found.length, 'no `/trails/<slug>` literal found under e2e/').toBeGreaterThan(0);

    const declared = new Set(trails.SUITE_TRAILS.map((trail) => trail.slug));
    const undeclared = found
      .filter((hit) => !hit.exempt && !declared.has(hit.slug))
      .map((hit) => `${hit.where}  ${hit.slug}`);
    expect(undeclared, `declare it in e2e/trails.ts, or open the line with "${EXEMPT}"`).toEqual(
      [],
    );
  });
});
