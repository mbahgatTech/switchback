/**
 * The Overpass answers this repository asks for, read off the syntax of every non-test `.ts` and
 * `.tsx` under it, so a query written in any of them is one a fixture guard can notice.
 */

import { readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

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

/** The literal kinds QL can be written as, template pieces included. */
const LITERAL_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
]);

/** The name a declaration introduces, whichever kind of declaration it is. */
function declaredName(node: ts.Node, source: ts.SourceFile): string | null {
  const name =
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertyAssignment(node)
      ? node.name
      : undefined;
  if (!name) return null;
  return ts.isIdentifier(name) ? name.text : name.getText(source);
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  for (let at = node.parent as ts.Node | undefined; at && !ts.isSourceFile(at); at = at.parent) {
    if (ts.isFunctionLike(at)) return at;
  }
  return null;
}

function nameAtOrAbove(node: ts.Node, source: ts.SourceFile): string | null {
  for (let at: ts.Node | undefined = node; at && !ts.isSourceFile(at); at = at.parent) {
    const name = declaredName(at, source);
    if (name) return name;
  }
  return null;
}

/**
 * The builder a QL literal belongs to: the innermost function around it, or — when that function
 * is anonymous — the name it is bound to. Taken from the syntax tree because a method, a
 * `class`, an `export default function` and an indented `const` are all places a query can be
 * written, and reading the nearest declaration *line* instead credits every one of them to
 * whatever unrelated top-level name happens to sit above.
 */
function ownerOf(literal: ts.Node, source: ts.SourceFile): string | null {
  return nameAtOrAbove(enclosingFunction(literal) ?? literal, source);
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

/** The answer shapes one source file asks for. Exported so the attribution is testable directly. */
export function overpassShapesIn(text: string, file: string): string[] {
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const shapes: string[] = [];

  const visit = (node: ts.Node): void => {
    if (LITERAL_KINDS.has(node.kind) && (node as ts.LiteralLikeNode).text.includes(QL_HEADER)) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const where = `${relative(REPO_ROOT, file).split(sep).join('/') || file}:${line}`;
      const owner = ownerOf(node, source);
      // Unattributable QL would silently shrink the set, which is the one failure a guard built
      // on this cannot survive.
      if (!owner) throw new Error(`${where}: Overpass QL under no named declaration`);
      shapes.push(shapeOf(owner, where));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return shapes;
}

/**
 * Source files read at once. Over this repository's 405 non-test sources the opens measured
 * 5.9–7.0 s sequentially against 0.93–1.08 s at 64 in flight: latency, not CPU.
 */
const READ_CONCURRENCY = 64;

/**
 * What a test must allow one scan, because vitest's 5 s default does not: the walk measured 10.8 s
 * on a loaded machine and reddened runs that had changed nothing near it. Stated here rather than
 * in each test, so a third caller cannot inherit the default by forgetting.
 */
export const SOURCE_SCAN_TIMEOUT_MS = 30_000;

/** Sorted and deduplicated: two builders producing one answer shape need one recording. */
export async function overpassShapesInSource(): Promise<string[]> {
  const files = sourceFiles(REPO_ROOT);
  const shapes = new Set<string>();

  for (let at = 0; at < files.length; at += READ_CONCURRENCY) {
    const batch = files.slice(at, at + READ_CONCURRENCY);
    const contents = await Promise.all(batch.map((file) => readFile(file, 'utf8')));
    for (const [index, text] of contents.entries()) {
      // The substring test keeps parsing to the three files that carry QL: parsing all 405
      // measured 0.22–0.55 s against 4–37 ms.
      if (!text.includes(QL_HEADER)) continue;
      for (const shape of overpassShapesIn(text, batch[index]!)) shapes.add(shape);
    }
  }

  // An empty answer would agree with an empty index, and the guard would pass having read nothing.
  if (shapes.size === 0) throw new Error(`no Overpass query builder found under ${REPO_ROOT}`);
  return [...shapes].sort();
}
