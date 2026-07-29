import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';

/**
 * The conventions the phone has to keep too.
 *
 * `apps/web/test/conventions.test.ts` has guarded the website for a while; this side had
 * nothing, and the difference showed up exactly where you would expect. The explore screen
 * had grown a drop shadow — `shadowColor: '#000'` at 0.32, spread into the search bar, the
 * filter button, the rail buttons and the layers panel, with a heavier one under the sheet —
 * in a product whose whole design rests on there being no z-axis. It was not careless; it
 * carried a comment arguing for itself. It was simply never read next to the web app's rule
 * saying the opposite, because nothing here ever read the two together.
 *
 * That is the case for this file existing at all. Two clients sharing `packages/ui` are one
 * product only for as long as something checks that they still agree, and a token set cannot
 * check anything — it can only offer. A rule here is the offer made binding.
 *
 * **The same bar as the web file: a rule earns its place by having been broken.** Both below
 * are counts of real drift, not preferences. The heights and type sizes that also wanted
 * rules did not get them — the raw `height: 44` on the rating cell was a genuine slip, but
 * `height` on this platform is images and grabbers and photo tiles as often as it is
 * controls, and a rule that fires on a 64pt portrait to catch a 44pt button costs more
 * attention than it saves. That one is fixed and left to review, which is the honest place
 * for a thing a scan cannot tell apart.
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
 * A gate that scans nothing passes everything.
 *
 * Both rules below assert an empty list, so a walk that quietly returned no files would
 * report a clean app while reading none of it. The floor is well under the current count and
 * is not a target; it only has to be high enough that an empty tree cannot clear it.
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
   * The web app's rule, word for word, because it is the same product: a printed sheet has
   * no z-axis, depth is carried by plate colour and hairline rules, and one drop shadow
   * reads as a different product's component pasted in.
   *
   * The six that were here all sat on elements that already had `backgroundColor: surface`,
   * a hairline `bezel` border and `radius.panel` — the exact treatment the web uses to float
   * the same controls over the same map. Removing them changed nothing about whether a
   * control could be told apart from the terrain under it, which is the tell that the shadow
   * was decoration on top of a separation that already worked.
   *
   * `elevation` and `boxShadow` are in the pattern although neither has ever appeared here.
   * That is not a rule for a mistake nobody has made — it is the same mistake spelled the
   * two other ways this platform accepts, and leaving them out would gate the iOS spelling
   * of a decision while waving through the Android and New Architecture ones.
   */
  const stray = offenders(
    /\b(?:shadowColor|shadowOpacity|shadowRadius|shadowOffset|elevation|boxShadow)\s*:/g,
  );
  expect(stray, 'depth is plate colour and hairlines, not shadow').toEqual([]);
});

it('takes every colour from the theme', () => {
  /*
   * There is no hex in this app. Colour arrives as `theme.color.*` or `dark.color.*`, which
   * is what lets a scheme change mean anything — a literal is a colour that cannot be dark,
   * cannot be print, and cannot be one of the five plates.
   *
   * The two that were here were `shadowColor: '#000'`, and pure black is not in the palette
   * at all: ink is #131819. A shadow was the one place a raw colour could hide, because it
   * is the one property where nobody looks at the value and asks which plate it belongs to.
   */
  const stray = offenders(/['"]#[0-9a-fA-F]{3,8}['"]/g);
  expect(stray, 'colour comes from the theme, so it can change with the scheme').toEqual([]);
});
