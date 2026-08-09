import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The smoke test the production deploy ends on, held to what the architecture actually promises.
 *
 * Ingestion is on demand: nothing is seeded, tiles fill when a reader opens ground, and the corpus
 * has been wiped once already. So a route naming one trail asserts a fact about history rather than
 * about the deployment. `/trails/llanberis-path` sat in this list expecting 200 and failed run
 * 31301084801 against a web tier that had deployed perfectly — every other route 200,
 * `/api/version` reporting the pushed commit, and one 404 that was the correct answer. On an
 * on-demand design there is no re-ingest that reliably brings that trail back, so the assertion had
 * to stop depending on a particular row.
 *
 * A trail route still belongs here, because a lookup is what proves Postgres answered at all —
 * `trails.bySlug` queries `trails` and falls through to `trail_slug_aliases`, so an unreachable
 * schema is a 500 and only a schema that answered "no such row" is a 404.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

interface Workflow {
  jobs: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
}

const ci = parse(readFileSync(`${repoRoot}/.github/workflows/ci.yml`, 'utf8')) as Workflow;
const smoke = ci.jobs.deploy?.steps?.find((step) => step.name === 'Smoke-test the live site')?.run;

/** Executable lines of the step that name a trail route. Comments are not assertions. */
function trailLines(): string[] {
  return (smoke ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('/trails/') && !line.startsWith('#'));
}

describe('the production smoke test', () => {
  it('is the last thing the production deploy does', () => {
    expect(smoke).toBeTypeOf('string');
  });

  it('exercises a trail route, so an unreachable schema cannot pass as healthy', () => {
    expect(trailLines()).not.toHaveLength(0);
  });

  it('demands a miss, so no particular trail has to have been ingested', () => {
    for (const line of trailLines()) {
      expect(line).toMatch(/^check 404 \/trails\/\S+$/);
    }
  });

  it('checks the routes that serve without any corpus at all', () => {
    for (const path of ['/', '/explore', '/nearby', '/attribution', '/manifest.webmanifest']) {
      expect(smoke).toContain(path);
    }
  });
});
