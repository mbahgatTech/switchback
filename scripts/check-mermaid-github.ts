import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Frame } from '@playwright/test';

/**
 * Loads a pushed ref's markdown on github.com and checks every Mermaid block became an `<svg>`.
 * The only check that is evidence: GitHub runs its own Mermaid build inside a sandboxed iframe,
 * and on a parse failure shows the source instead. `mmdc` passing locally says nothing about it.
 *
 *   npx tsx scripts/check-mermaid-github.ts [ref]
 */

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** GitHub mounts each block in an iframe on this host. */
const VIEWSCREEN = 'viewscreen.githubusercontent.com';
const SETTLE_MS = 20_000;
const POLL_MS = 500;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

/** A file to load, and the number of its blocks that have to have become diagrams. */
export interface Target {
  path: string;
  expected: number;
}

/**
 * The repository as one commit holds it. Injected so the enumeration can be exercised without a
 * clone that happens to contain the right commits.
 */
export interface CommitTree {
  paths: () => string[];
  read: (path: string) => string;
}

export function countMermaidBlocks(source: string): number {
  return source.split('\n').filter((line) => line.trim() === '```mermaid').length;
}

/**
 * The markdown to check, read from the commit under test rather than from the working tree.
 *
 * The two are different trees on a pull request, and the difference is not cosmetic: the runner
 * checks out a commit while the blob URL below names `ref`, so a branch that has not been rebased
 * carries files on disk its head does not have, and a branch that *deletes* a diagram still has
 * it on disk. Either way the run asks github.com for a blob that is not there, and a 404 renders
 * nothing — which the settle loop cannot tell apart from a diagram that failed to parse. Three
 * open pull requests went red on it while every diagram in them was fine.
 */
export function mermaidTargets(tree: CommitTree): Target[] {
  return tree
    .paths()
    .filter((path) => path.endsWith('.md'))
    .map((path) => ({ path, expected: countMermaidBlocks(tree.read(path)) }))
    .filter((target) => target.expected > 0);
}

/**
 * A commit in this clone. Absent objects make `git` throw, which ends the run loudly rather than
 * finding nothing to check and calling that a pass.
 */
/**
 * The commit to name in every blob URL, always as a SHA. github.com resolves a symbolic ref in a
 * blob path against the *default branch*, so passing `HEAD` through renders master while the
 * expected block counts are read from the head commit — a green run about the wrong tree.
 */
export function resolveRef(ref: string | undefined): string {
  return git('rev-parse', ref ?? 'HEAD').trim();
}

export function gitCommitTree(ref: string): CommitTree {
  return {
    // `-z`, because `ls-tree` otherwise quotes and backslash-escapes any path outside ASCII.
    paths: () =>
      git('ls-tree', '-r', '--name-only', '-z', ref)
        .split('\0')
        .filter((path) => path.length > 0),
    read: (path) => git('show', `${ref}:${path}`),
  };
}

/** `owner/repo` from the origin URL, however it is spelled. */
function repoSlug(): string {
  const match = /github\.com[:/](?<slug>[^/]+\/[^/]+?)(?:\.git)?$/.exec(
    git('remote', 'get-url', 'origin').trim(),
  );
  if (!match?.groups?.slug) throw new Error('origin is not a github.com remote');
  return match.groups.slug;
}

/**
 * Blocks whose iframe painted a diagram. `svg` alone is not the signal — GitHub's zoom and pan
 * controls are seven octicons, present whether or not Mermaid drew anything. `svg#diagram` is the
 * diagram itself, and Mermaid marks a parse failure by giving it `aria-roledescription="error"`.
 */
async function renderedBlocks(frames: Frame[]): Promise<number> {
  const verdicts = await Promise.all(
    frames
      .filter((frame) => frame.url().includes(VIEWSCREEN))
      .map(async (frame) => {
        const diagram = frame.locator('svg#diagram');
        if ((await diagram.count().catch(() => 0)) === 0) return false;
        /*
         * A rejection here means GitHub swapped this iframe between the count and the read, which
         * it does while the page settles. That is "not rendered *yet*", not a failure: the next
         * poll takes a fresh frame list. Letting it reject instead failed the whole run on a race
         * the following half-second would have won.
         */
        const role = await diagram
          .first()
          .getAttribute('aria-roledescription')
          .catch(() => 'error');
        return role !== 'error';
      }),
  );
  return verdicts.filter(Boolean).length;
}

async function main(): Promise<void> {
  const ref = resolveRef(process.argv[2]);
  const slug = repoSlug();

  const targets = mermaidTargets(gitCommitTree(ref));

  if (targets.length === 0) throw new Error(`no markdown file at ${ref} carries a Mermaid block`);

  const browser = await chromium.launch();
  const failures: string[] = [];

  /*
   * `finally`, because a throw that leaves chromium connected leaves the event loop with a live
   * handle and the process never exits — so the job sits until its 15-minute timeout and is
   * *cancelled*, which reports no verdict at all rather than the failure it actually had.
   */
  try {
    const page = await browser.newPage();

    for (const { path, expected } of targets) {
      const url = `https://github.com/${slug}/blob/${ref}/${path}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });

      let rendered = 0;
      for (let waited = 0; waited < SETTLE_MS && rendered < expected; waited += POLL_MS) {
        await page.waitForTimeout(POLL_MS);
        rendered = await renderedBlocks(page.frames());
      }

      process.stdout.write(`${rendered}/${expected} rendered  ${url}\n`);
      if (rendered < expected)
        failures.push(`${path}: ${expected - rendered} of ${expected} did not render`);
    }
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.join('\n')}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
