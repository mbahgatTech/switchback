import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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
   *
   * The prefix pattern is the immutable form — `owner@<ownerId>/repo@<repoId>` — because that is
   * what this repository was measured to issue and `repo:<owner>/<repo>` is what the credential
   * wrongly carried. `.github/scripts/assert-oidc-subject.sh` is what compares it against a real
   * token; this only holds the shape, so the two cannot silently swap back.
   */
  it('takes its prefix from a parameter the CI check reads back', () => {
    expect(bicep).toMatch(
      /^param workerDeploySubjectPrefix string = 'repo:[^/@']+@\d+\/[^/@']+@\d+'$/m,
    );
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

const STORAGE = 'stfake';
const scratch = () => mkdtempSync(path.join(tmpdir(), 'deploy-worker-'));

/** A stub `az` that records every invocation and answers the queries the script makes. */
function stubAz(
  dir: string,
  {
    heartbeats = '1',
    uploadedBytes = '',
    settingsWritesLand = true,
    startWorks = true,
    stopsDuringWait = false,
    syncFails = false,
  },
) {
  const at = dir.replace(/\\/g, '/');
  writeFileSync(
    path.join(dir, 'az'),
    `#!/usr/bin/env bash
echo "$@" >>"${at}/argv"
args="$*"
case "$args" in
  *"account show"*) echo 00000000-0000-0000-0000-000000000000 ;;
  ${/* What ARM answers when it proxies the call to a host that is not serving. */ ''}
  *syncfunctiontriggers*)
    ${syncFails ? `printf '%s\\n' 'ERROR: Bad Request({"Code":"Unauthorized","Message":"Encountered an error (Forbidden) from extensions API."})' >&2; exit 1` : ':'} ;;
  *"functionapp show"*) cat "${at}/state" ;;
  ${/* `:` is a start that reports success and leaves the host down. */ ''}
  *"functionapp start"*) ${startWorks ? `echo Running >"${at}/state"` : ':'} ;;
  *"appsettings list"*) cat "${at}/setting" 2>/dev/null ;;
  *"appsettings set"*)
    ${settingsWritesLand ? '' : 'exit 0 # the write silently does not land\n    '}for a in "$@"; do
      case "$a" in WEBSITE_RUN_FROM_PACKAGE=*) echo "\${a#WEBSITE_RUN_FROM_PACKAGE=}" >"${at}/setting" ;; esac
    done ;;
  *"blob show"*) echo "${uploadedBytes}" ;;
  *"app-insights query"*)
    ${stopsDuringWait ? `echo Stopped >"${at}/state"` : ':'}
    echo "${heartbeats}" ;;
esac
exit 0
`,
    'utf8',
  );
  chmodSync(path.join(dir, 'az'), 0o755);
}

function deploy(
  overrides: Parameters<typeof stubAz>[1] & { bundle?: string; appState?: string } = {},
) {
  const dir = scratch();
  const bundle = path.join(dir, 'ingest-worker.zip');
  writeFileSync(bundle, overrides.bundle ?? 'x'.repeat(64));
  const size = String((overrides.bundle ?? 'x'.repeat(64)).length);
  stubAz(dir, { uploadedBytes: size, ...overrides });
  writeFileSync(path.join(dir, 'state'), `${overrides.appState ?? 'Running'}\n`);
  writeFileSync(
    path.join(dir, 'setting'),
    'https://old.blob.core.windows.net/c/old.zip?sig=REDACTED\n',
  );
  const result = spawnSync('bash', ['.github/scripts/deploy-worker.sh', bundle, 'c0ffee'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      STORAGE_ACCOUNT: STORAGE,
      HEARTBEAT_TIMEOUT_S: '0',
      START_TIMEOUT_S: '0',
    },
  });
  return {
    ...result,
    argv: readFileSync(path.join(dir, 'argv'), 'utf8'),
    setting: readFileSync(path.join(dir, 'setting'), 'utf8').trim(),
  };
}

/** Where a command lands in the recorded argv, or -1 when it was never run. */
function order(argv: string, fragment: string): number {
  return argv.split('\n').findIndex((line) => line.includes(fragment));
}

/**
 * How the package reaches the app, exercised rather than read.
 *
 * `az functionapp deployment source config-zip` picks between uploading a blob and a Kudu
 * `/api/zipdeploy` by reading the plan to see whether it is Consumption, inside a bare `except:`.
 * The deploy identity is Website Contributor on the *site* and cannot read the plan, so the lookup
 * is swallowed, the Kudu fallback is taken, and the platform refuses it with 409 — a site running
 * from an external package URL cannot also be extracted into. It succeeds for an operator who can
 * read the plan, so the failure is invisible everywhere except a push to master.
 *
 * These run the real script against a stub `az` that records its argv, which is the only way to
 * assert on a path whose live form is one production Function App.
 */
describe('the mechanism the deploy uses', () => {
  it('uploads the bundle to function-releases rather than calling config-zip', () => {
    const { status, argv, stdout, stderr } = deploy({});
    expect(stdout + stderr).not.toContain('command not found');
    expect(argv).toContain('storage blob upload');
    expect(argv).toContain('--container-name function-releases');
    expect(argv).not.toContain('deployment source config-zip');
    expect(status).toBe(0);
  });

  it('points the app at a bare blob URL, with no SAS to expire or redact', () => {
    const { setting } = deploy({});
    expect(setting).toMatch(
      new RegExp(
        `^https://${STORAGE}\\.blob\\.core\\.windows\\.net/function-releases/c0ffee-\\d{8}T\\d{6}Z\\.zip$`,
      ),
    );
    expect(setting).not.toContain('?');
  });

  it('syncs the trigger cache, without which a Consumption app never wakes', () => {
    expect(deploy({}).argv).toContain('syncfunctiontriggers');
  });

  it('fails on a short upload rather than waiting out the heartbeat deadline', () => {
    const { status, stdout, stderr, argv } = deploy({ uploadedBytes: '11', appState: 'Stopped' });
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('The upload was truncated');
    expect(argv).not.toContain('appsettings set');
    // The upload and its size read answer the same on a stopped host, so they run before the
    // start — a bad bundle must not lift a brake somebody pulled on purpose.
    expect(argv).not.toContain('functionapp start');
  });

  it('fails when the settings write does not land', () => {
    const { status, stdout, stderr } = deploy({ settingsWritesLand: false });
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('The settings write did not land');
  });

  it('fails when no heartbeat naming the commit arrives', () => {
    const { status, stdout, stderr } = deploy({ heartbeats: '0' });
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('no heartbeat naming c0ffee');
  });
});

/**
 * A stopped host is a state an operator is told to produce — `az functionapp stop` is the last of
 * the three brakes — and `worker-deploy` fires on every push to master.
 *
 * The order is what run 31301084801 cost. The settings write landed against a Stopped host, the
 * trigger sync was then refused with `Unauthorized … Forbidden from extensions API` because ARM
 * proxies that call to the host's own endpoint, and `set -e` ended the run before the start it was
 * carrying two steps further down — leaving `WEBSITE_RUN_FROM_PACKAGE` naming a build the host was
 * not up to run. Nothing in the script asserted the order, so nothing caught it.
 */
describe('a deploy that arrives while the host is stopped', () => {
  it('starts it before naming the new package or reaching the extensions API', () => {
    const { status, argv, stdout } = deploy({ appState: 'Stopped' });
    expect(stdout).toContain('the host is Stopped; starting it');
    expect(order(argv, 'functionapp start')).toBeGreaterThanOrEqual(0);
    expect(order(argv, 'functionapp start')).toBeLessThan(order(argv, 'appsettings set'));
    expect(order(argv, 'functionapp start')).toBeLessThan(order(argv, 'syncfunctiontriggers'));
    expect(status).toBe(0);
  });

  it('leaves a running host alone', () => {
    expect(deploy({}).argv).not.toContain('functionapp start');
  });

  it('leaves the app on its previous package when the host will not come up', () => {
    const { status, stdout, stderr, argv, setting } = deploy({
      appState: 'Stopped',
      startWorks: false,
    });
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('the host failing to start, not a bad build');
    expect(argv).not.toContain('appsettings set');
    expect(argv).not.toContain('syncfunctiontriggers');
    expect(setting).toContain('old.zip');
    // And it says so before the wait, rather than twelve minutes into it.
    expect(argv).not.toContain('app-insights query');
  });

  it('blames the package when a running host emits nothing', () => {
    const { status, stdout, stderr } = deploy({ heartbeats: '0' });
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('the package did not mount');
  });

  it('blames the host when a brake is pulled during the wait', () => {
    const { status, stdout, stderr } = deploy({ heartbeats: '0', stopsDuringWait: true });
    expect(status).toBe(1);
    expect(stdout + stderr).toContain('it was stopped during the wait');
  });
});

/**
 * The refusal that ended run 31301084801 arrived as `ERROR: Bad Request({"Code":"Unauthorized"…})`
 * and nothing else — no `::error::`, no annotation, no mention of the host. Naming the mechanism is
 * the difference between a log a reader can act on and one that sends them to the deploy identity's
 * role assignments, which were never the problem.
 */
describe('a trigger sync the extensions API refuses', () => {
  it('names the mechanism and surfaces what az actually said', () => {
    const { status, stdout, stderr } = deploy({ syncFails: true });
    const output = stdout + stderr;
    expect(status).toBe(1);
    expect(output).toContain('syncfunctiontriggers was refused');
    expect(output).toContain('nothing will wake the package');
    expect(output).toContain("proxies to the host's own extensions");
    expect(output).toContain('ERROR: Bad Request({"Code":"Unauthorized"');
  });

  it('does not wait out the heartbeat deadline first', () => {
    expect(deploy({ syncFails: true }).argv).not.toContain('app-insights query');
  });
});

/**
 * The two grants that make the mechanism above possible, and the container they are scoped to.
 * Without the first the host cannot fetch its own package without a SAS; without the second the
 * deploy identity cannot upload one at all.
 */
describe('the package container and its grants', () => {
  it('is declared, so the grants have a scope narrower than the storage account', () => {
    expect(bicep).toContain(
      "resource releases 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01'",
    );
    expect(bicep).toContain("name: '${storage.name}/default/function-releases'");
  });

  it("lets the host read its own package with the app's identity instead of a SAS", () => {
    expect(bicep).toContain(
      "var storageBlobDataReaderRoleId = '2a2b9908-6ea1-4ae2-8e65-a410df84e7d1'",
    );
    expect(bicep).toMatch(
      /resource functionAppPackageRead[\s\S]*?scope: releases[\s\S]*?storageBlobDataReaderRoleId[\s\S]*?principalId: functionApp\.identity\.principalId/,
    );
  });

  it('lets the deploy identity upload one over Entra rather than the account key', () => {
    expect(bicep).toContain(
      "var storageBlobDataContributorRoleId = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'",
    );
    expect(bicep).toMatch(
      /resource workerDeployerPackageWrite[\s\S]*?scope: releases[\s\S]*?storageBlobDataContributorRoleId[\s\S]*?principalId: workerDeployer\.properties\.principalId/,
    );
  });
});
