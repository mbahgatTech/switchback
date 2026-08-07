import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The deploy path's three silent-failure modes, each pinned to something a revert breaks.
 *
 * All three were live at once. The federated credential was written against
 * `repo:<owner>/<repo>:ref:refs/heads/master` while GitHub issues an immutable subject built from
 * numeric ids, so `azure/login` could never have succeeded. The job declared `environment:
 * production`, which replaces the ref suffix and would have broken it a second way. And the
 * heartbeat the deploy waits for named no build, so from the second deploy onward any host
 * already running the current `health.ts` satisfied it — including one still serving the previous
 * package.
 *
 * None of that is reachable from a branch: `worker-deploy` runs on pushes to master only, so the
 * first evidence would have been a red master and a Function App left on whatever a human last
 * pushed. These assertions run on every push instead.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const ci = parse(readFileSync(`${repoRoot}/.github/workflows/ci.yml`, 'utf8')) as Workflow;
const bicep = readFileSync(`${repoRoot}/infra/azure/ingest.bicep`, 'utf8');
const deployScript = readFileSync(`${repoRoot}/.github/scripts/deploy-worker.sh`, 'utf8');

interface Job {
  needs?: string[];
  environment?: unknown;
  permissions?: Record<string, string>;
  steps?: Array<{ name?: string; run?: string; uses?: string }>;
}
interface Workflow {
  jobs: Record<string, Job>;
}

const workerDeploy = ci.jobs['worker-deploy']!;
const worker = ci.jobs.worker!;

describe('the schema lands before the code that reads it', () => {
  it('waits for the migrate job as well as the gates and the bundle', () => {
    expect(workerDeploy.needs).toEqual(expect.arrayContaining(['gates', 'worker', 'migrate']));
  });
});

describe('the subject the deploy credential is written against', () => {
  /*
   * Two halves, and each was wrong in a different way. The prefix is what GitHub stamps on every
   * token this repository mints; the suffix is what the *job* determines, and naming an
   * environment silently rewrites it.
   */
  it('takes its prefix from a parameter the CI check reads back', () => {
    expect(bicep).toMatch(/^param workerDeploySubjectPrefix string = 'repo:.+'$/m);
    expect(bicep).toContain("subject: '${workerDeploySubjectPrefix}:ref:refs/heads/master'");
  });

  it('is not rewritten by a GitHub environment on the job that presents it', () => {
    expect(workerDeploy.environment).toBeUndefined();
  });

  it('is checked against a freshly minted token on every push, not only on master', () => {
    const step = worker.steps?.find((s) => s.run?.includes('assert-oidc-subject.sh'));
    expect(step).toBeDefined();
    expect(worker.permissions?.['id-token']).toBe('write');
  });
});

/**
 * The check runs the real script rather than reading its text: a script that cannot start is
 * invisible to every other gate, and this one is only ever exercised on a runner.
 */
describe('the subject check itself', () => {
  function run(env: Record<string, string>, argsTemplate?: string) {
    return spawnSync('bash', ['.github/scripts/assert-oidc-subject.sh'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ACTIONS_ID_TOKEN_REQUEST_URL: '',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: '',
        TEMPLATE: argsTemplate ?? 'infra/azure/ingest.bicep',
        ...env,
      },
    });
  }

  it('finds the expected prefix in the template', () => {
    const result = run({ GITHUB_EVENT_NAME: 'pull_request' });
    expect(result.stdout).toMatch(/expected prefix: repo:/);
    expect(result.status).toBe(0);
  });

  it('fails rather than passes when the job cannot mint a token on a push', () => {
    const result = run({ GITHUB_EVENT_NAME: 'push' });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain("lost 'permissions: id-token: write'");
  });

  it('fails rather than passes when the template has no prefix to compare against', () => {
    const result = run({ GITHUB_EVENT_NAME: 'push' }, 'package.json');
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('nothing to compare against');
  });
});

describe('the heartbeat the deploy waits for', () => {
  it('names the commit being deployed, so a stale host cannot satisfy it', () => {
    expect(deployScript).toContain('HEARTBEAT="switchback-ingest-queue-health build=${COMMIT}"');
    const step = workerDeploy.steps?.find((s) => s.run?.includes('deploy-worker.sh'));
    expect(step?.run).toContain('$GITHUB_SHA');
  });

  it('establishes the Application Insights extension before it needs the query', () => {
    const install = workerDeploy.steps?.find((s) =>
      s.run?.includes('az extension add --name application-insights'),
    );
    expect(install).toBeDefined();
    // And the script refuses rather than waiting out its deadline on a runner without it.
    expect(deployScript).toContain("'az monitor app-insights' is unavailable");
  });
});
