import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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

/**
 * The lines of the `//` block that explains the lock: everything between the previous line of code
 * and `module deleteLock`. Blank lines belong to the block rather than ending it — an earlier
 * revision stopped at the first one, so a paragraph break silently shortened what was read.
 */
function commentaryLines(lines: readonly string[]): number[] {
  const declaration = declarationLine(lines);

  let start = declaration;
  while (start > 0) {
    const line = lines[start - 1] ?? '';
    if (line.trim() !== '' && !line.startsWith('//')) break;
    start--;
  }

  const indices: number[] = [];
  for (let at = start; at < declaration; at++) {
    if ((lines[at] ?? '').startsWith('//')) indices.push(at);
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

/** The runbook section carrying the by-hand recipe, located from the recipe rather than by title. */
function lockSection(source: string): string {
  const lines = source.split('\n');
  const recipe = lines.findIndex((line) => line.includes('--notes "'));
  if (recipe === -1) throw new Error(`${RUNBOOK} carries no az lock create --notes argument`);

  const heading = /^#{1,6} /u;
  let start = recipe;
  while (start > 0 && !heading.test(lines[start] ?? '')) start--;
  let end = recipe + 1;
  while (end < lines.length && !heading.test(lines[end] ?? '')) end++;

  return lines.slice(start, end).join('\n');
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

  it('is checked over the whole commentary, not the part above the first paragraph break', () => {
    const lines = read(MAIN).split('\n');
    const commentary = lockCommentary(read(MAIN));
    const probe = `${'9'.repeat(5)} ${NOUNS[0] as string}s`;
    const block = commentaryLines(lines);

    for (const index of block) {
      // A paragraph break anywhere in the block leaves the same commentary behind.
      const broken = [...lines];
      broken.splice(index, 0, '');
      expect(lockCommentary(broken.join('\n')), `blank line at ${index}`).toBe(commentary);

      // And a census on any line of it is seen, so the region is the whole region.
      const planted = [...lines];
      planted[index] = `// ${probe}`;
      expect(census(lockCommentary(planted.join('\n'))), `census at ${index}`).not.toEqual([]);
    }

    expect(block.length).toBe(commentary.split('\n').length);
  });
});
