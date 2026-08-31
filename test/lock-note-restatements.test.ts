import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { describe, expect, it } from 'vitest';

/**
 * The delete lock's note exists in three coupled places — `lockNotes` in `main.bicep`, the
 * `az lock create` recipe in the runbook, and the live ARM object — and `what-if` compares the
 * text rather than existence, so a copy that drifts reads as a permanent `Modify`.
 *
 * Both copies are read from their files and compared to each other; a literal here would agree
 * with whichever copy it was written from and miss exactly the drift this guards.
 *
 * **What must not come back is a census, not a spelling of one.** An earlier revision of this file
 * matched a number followed by the literal word "trails" and nothing else, so the same figure
 * written as "trail records" restored the defect with the suite green. The nouns below are read
 * from the Prisma schema, and the note itself may carry no digit at all.
 *
 * **Both regions are proved by planting a census on every line of them.** Two earlier revisions
 * read a truncated region and said so nowhere: one stopped the bicep commentary at the first line
 * that was not a column-0 `//`, the other took a `#` shell comment inside a ```bash fence for the
 * top of the runbook section. Each region is now bounded by an anchor the region cannot influence
 * — a bicep statement above the declaration, a heading a real Markdown parser agrees is a heading.
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
}

const MAIN = 'infra/azure/main.bicep';
const RUNBOOK = 'infra/azure/README.md';
const SCHEMA = 'packages/db/prisma/schema.prisma';

/** The `lockNotes` value `main.bicep` hands to `lock.bicep`. */
function lockNotesFromTemplate(source: string): string {
  const value = /^\s*lockNotes: '([^']*)'/m.exec(source)?.[1];
  if (value === undefined) throw new Error(`${MAIN} declares no lockNotes string literal`);
  return value;
}

/** The `--notes` argument of the runbook's by-hand `az lock create`. */
function lockNotesFromRunbook(source: string): string {
  const value = /--notes "([^"]*)"/.exec(source)?.[1];
  if (value === undefined) throw new Error(`${RUNBOOK} carries no az lock create --notes argument`);
  return value;
}

/** The line `module deleteLock` sits on. */
function declarationLine(lines: readonly string[]): number {
  const at = lines.findIndex((line) => line.startsWith('module deleteLock'));
  if (at === -1) throw new Error(`${MAIN} declares no deleteLock module`);
  return at;
}

const COMMENT = /^\s*\/\//u;

/** Anything bicep executes: a declaration or the decorator attached to one. */
const STATEMENT = /^\s*(?:@|(?:var|param|resource|module|output|type|func|targetScope)\s)/u;

/**
 * The lines of the `//` block that explains the lock: everything between the previous statement
 * and `module deleteLock`. Blank lines and indented `//` both belong to the block — an earlier
 * revision ended it at either, so a paragraph break or two leading spaces silently shortened
 * what was read.
 */
function commentaryLines(lines: readonly string[]): number[] {
  const declaration = declarationLine(lines);

  let start = declaration;
  while (start > 0) {
    const line = lines[start - 1] ?? '';
    if (line.trim() !== '' && !COMMENT.test(line)) break;
    start--;
  }

  const indices: number[] = [];
  for (let at = start; at < declaration; at++) {
    if (COMMENT.test(lines[at] ?? '')) indices.push(at);
  }
  if (indices.length === 0)
    throw new Error(`${MAIN} explains the deleteLock module with no comment`);
  return indices;
}

function lockCommentary(source: string): string {
  const lines = source.split('\n');
  return commentaryLines(lines)
    .map((at) => lines[at] ?? '')
    .join('\n');
}

/**
 * Everything between `module deleteLock` and the nearest statement above it. The boundary is code
 * rather than comment syntax, so this window is wider than the comment block by construction and
 * owes nothing to how `commentaryLines` reads a comment.
 */
function windowAboveDeclaration(lines: readonly string[]): number[] {
  const declaration = declarationLine(lines);

  let statement = declaration - 1;
  while (statement >= 0 && !STATEMENT.test(lines[statement] ?? '')) statement--;
  if (statement < 0) throw new Error(`${MAIN} declares nothing above deleteLock`);

  const window: number[] = [];
  for (let at = statement + 1; at < declaration; at++) window.push(at);
  return window;
}

const ATX_HEADING = /^ {0,3}#{1,6}(?: |$)/u;
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/u;

/**
 * The 0-based lines carrying a Markdown heading. Fences are tracked because `# …then deploy` in a
 * ```bash block is a shell comment, and reading it as a heading started the guarded section 14
 * lines below its title. The scan is held to a real Markdown parser over the runbook below.
 */
function headingLines(source: string): number[] {
  const headings: number[] = [];
  let fence: string | undefined;

  source.split('\n').forEach((line, at) => {
    const marker = CODE_FENCE.exec(line)?.[1];
    if (fence === undefined) {
      if (marker !== undefined) fence = marker;
      else if (ATX_HEADING.test(line)) headings.push(at);
      return;
    }
    const closes =
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.slice(line.indexOf(marker) + marker.length).trim() === '';
    if (closes) fence = undefined;
  });

  return headings;
}

/** The lines of the section holding the by-hand recipe, bounded by the headings it is given. */
function sectionLines(source: string, headings: readonly number[]): number[] {
  const lines = source.split('\n');
  const recipe = lines.findIndex((line) => line.includes('--notes "'));
  if (recipe === -1) throw new Error(`${RUNBOOK} carries no az lock create --notes argument`);

  const start = headings.filter((at) => at <= recipe).at(-1);
  if (start === undefined) throw new Error(`${RUNBOOK} carries no heading above the recipe`);
  const end = headings.find((at) => at > recipe) ?? lines.length;

  const section: number[] = [];
  for (let at = start; at < end; at++) section.push(at);
  return section;
}

function lockSection(source: string): string {
  const lines = source.split('\n');
  return sectionLines(source, headingLines(source))
    .map((at) => lines[at] ?? '')
    .join('\n');
}

interface MarkdownNode {
  type: string;
  position?: { start: { line: number } };
  children?: MarkdownNode[];
}

/** Prettier's own markdown parse, cast because the debug entry point ships no declaration. */
interface PrettierParser {
  __debug: {
    parse: (text: string, options: { parser: string }) => Promise<{ ast: MarkdownNode }>;
  };
}

/**
 * Headings as remark finds them. The repository already depends on this parser to format its
 * Markdown, so it is the one independent answer available to the question the scan above answers.
 */
async function parsedHeadingLines(source: string): Promise<number[]> {
  const { ast } = await (prettier as unknown as PrettierParser).__debug.parse(source, {
    parser: 'markdown',
  });

  const headings: number[] = [];
  const walk = (node: MarkdownNode): void => {
    if (node.type === 'heading' && node.position !== undefined)
      headings.push(node.position.start.line - 1);
    for (const child of node.children ?? []) walk(child);
  };
  walk(ast);
  return headings.sort((a, b) => a - b);
}

/**
 * Every noun the database counts, stemmed, from the schema rather than from memory. `Trail` and
 * `trails` are the same noun to a reader writing a census, and so are `trail records`.
 */
function corpusNouns(schema: string): string[] {
  const stems = new Set<string>();
  const add = (word: string): void => {
    const stem = word.toLowerCase().replace(/ies$/u, 'y').replace(/s$/u, '');
    if (stem.length >= 4) stems.add(stem);
  };

  for (const [, model = ''] of schema.matchAll(/^model\s+(\w+)/gmu)) {
    for (const part of model.split(/(?=[A-Z])/u)) add(part);
  }
  for (const [, table = ''] of schema.matchAll(/@@map\("(\w+)"\)/gu)) {
    for (const part of table.split('_')) add(part);
  }

  if (stems.size === 0) throw new Error(`${SCHEMA} names no models`);
  return [...stems].sort();
}

const NOUNS = corpusNouns(read(SCHEMA));

/** A figure attached to something the database holds: the number, then the noun within a clause. */
const COUNTED = new RegExp(
  String.raw`\d[\d,.]*\s+(?:\w+[\s-]+){0,3}?(?:${NOUNS.join('|')})\w*`,
  'giu',
);

/** A magnitude on its own: four digits or more, or thousands-separated. Dates are not magnitudes. */
const MAGNITUDE = /\b\d{4,}\b|\b\d{1,3}(?:,\d{3})+\b/gu;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/gu;

/** Every census-shaped phrase in a passage, so a failure names what it found. */
function census(passage: string): string[] {
  const withoutDates = passage.replace(ISO_DATE, ' ');
  return [...withoutDates.matchAll(COUNTED), ...withoutDates.matchAll(MAGNITUDE)].map(
    ([match]) => match,
  );
}

const PROBE = `${'9'.repeat(5)} ${NOUNS[0] as string}s`;

describe("the delete lock's note", () => {
  it('is character-for-character the same string in the template and the runbook', () => {
    expect(lockNotesFromRunbook(read(RUNBOOK))).toBe(lockNotesFromTemplate(read(MAIN)));
  });

  it('is read from anchors that fail loudly rather than matching nothing', () => {
    // The failure mode that kills a guard like this one: the file is reformatted, the pattern
    // stops matching, and a vacuous empty-vs-empty comparison keeps passing.
    const template = read(MAIN);
    const runbook = read(RUNBOOK);

    expect(lockNotesFromTemplate(template).length).toBeGreaterThan(0);
    expect(lockNotesFromRunbook(runbook).length).toBeGreaterThan(0);
    expect(lockCommentary(template).length).toBeGreaterThan(0);
    expect(lockSection(runbook)).toContain('--notes "');

    expect(() => lockNotesFromTemplate(template.replace('lockNotes:', 'notes:'))).toThrow();
    expect(() => lockNotesFromRunbook(runbook.replaceAll('--notes', '--n'))).toThrow();
    expect(() => lockCommentary(template.replace('module deleteLock', 'module lock'))).toThrow();
    expect(() => lockSection(runbook.replaceAll('--notes', '--n'))).toThrow();
    expect(() => sectionLines(runbook, [])).toThrow(/no heading above the recipe/u);
    expect(() => windowAboveDeclaration(['module deleteLock ='])).toThrow(/declares nothing/u);
    expect(() => corpusNouns('// no models here')).toThrow(/names no models/u);
  });

  it('carries no digit at all, because every figure in it has been a row count', () => {
    // The note must stay byte-identical to a live ARM object, so it may say nothing that changes
    // without a deployment. Nothing it needs to say is numeric.
    expect(lockNotesFromTemplate(read(MAIN))).not.toMatch(/\d/u);
  });

  it('states no count of anything the database holds, in the commentary or the runbook', () => {
    expect(census(lockCommentary(read(MAIN)))).toEqual([]);
    expect(census(lockSection(read(RUNBOOK)))).toEqual([]);
  });

  it('is checked over every comment line above the declaration, indented ones included', () => {
    const lines = read(MAIN).split('\n');
    const commentary = lockCommentary(read(MAIN));
    const comments = windowAboveDeclaration(lines).filter((at) => COMMENT.test(lines[at] ?? ''));

    expect(comments).not.toEqual([]);
    expect(commentaryLines(lines)).toEqual(comments);

    for (const at of comments) {
      // A paragraph break anywhere in the block leaves the same commentary behind.
      const broken = [...lines];
      broken.splice(at, 0, '');
      expect(lockCommentary(broken.join('\n')), `blank line at ${at}`).toBe(commentary);

      // And a census on any line of it is seen — written indented, which is the house style in
      // these templates and was the shape that used to end the block early.
      const planted = [...lines];
      planted[at] = `  // ${PROBE}`;
      expect(census(lockCommentary(planted.join('\n'))), `census at ${at}`).not.toEqual([]);
    }
  });

  it('is checked over every line of the runbook section, fenced code included', async () => {
    const runbook = read(RUNBOOK);
    const lines = runbook.split('\n');

    // The section is bounded by headings, so the headings are held to a real Markdown parser
    // rather than to this file's reading of them — that disagreement is the whole defect.
    expect(headingLines(runbook)).toEqual(await parsedHeadingLines(runbook));

    const section = sectionLines(runbook, await parsedHeadingLines(runbook));
    expect(section.length).toBeGreaterThan(1);

    for (const at of section) {
      const planted = [...lines];
      planted[at] = `${lines[at] ?? ''} ${PROBE}`;
      expect(census(lockSection(planted.join('\n'))), `census at ${at}`).not.toEqual([]);
    }
  });
});
