import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  countMermaidBlocks,
  gitCommitTree,
  mermaidTargets,
  type CommitTree,
} from '../scripts/check-mermaid-github';

/**
 * The GitHub check loads `https://github.com/<slug>/blob/<ref>/<path>` for each file it decides
 * to check. Deciding that from anything other than `ref` asks for blobs that are not there, and
 * a 404 renders no diagram — reported as `0/N rendered`, which reads as broken documentation.
 * Pull requests 77, 82 and 83 were all red on it at once while every diagram in them was fine.
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

function git(args: string[], stdin?: string): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', input: stdin }).trim();
}

/** A commit that holds exactly what it is given. */
function tree(files: Record<string, string>): CommitTree {
  return {
    paths: () => Object.keys(files),
    read: (path) => files[path] ?? '',
  };
}

const DIAGRAM = '# Title\n\n```mermaid\nflowchart LR\n  a --> b\n```\n';

/**
 * A real tree object holding one file, built with plumbing so it belongs to no commit and no
 * branch and nothing is written to the working tree. The file it holds provably exists nowhere on
 * disk, which is what makes it a clean subject.
 *
 * A tree rather than a commit because `commit-tree` demands a committer identity, and a CI runner
 * has none configured — `git ls-tree` and `git show` take any tree-ish.
 */
function treeHolding(name: string, body: string): string {
  const blob = git(['hash-object', '-w', '--stdin'], body);
  return git(['mktree'], `100644 blob ${blob}\t${name}\n`);
}

describe('counting the Mermaid blocks in a file', () => {
  it('counts one opening fence per block', () => {
    expect(countMermaidBlocks(`${DIAGRAM}\n${DIAGRAM}`)).toBe(2);
  });

  it('is zero for prose, so the file is never loaded', () => {
    expect(countMermaidBlocks('# Title\n\nNo diagrams here.\n')).toBe(0);
  });

  it('does not count a fence of another language, or the word alone', () => {
    expect(countMermaidBlocks('```ts\nconst mermaid = 1;\n```\nmermaid\n')).toBe(0);
  });
});

describe('choosing which files to check', () => {
  it('takes the markdown that carries a block', () => {
    const targets = mermaidTargets(tree({ 'docs/architecture.md': DIAGRAM }));
    expect(targets).toEqual([{ path: 'docs/architecture.md', expected: 1 }]);
  });

  it('leaves out markdown without a block, and everything that is not markdown', () => {
    const commit = tree({
      'README.md': '# no diagrams\n',
      'docs/architecture.md': DIAGRAM,
      'scripts/check-mermaid-github.ts': '```mermaid',
    });
    expect(mermaidTargets(commit).map((target) => target.path)).toEqual(['docs/architecture.md']);
  });
});

/**
 * Both directions of the same rule, because only pinning one of them leaves the defect
 * reachable: a `paths().filter(existsSync)` — the commit intersected with the checkout — still
 * excludes a file that is only on disk, and would silently restore the half where a diagram the
 * commit carries is never loaded at all.
 */
describe('reading a commit out of the clone', () => {
  const probeDir = `${REPO_ROOT}tmp`;
  const onDiskOnly = `${probeDir}/mermaid-target-probe.md`;

  afterEach(() => {
    rmSync(onDiskOnly, { force: true });
    // `tmp/` is also the local tile cache. Removed only when this test is what created it.
    if (existsSync(probeDir) && readdirSync(probeDir).length === 0) rmdirSync(probeDir);
  });

  it('leaves out a file the checkout has and the commit does not', () => {
    mkdirSync(probeDir, { recursive: true });
    writeFileSync(onDiskOnly, DIAGRAM, 'utf8');

    const paths = mermaidTargets(gitCommitTree('HEAD')).map((target) => target.path);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).not.toContain('tmp/mermaid-target-probe.md');
  });

  it('takes a file the commit has and the checkout does not', () => {
    const ref = treeHolding('mermaid-target-probe.md', DIAGRAM);
    expect(existsSync(`${REPO_ROOT}mermaid-target-probe.md`)).toBe(false);

    expect(mermaidTargets(gitCommitTree(ref))).toEqual([
      { path: 'mermaid-target-probe.md', expected: 1 },
    ]);
  });

  it('fails loudly on a commit this clone does not have, rather than checking nothing', () => {
    const absent = '0000000000000000000000000000000000000000';
    expect(() => mermaidTargets(gitCommitTree(absent))).toThrow();
  });
});
