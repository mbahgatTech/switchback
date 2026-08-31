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
 */

function read(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
}

const MAIN = 'infra/azure/main.bicep';
const RUNBOOK = 'infra/azure/README.md';

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

/** The contiguous `//` run that explains the lock, immediately above `module deleteLock`. */
function lockCommentary(source: string): string {
  const lines = source.split('\n');
  const declaration = lines.findIndex((line) => line.startsWith('module deleteLock'));
  if (declaration === -1) throw new Error(`${MAIN} declares no deleteLock module`);

  const block: string[] = [];
  for (let i = declaration - 1; i >= 0 && (block.length === 0 || lines[i]?.startsWith('//')); i--) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (!line.startsWith('//')) break;
    block.unshift(line);
  }
  if (block.length === 0) throw new Error(`${MAIN} explains the deleteLock module with no comment`);
  return block.join('\n');
}

/**
 * A count of rows stated as a figure. The corpus roughly doubled inside a month, so any figure
 * written into a note that must be kept identical to a live ARM object is already expiring.
 */
const CENSUS_FIGURE = /\d[\d,]*\s+trails/;

describe("the delete lock's note", () => {
  it('is character-for-character the same string in the template and the runbook', () => {
    expect(lockNotesFromRunbook(read(RUNBOOK))).toBe(lockNotesFromTemplate(read(MAIN)));
  });

  it('is read from an anchor that fails loudly rather than matching nothing', () => {
    // The failure mode that kills a guard like this one: the file is reformatted, the pattern
    // stops matching, and a vacuous empty-vs-empty comparison keeps passing.
    const template = read(MAIN);
    const runbook = read(RUNBOOK);

    expect(lockNotesFromTemplate(template).length).toBeGreaterThan(0);
    expect(lockNotesFromRunbook(runbook).length).toBeGreaterThan(0);
    expect(lockCommentary(template).length).toBeGreaterThan(0);

    expect(() => lockNotesFromTemplate(template.replace('lockNotes:', 'notes:'))).toThrow();
    expect(() => lockNotesFromRunbook(runbook.replaceAll('--notes', '--n'))).toThrow();
    expect(() => lockCommentary(template.replace('module deleteLock', 'module lock'))).toThrow();
  });

  it('states no trail count, in the note or in the commentary above it', () => {
    expect(lockNotesFromTemplate(read(MAIN))).not.toMatch(CENSUS_FIGURE);
    expect(lockCommentary(read(MAIN))).not.toMatch(CENSUS_FIGURE);
  });
});
