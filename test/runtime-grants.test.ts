import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CONVERGE_GRANTS_SQL,
  GRANT_AUDIT_SQL,
  ungrantedTables,
} from '../scripts/converge-runtime-grants';

/**
 * `trail_ways` and `trail_slug_aliases` reached production owned by the migration identity, for
 * which no `ALTER DEFAULT PRIVILEGES` was ever registered, so `sbapp` held nothing on either and
 * `INGEST_TRAIL_IDENTITY=claim` failed every trail in a tile with `42501`. Nothing in the
 * repository could see it: the tables existed, the schema matched, and the only symptom was a
 * runtime error on a code path no gate reaches.
 *
 * So these hold the two halves that would each have prevented it — the convergence covering both
 * the tables already on the ground and the ones the next push creates, and the migrate job
 * actually invoking it.
 */

const ciWorkflow = fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url));

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  if?: string;
}

interface Workflow {
  jobs: Record<string, { steps: Step[] } | undefined>;
}

function migrateSteps(): Step[] {
  const parsed = parse(readFileSync(ciWorkflow, 'utf8')) as Workflow;
  return parsed.jobs.migrate?.steps ?? [];
}

describe('runtime grant convergence', () => {
  it('registers default privileges for the role that actually pushes the schema', () => {
    // The whole defect: the database carried this clause for `sbadmin` only, and CI pushes as
    // the other one.
    expect(CONVERGE_GRANTS_SQL).toMatch(
      /alter default privileges for role "id-switchback-postgres-ci" in schema public/i,
    );
  });

  it('also grants over the tables already on the ground', () => {
    // Default privileges are not retroactive, so registering them alone leaves `trail_ways`
    // exactly as broken as it was.
    expect(CONVERGE_GRANTS_SQL).toMatch(/grant .*on public\.%s to sbapp/i);
    expect(CONVERGE_GRANTS_SQL).toContain("o.rolname in ('sbadmin', 'id-switchback-postgres-ci')");
  });

  it('leaves PostGIS alone', () => {
    // `spatial_ref_sys` lives in `public` and is owned by `azuresu`. Scoping by owner rather than
    // by schema is what keeps the runtime role off it.
    expect(CONVERGE_GRANTS_SQL).not.toMatch(/on all tables in schema public/i);
    expect(GRANT_AUDIT_SQL).toContain('o.rolname = any($1::text[])');
  });

  it('audits every privilege the application uses', () => {
    for (const privilege of ['select', 'insert', 'update', 'delete']) {
      expect(GRANT_AUDIT_SQL).toContain(
        `has_table_privilege('sbapp', oid, '${privilege.toUpperCase()}')`,
      );
    }
  });

  it('reports a table the runtime role cannot fully use', () => {
    const rows = [
      { table_name: 'trails', select: true, insert: true, update: true, delete: true },
      { table_name: 'trail_ways', select: false, insert: false, update: false, delete: false },
    ];
    expect(ungrantedTables(rows)).toEqual(['trail_ways']);
  });

  it('reports a table missing only one privilege', () => {
    const rows = [
      { table_name: 'trail_slug_aliases', select: true, insert: false, update: true, delete: true },
    ];
    expect(ungrantedTables(rows)).toEqual(['trail_slug_aliases']);
  });

  it('reads anything that is not boolean true as denied', () => {
    // A driver answering `null` for a column it did not recognise must fail the job rather than
    // pass a truthiness test that never ran against the database.
    const rows = [{ table_name: 'photos', select: null, insert: 't', update: 1, delete: true }];
    expect(ungrantedTables(rows)).toEqual(['photos']);
  });

  it('passes a fully granted schema', () => {
    const rows = [{ table_name: 'trails', select: true, insert: true, update: true, delete: true }];
    expect(ungrantedTables(rows)).toEqual([]);
  });
});

describe("ci.yml's migrate job", () => {
  it('runs the convergence', () => {
    const invoked = migrateSteps().some((step) =>
      step.run?.includes('scripts/converge-runtime-grants.ts'),
    );
    expect(invoked).toBe(true);
  });

  it('runs it after the push, so the new tables exist to grant on', () => {
    const steps = migrateSteps();
    const push = steps.findIndex((step) => step.run?.includes('db:push'));
    const converge = steps.findIndex((step) =>
      step.run?.includes('scripts/converge-runtime-grants.ts'),
    );
    expect(push).toBeGreaterThanOrEqual(0);
    expect(converge).toBeGreaterThan(push);
  });

  it('runs it whether or not the schema changed', () => {
    // The database this repairs drifted under an earlier commit, so a convergence gated on
    // `schema.outputs.changed` would never run for the commit that adds it.
    const converge = migrateSteps().find((step) =>
      step.run?.includes('scripts/converge-runtime-grants.ts'),
    );
    expect(converge?.if).toBeUndefined();
  });

  it('logs in unconditionally, or the convergence has no token', () => {
    const login = migrateSteps().find((step) => step.uses?.startsWith('azure/login'));
    expect(login).toBeDefined();
    expect(login?.if).toBeUndefined();
  });
});
