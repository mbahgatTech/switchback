import type { Source } from './sources';

/**
 * Finding, in the app's own source, every branch that draws something *instead of* a screen's
 * content — and deciding which of those read an error flag that can be true while the data is
 * still there. Split out of `conventions.test.ts` because it is now logic with its own edge
 * cases, and `screen-branches.test.ts` exercises them on sources it writes itself.
 *
 * What it cannot see is listed at the bottom of this file. That list is part of the rule.
 */

export type Branch = { at: string; test: string; shape: 'guard' | 'arm' };

/**
 * The one question, in the spellings it gets written in. `isError` and `status === 'error'` are
 * the same flag under two names; `isRefetchError` is that flag narrowed to the case where data
 * *is* held; `!isSuccess` and `status !== 'success'` ask it inverted, which is the same branch
 * with its arms swapped.
 *
 * `isLoadingError` is deliberately absent, and four screens rely on that: it is an error with
 * nothing behind it, so a branch reading it has no content to draw over.
 */
const ERROR_OVER_HELD_DATA = new RegExp(
  [
    /\.isError\b/u.source,
    /\.isRefetchError\b/u.source,
    /\bstatus === 'error'/u.source,
    /!\s*[\w.]*\bisSuccess\b/u.source,
    /\bstatus !== 'success'/u.source,
  ].join('|'),
  'u',
);

/** Whether a branch's condition asks a flag that stays true while the answer is still held. */
export function drawsOverHeldData({ test }: Branch): boolean {
  return ERROR_OVER_HELD_DATA.test(test);
}

/**
 * A condition Prettier broke across lines, read back as one. Anchored on the `if`'s own
 * indentation, which is where Prettier puts the closing `) {` — so a brace opened inside a nested
 * call, indented deeper, cannot end the condition early. Returns the condition and the line the
 * block opens on.
 */
function wrappedCondition(
  lines: string[],
  opensAt: number,
  indent: string,
): [string, number] | null {
  const parts: string[] = [];
  for (let at = opensAt + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (line.trim() === '') continue;
    if (line.startsWith(`${indent} `)) {
      parts.push(line.trim());
      continue;
    }
    return line === `${indent}) {` ? [parts.join(' '), at] : null;
  }
  return null;
}

/*
 * `return (` is the wrapped JSX a screen usually replaces itself with, and `return <` is the same
 * thing short enough to fit on one line. Anything else — `return null`, a string, a computed
 * value — is a helper making a decision, not a screen drawing over its own content.
 */
const RETURNS_A_SCREEN = /^return [(<]/u;

/** The condition of an `if` that returns a screen, written on one line, braceless, or wrapped. */
function guardAt(lines: string[], index: number): string | null {
  const line = lines[index] ?? '';

  const braceless = /^\s*if \((.+)\) return </u.exec(line);
  if (braceless) return braceless[1] ?? '';

  const draws = (opensAt: number) => RETURNS_A_SCREEN.test(lines[opensAt + 1]?.trim() ?? '');

  const single = /^\s*if \((.+)\) \{$/u.exec(line);
  if (single) return draws(index) ? (single[1] ?? '') : null;

  const wrapped = /^(\s*)if \($/u.exec(line);
  if (!wrapped) return null;
  const condition = wrappedCondition(lines, index, wrapped[1] ?? '');
  return condition && draws(condition[1]) ? condition[0] : null;
}

/*
 * A render ternary that opens on pending is standing in place of the content, so everything
 * chained after it is failure copy. `status === 'pending'` is the same question as `isPending`;
 * `saved.tsx` opens on neither and closes `) : null}`, which adds a message *beside* the content
 * and is right to read the error flag.
 */
const OPENS_ON_PENDING = /(?:\.isPending|\bstatus === 'pending') \? \($/u;

/**
 * Every test the chain falls through to after its pending arm, matched at the opener's own
 * indentation so a ternary nested inside an arm cannot be mistaken for a link in this one.
 */
function armsAfter(lines: string[], opensAt: number, indent: string): [string, number][] {
  const arms: [string, number][] = [];
  for (let at = opensAt + 1; at < lines.length; at += 1) {
    const line = lines[at] ?? '';
    if (!line.startsWith(`${indent})`)) continue;
    const arm = /^\s*\) : (.+) \? \($/u.exec(line);
    if (!arm) break;
    arms.push([arm[1] ?? '', at]);
  }
  return arms;
}

/**
 * Every screen-replacing branch in `files`: the early-return guards a screen opens with, and the
 * arms a render ternary falls to once its pending arm is done.
 */
export function screenReplacingBranches(files: Source[]): Branch[] {
  const branches: Branch[] = [];

  for (const [file, source] of files) {
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const guard = guardAt(lines, index);
      if (guard !== null) {
        branches.push({ at: `${file}:${index + 1}`, test: guard, shape: 'guard' });
        return;
      }

      if (!OPENS_ON_PENDING.test(line)) return;
      const indent = /^\s*/u.exec(line)?.[0] ?? '';
      for (const [test, at] of armsAfter(lines, index, indent)) {
        branches.push({ at: `${file}:${at + 1}`, test, shape: 'arm' });
      }
    });
  }
  return branches;
}

/*
 * The boundary, stated rather than implied. This reads lines; it does not evaluate them, so three
 * shapes are outside it and no amount of widening brings them in:
 *
 *   1. Indirection. `const failed = query.isError;` then `if (failed || !trail)` puts the flag
 *      one name away and nothing here can follow it.
 *   2. A ternary whose wrapped test does not *end* on the pending clause, which is what marks it
 *      as standing in place of the content rather than beside it.
 *   3. A branch that replaces content without opening on pending at all — indistinguishable, from
 *      the text alone, from `saved.tsx` adding a message beside content it keeps.
 *
 * The rule this feeds is therefore a floor on a known class, not a proof. The claim it can make
 * is that the ten sites it was built from, and the shapes below it, cannot come back unnoticed.
 */
