import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { schemaChanged } from '../scripts/schema-changed';
import type { ChangedFiles } from '../scripts/schema-changed';

/**
 * The `migrate` job reconciles production's schema, and it is skipped when this says no. A false
 * negative is silent in CI and shows up as a deployment querying a column the database does not
 * have, which is what `packages/db/prisma/schema.prisma` adding `trail_ways` and
 * `trail_slug_aliases` would cost.
 */

const SCHEMA_FILE = 'packages/db/prisma/schema.prisma';
const OTHER_FILE = 'packages/ingest/src/pipeline.ts';
const ZEROS = '0'.repeat(40);

/** Records the range it was asked for, so the test can assert which one the detector picks. */
function recording(files: string[]): ChangedFiles & { ranges: string[] } {
  const ranges: string[] = [];
  const diff = (base: string, head: string) => {
    ranges.push(`${base}..${head}`);
    return files;
  };
  return Object.assign(diff, { ranges });
}

describe('the production schema detector', () => {
  it('runs the push when the schema is among the changed files', () => {
    const verdict = schemaChanged('base', 'head', recording([OTHER_FILE, SCHEMA_FILE]));
    expect(verdict.changed).toBe(true);
    expect(verdict.files).toEqual([SCHEMA_FILE]);
  });

  it('leaves production alone when nothing under the schema directory moved', () => {
    expect(schemaChanged('base', 'head', recording([OTHER_FILE])).changed).toBe(false);
  });

  it('asks about the whole push, not the last commit of it', () => {
    // The defect this replaced: `git diff HEAD^ HEAD`. A rebase merge lands every commit of a
    // pull request, so a schema change in any but the tip is invisible to that range.
    const diff = recording([]);
    schemaChanged('beforeSha', 'headSha', diff);
    expect(diff.ranges).toEqual(['beforeSha..headSha']);
  });

  it('runs the push when there is no base commit, as on a ref being created', () => {
    for (const base of [undefined, '', ZEROS]) {
      expect(schemaChanged(base, 'head', recording([OTHER_FILE])).changed).toBe(true);
    }
  });

  it('runs the push when the base is not in the clone', () => {
    // `db push` against a matching schema is a no-op, so guessing wrong this way costs nothing.
    expect(schemaChanged('pruned', 'head', () => null).changed).toBe(true);
  });
});

interface Workflow {
  jobs?: Record<
    string,
    { steps?: Array<{ run?: string; with?: Record<string, unknown>; uses?: string }> }
  >;
}

const migrate = (
  parse(
    readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8'),
  ) as Workflow
).jobs?.migrate;

describe('the migrate job', () => {
  it('hands the detector the commit the push started from', () => {
    const step = migrate?.steps?.find((s) => s.run?.includes('schema-changed.ts'));
    expect(step?.run, 'the step that decides whether to touch production').toBeDefined();
    expect(step!.run).toContain('github.event.before');
    expect(step!.run, 'HEAD^ describes one commit, not a push').not.toContain('HEAD^');
  });

  it('checks out enough history for that commit to be present', () => {
    const checkout = migrate?.steps?.find((s) => s.uses?.startsWith('actions/checkout'));
    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
});
