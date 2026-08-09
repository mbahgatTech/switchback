import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.claude',
  'dist',
  'build',
  'coverage',
]);

/** GitHub mounts each block in an iframe on this host. */
const VIEWSCREEN = 'viewscreen.githubusercontent.com';
const SETTLE_MS = 20_000;
const POLL_MS = 500;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) {
      return SKIP_DIRS.has(entry.name) ? [] : markdownFiles(join(dir, entry.name));
    }
    return entry.name.endsWith('.md') ? [join(dir, entry.name)] : [];
  });
}

function blockCount(file: string): number {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() === '```mermaid').length;
}

/** `owner/repo` from the origin URL, however it is spelled. */
function repoSlug(): string {
  const match = /github\.com[:/](?<slug>[^/]+\/[^/]+?)(?:\.git)?$/.exec(
    git('remote', 'get-url', 'origin'),
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
  const ref = process.argv[2] ?? git('rev-parse', 'HEAD');
  const slug = repoSlug();

  const targets = markdownFiles(REPO_ROOT)
    .map((file) => ({
      path: file.slice(REPO_ROOT.length).replace(/\\/g, '/'),
      expected: blockCount(file),
    }))
    .filter((target) => target.expected > 0);

  if (targets.length === 0) throw new Error('no markdown file carries a Mermaid block');

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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
