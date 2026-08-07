import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * `cancel-in-progress` is on because a deploy hook ships the tip of its branch rather than the
 * commit that called it, so a superseded push must not sit polling `/api/version` for a SHA that
 * no longer exists. The cost of that is a workflow-wide cancel, and the browser suite runs on the
 * same ref: a `workflow_dispatch` two minutes after a merge cancelled that merge's `production
 * schema` and `deploy production` and left production a commit behind master (runs 30736300054
 * and 30736380574). What keeps the two apart is the event in the concurrency key.
 */

interface Workflow {
  on?: Record<string, unknown>;
  concurrency?: { group?: string; 'cancel-in-progress'?: boolean };
  jobs?: Record<string, { if?: string }>;
}

const ci = parse(
  readFileSync(fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)), 'utf8'),
) as Workflow;

/** The events that can start this workflow at all. */
const TRIGGERS = Object.keys(ci.on ?? {});

/**
 * The events a job's guard admits. A job with no guard runs on every trigger, and a guard that
 * tests something other than the event name is read the same way — the set is an upper bound on
 * what can actually run, which is what makes disjointness below sound rather than convenient.
 */
function admittedEvents(guard: string | undefined): string[] {
  if (guard === undefined) return TRIGGERS;
  const named = [...guard.matchAll(/github\.event_name\s*==\s*'([a-z_]+)'/g)].map(([, event]) =>
    String(event),
  );
  return named.length > 0 ? named : TRIGGERS;
}

describe('the CI concurrency key', () => {
  it('reads the workflow', () => {
    expect(TRIGGERS).toEqual(expect.arrayContaining(['push', 'schedule', 'workflow_dispatch']));
    expect(Object.keys(ci.jobs ?? {})).toEqual(
      expect.arrayContaining(['gates', 'browser', 'migrate', 'deploy']),
    );
  });

  it('cancels a superseded run, because the deploy hook ships a branch tip', () => {
    expect(ci.concurrency?.['cancel-in-progress']).toBe(true);
  });

  it('separates runs by event as well as by ref', () => {
    const group = ci.concurrency?.group ?? '';
    expect(group, 'concurrency.group').toContain('github.ref');
    expect(group, 'concurrency.group').toContain('github.event_name');
  });

  it('never lets the browser suite and the production deploy share a run', () => {
    const browser = admittedEvents(ci.jobs?.browser?.if);
    const shipping = ['migrate', 'deploy'].flatMap((job) => admittedEvents(ci.jobs?.[job]?.if));

    expect(browser.length).toBeGreaterThan(0);
    expect(shipping.length).toBeGreaterThan(0);
    expect(
      browser.filter((event) => shipping.includes(event)),
      'events that start both the browser suite and a production deploy',
    ).toEqual([]);
  });
});
