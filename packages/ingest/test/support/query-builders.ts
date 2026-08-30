/**
 * The Overpass answers this repository asks for, found by reading its source rather than by
 * listing them, so a builder added anywhere is one a fixture guard can notice is unrecorded.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * `.claude` holds this repository's worktrees — whole checkouts of other branches, whose
 * builders are not this one's. The rest is build output and dependencies.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.claude',
  'dist',
  'build',
  'coverage',
]);

/** Every Overpass query opens with this, and only a builder writes one. */
const QL_HEADER = '[out:json';

/** A top-level declaration, so an indented `const box = …` inside a builder cannot claim its QL. */
const DECLARATION = /^(?:export )?(?:async )?(?:function|const) (\w+)/u;

/** Tests quote Overpass QL as an expectation; only production source builds one. */
function isTestSource(path: string): boolean {
  return (
    path.includes(`${sep}test${sep}`) ||
    path.includes(`${sep}e2e${sep}`) ||
    /\.test\.tsx?$/u.test(path)
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(full);
    return /\.tsx?$/u.test(entry.name) && !isTestSource(full) ? [full] : [];
  });
}

/** The nearest top-level declaration at or above a line — the builder the QL belongs to. */
function declarationAbove(lines: readonly string[], at: number): string | null {
  for (let i = at; i >= 0; i -= 1) {
    const match = DECLARATION.exec(lines[i]!);
    if (match) return match[1]!;
  }
  return null;
}

/**
 * Where a builder's answer is filed: `buildWayGeometryQuery` → `way-geometry`. The `Query`
 * suffix is required rather than assumed, because a shape derived from a name that does not
 * carry one is a guard looking at the answer to a different question.
 */
function shapeOf(builder: string, where: string): string {
  if (!builder.endsWith('Query')) {
    throw new Error(
      `${where}: \`${builder}\` builds Overpass QL but is not named \`…Query\`, so the fixture ` +
        `shape it should be recorded under cannot be derived from it.`,
    );
  }
  return builder
    .replace(/^build/u, '')
    .replace(/Query$/u, '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1-$2')
    .toLowerCase();
}

function shapesIn(text: string, file: string): string[] {
  const lines = text.split('\n');
  const shapes: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i]!.includes(QL_HEADER)) continue;
    const where = `${relative(REPO_ROOT, file).split(sep).join('/')}:${i + 1}`;
    const owner = declarationAbove(lines, i);
    // Unattributable QL would silently shrink the set, which is the one failure a guard built
    // on this cannot survive.
    if (!owner) throw new Error(`${where}: Overpass QL outside any top-level declaration`);
    shapes.push(shapeOf(owner, where));
  }
  return shapes;
}

/**
 * How many source files are read at once. Six hundred sequential opens is seconds of latency on
 * Windows and none of it is CPU; the threadpool turns that into a fraction of a second.
 */
const READ_CONCURRENCY = 64;

/** Sorted and deduplicated: two builders producing one answer shape need one recording. */
export async function overpassShapesInSource(): Promise<string[]> {
  const files = sourceFiles(REPO_ROOT);
  const shapes = new Set<string>();

  for (let at = 0; at < files.length; at += READ_CONCURRENCY) {
    const batch = files.slice(at, at + READ_CONCURRENCY);
    const contents = await Promise.all(batch.map((file) => readFile(file)));
    for (const [index, raw] of contents.entries()) {
      // Matched as bytes and decoded only on a hit: three files in some six hundred build QL,
      // and decoding the rest to UTF-16 is most of the walk's cost.
      if (!raw.includes(QL_HEADER)) continue;
      for (const shape of shapesIn(raw.toString('utf8'), batch[index]!)) shapes.add(shape);
    }
  }

  // An empty answer would agree with an empty index, and the guard would pass having read nothing.
  if (shapes.size === 0) throw new Error(`no Overpass query builder found under ${REPO_ROOT}`);
  return [...shapes].sort();
}
