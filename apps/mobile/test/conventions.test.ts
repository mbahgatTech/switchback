import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';

/**
 * The conventions the phone has to keep too — the mobile twin of
 * `apps/web/test/conventions.test.ts`. Two clients sharing `packages/ui` are one product only
 * while something checks they still agree, and a token set can offer but not enforce.
 *
 * Same bar as the web file: **a rule earns its place by having been broken.** Both below are
 * counts of real drift, not preferences.
 */

const mobileRoot = fileURLToPath(new URL('..', import.meta.url));

/** Every source file the app actually ships, as `[repo-relative path, contents]`. */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push([path.relative(mobileRoot, full), readFileSync(full, 'utf8')]);
      }
    }
  };
  // `app` is the router and `src` is everything it draws with. Route groups like `(tabs)`
  // are ordinary directories on disk, so nothing special is needed to walk into them.
  walk(path.join(mobileRoot, 'app'));
  walk(path.join(mobileRoot, 'src'));
  return out;
}

const FILES = sources();

/**
 * A gate that scans nothing passes everything. Both rules below assert an empty list, so a walk
 * that returned no files would report a clean app while reading none of it. The floor is not a
 * target; it only has to be high enough that an empty tree cannot clear it.
 */
it('reads the app', () => {
  expect(FILES.length).toBeGreaterThan(40);
  expect(FILES.map(([file]) => file)).toContain(path.join('app', '(tabs)', 'index.tsx'));
});

/** Every `file:line` where `pattern` matches, skipping files the rule exempts. */
function offenders(pattern: RegExp, exempt: (file: string) => boolean = () => false) {
  const hits: string[] = [];
  for (const [file, source] of FILES) {
    if (exempt(file)) continue;
    source.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        hits.push(`${file}:${index + 1}  ${match[0]}`);
      }
    });
  }
  return hits;
}

it('casts no shadows', () => {
  /*
   * The web app's rule, word for word, because it is the same product: a printed sheet has no
   * z-axis, depth is carried by plate colour and hairline rules, and one drop shadow reads as
   * a different product's component pasted in.
   *
   * `elevation` and `boxShadow` are in the pattern although neither has ever appeared here —
   * they are the same mistake spelled the two other ways this platform accepts, and leaving
   * them out would gate the iOS spelling of a decision while waving the others through.
   */
  const stray = offenders(
    /\b(?:shadowColor|shadowOpacity|shadowRadius|shadowOffset|elevation|boxShadow)\s*:/g,
  );
  expect(stray, 'depth is plate colour and hairlines, not shadow').toEqual([]);
});

it('takes every colour from the theme', () => {
  /*
   * There is no hex in this app: colour arrives as `theme.color.*` or `dark.color.*`, which is
   * what lets a scheme change mean anything. A shadow was the one place a raw colour could
   * hide, because it is the one property where nobody asks which plate the value belongs to.
   */
  const stray = offenders(/['"]#[0-9a-fA-F]{3,8}['"]/g);
  expect(stray, 'colour comes from the theme, so it can change with the scheme').toEqual([]);
});
