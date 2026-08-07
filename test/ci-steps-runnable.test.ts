import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * A step whose command cannot start is invisible to every other gate: `typecheck`, `lint`,
 * `format:check` and the rest of this suite all read files, and a script quoted inside a YAML
 * `run:` block is a string. The migrate job carried one for as long as it took a schema change to
 * arrive — `tsx -e` transforms through esbuild to CommonJS, where the probe's three top-level
 * `await`s are unrepresentable, so run 31168985274 died on `Top-level await is currently not
 * supported with the "cjs" output format` before a line of it executed, taking `db push` and the
 * production deploy with it.
 *
 * So these run the commands, and prove they started by watching for output the script itself
 * emits. Asserting on the text of the YAML, or on the shape of an error message, would measure
 * something adjacent to the defect rather than the defect.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const workflowDir = fileURLToPath(new URL('../.github/workflows', import.meta.url));

/** Printed by a prologue spliced onto each harvested script. Absent means it never began. */
const STARTED = 'switchback-ci-step-started';

/** A shell fragment lifted out of a workflow, with enough provenance to name it in a failure. */
interface Invocation {
  workflow: string;
  step: string;
  /** Runnable as-is under `bash -c`, from the repository root. */
  command: string;
}

interface Workflow {
  jobs?: Record<string, { steps?: Array<{ name?: string; run?: string }> }>;
}

function workflowFiles(): string[] {
  return readdirSync(workflowDir).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));
}

function steps(workflow: string): Array<{ name: string; run: string }> {
  const parsed = parse(readFileSync(`${workflowDir}/${workflow}`, 'utf8')) as Workflow;
  return Object.entries(parsed.jobs ?? {}).flatMap(([job, definition]) =>
    (definition.steps ?? [])
      .filter((step): step is { name?: string; run: string } => typeof step.run === 'string')
      .map((step, index) => ({ name: step.name ?? `${job}[${index}]`, run: step.run })),
  );
}

/**
 * Every inline eval in every workflow, each with a prologue spliced in front of it.
 *
 * The quoting is left exactly as written and the splice is a second quoted word: `bash` joins
 * adjacent quoted words into one argument, so the runner receives the prologue and the original
 * script under the original quoting rules. A prologue cannot rescue a script that fails to parse
 * — both runners parse the whole argument before executing any of it — which is what makes the
 * marker proof rather than decoration.
 */
function inlineEvals(): Invocation[] {
  const pattern =
    /(?:^|[|&;\s])((?:\S*[/\\])?(?:node|tsx|ts-node))\s+(?:-e|--eval)\s+('[^']*'|"[^"]*")/g;
  return workflowFiles().flatMap((workflow) =>
    steps(workflow).flatMap(({ name, run }) =>
      [...run.matchAll(pattern)].map(([, runner, code]) => ({
        workflow,
        step: name,
        command: `${runner} -e 'process.stderr.write("${STARTED}\\n");'${code}`,
      })),
    ),
  );
}

/** Run a workflow fragment through the shell that would run it, with nothing to reach. */
function runFragment(command: string, env: NodeJS.ProcessEnv): { output: string; status: number } {
  const result = spawnSync('bash', ['-c', command], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    env,
  });
  if (result.error) throw result.error;
  return { output: `${result.stdout}${result.stderr}`, status: result.status ?? -1 };
}

/** The ambient environment minus anything that would let a fragment reach a real service. */
function sandboxEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of ['DATABASE_URL', 'DIRECT_DATABASE_URL', 'GITHUB_ENV', 'GITHUB_OUTPUT']) {
    delete env[key];
  }
  return env;
}

describe('every inline eval a workflow runs', () => {
  const evals = inlineEvals();

  it('finds them', () => {
    // A harvest that silently matched nothing would make every case below vacuous.
    expect(evals.length).toBeGreaterThan(0);
  });

  it.each(evals.map((invocation, index) => ({ ...invocation, index })))(
    '$workflow › $step ($index) starts',
    ({ command }) => {
      expect(runFragment(command, sandboxEnv()).output).toContain(STARTED);
    },
  );
});

/**
 * The step that blocks the deploy. Read out of `ci.yml` rather than named here, so reverting that
 * file to the inline probe fails this case instead of leaving it measuring a command nobody runs.
 */
function administratorProbe(): Invocation {
  const step = steps('ci.yml').find((candidate) =>
    candidate.name.startsWith('Prove the token connects'),
  );
  expect(step, 'ci.yml has no step named "Prove the token connects…"').toBeDefined();

  // From the first line that *starts* with a runner to the end of the block: one line once the
  // probe is a file, the whole quoted script while it is not.
  const match = /^[ \t]*(?:\S*[/\\])?(?:node|tsx|ts-node)\b/m.exec(step!.run);
  expect(match, `no runner invocation in:\n${step!.run}`).not.toBeNull();

  return { workflow: 'ci.yml', step: step!.name, command: step!.run.slice(match!.index) };
}

describe('the administrator probe the migrate job runs', () => {
  it('executes, and says which variable it wanted', () => {
    const { output, status } = runFragment(administratorProbe().command, sandboxEnv());

    // Its own first branch, reached: proof the probe ran rather than failing in the transform.
    expect(output).toContain('DIRECT_DATABASE_URL is not set');
    expect(status).toBe(1);
  });
});
