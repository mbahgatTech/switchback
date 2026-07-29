import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_HEIGHT, LAYOUT } from '@switchback/ui';

/**
 * The conventions that a reader can see but a compiler cannot.
 *
 * Every rule here exists because the same decision had already been made two or three
 * different ways in two or three different files, and nothing in the build noticed. Type
 * checking cannot tell a `min-h-[44px]` from a `min-h-[48px]`; ESLint has no opinion about
 * `max-w-[52ch]` beside `max-w-[54ch]`. What catches those is a reader, once, and then only
 * until the next hurried afternoon — so the readings get written down here instead.
 *
 * **This is a text scan, not a type check, and that is the point.** Tailwind v4 finds
 * classes by scanning source text: a template literal like `` `min-h-[${n}px]` `` generates
 * no CSS at all, which is why the shared strings in `controls.ts` are written out longhand
 * rather than interpolated from the token. Longhand strings cannot drift from their token
 * on their own — so something has to read both and compare, and that something is this file.
 *
 * A rule earns its place by having been broken. None of these is a style preference someone
 * imagined might one day matter; each is a count of how many ways the codebase had actually
 * said one thing before it was unified. Adding a rule for a mistake nobody has made yet is
 * how a gate like this turns into a rulebook nobody reads.
 */

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const CONTROLS = path.join('src', 'components', 'controls.ts');

/** Every source file the website actually ships, as `[repo-relative path, contents]`. */
function sources(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(tsx?|css)$/.test(entry.name)) {
        out.push([path.relative(webRoot, full), readFileSync(full, 'utf8')]);
      }
    }
  };
  walk(path.join(webRoot, 'app'));
  walk(path.join(webRoot, 'src'));
  return out;
}

const FILES = sources();

/**
 * A gate that scans nothing passes everything.
 *
 * Every rule below asserts an empty list, so a walk that quietly returned no files would
 * report a clean website while reading none of it — the one failure mode of this whole file
 * that produces no symptom. The floor is well under the current count and is not a target;
 * it only has to be high enough that an empty or half-built tree cannot clear it.
 */
it('reads the website', () => {
  expect(FILES.length).toBeGreaterThan(100);
  expect(FILES.map(([file]) => file)).toContain(CONTROLS);
});

/**
 * Every `file:line` where `pattern` matches, skipping files the rule exempts.
 *
 * Line-accurate on purpose: a failure that says only "somewhere in the web app" costs more
 * to act on than the rule saves.
 */
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

describe('the control ladder is one ladder', () => {
  const controls = readFileSync(path.join(webRoot, CONTROLS), 'utf8');

  it('spells `CONTROL_HEIGHT` exactly, in the strings Tailwind scans', () => {
    // `String(key)` and the `as const` are load-bearing rather than tidy. A destructured
    // capture group is `string | undefined`, which is not a `PropertyKey`, so the callback
    // misses `Object.fromEntries`' tuple overload and falls through to the one that returns
    // `any` — and an `any` here would happily equal anything at all, which is the one result
    // this test must never be able to produce.
    const rungs: Record<string, number> = Object.fromEntries(
      [...controls.matchAll(/^\s*(\w+): 'min-h-\[(\d+)px\]',$/gm)].map(
        ([, key, px]) => [String(key), Number(px)] as const,
      ),
    );
    expect(rungs, 'HEIGHT in controls.ts').toEqual(CONTROL_HEIGHT);
  });

  it('sizes the invisible hit box at the touch rung', () => {
    // `HIT` grows the *target* around a mark that has to stay small. The box is the same
    // 48 as everywhere else or it is a per-file guess wearing a shared name.
    const box = /before:size-\[(\d+)px\]/.exec(controls);
    expect(box?.[1], 'HIT in controls.ts').toBe(String(CONTROL_HEIGHT.touch));
  });

  it('has no fourth rung hiding in a page', () => {
    // Outside the band are two real things that are not controls: a 96px textarea and a
    // 280px empty state. Inside it, a bare `min-h-` is always a control someone sized by eye.
    const stray = offenders(/min-h-\[(?:2[4-9]|[3-6]\d|7[0-2])px\]/g, (f) => f === CONTROLS);
    expect(stray, 'use HEIGHT.panel / .touch / .field').toEqual([]);
  });
});

describe('the measure is one measure', () => {
  it('names its columns instead of counting characters at each one', () => {
    // Was eight prose widths and two page rails; is now `max-w-measure`,
    // `max-w-measure-wide`, `max-w-rail`, `max-w-sheet` — see `LAYOUT` in packages/ui.
    const rails = [LAYOUT.rail, LAYOUT.sheet].join('|');
    expect(offenders(/max-w-\[\d+ch\]/g), 'use max-w-measure / max-w-measure-wide').toEqual([]);
    expect(
      offenders(new RegExp(`max-w-\\[(?:${rails})\\]`, 'g')),
      'use max-w-rail / max-w-sheet',
    ).toEqual([]);
  });
});

describe('the scales are the tokens', () => {
  it('sets type off the ladder, never off a pixel', () => {
    // Every step in `theme.css` carries its own line-height *and* letter-spacing, so a raw
    // size is three decisions taken by hand where the ladder takes them together.
    expect(offenders(/\btext-\[[^\]]+\]/g), 'use text-micro … text-display').toEqual([]);
  });

  it('leaves letter-spacing to the size that owns it', () => {
    // `tracking-[…]` beside a `text-*` utility is almost always the ladder restated. The
    // wordmark is the one place it is a decision: the brand's own tightening, not a size's.
    const stray = offenders(/tracking-\[[^\]]+\]/g, (f) => f.endsWith('wordmark.tsx'));
    expect(stray, 'the size already sets its tracking').toEqual([]);
  });

  it('rounds corners off the radius scale', () => {
    expect(offenders(/rounded-\[[^\]]+\]/g), 'use rounded-hair / -panel / -pill').toEqual([]);
  });
});

describe('the sheet stays flat', () => {
  it('casts no shadows', () => {
    /*
     * A printed sheet has no z-axis, and the whole design rests on that: depth is carried by
     * plate colour and hairline rules, so one drop shadow reads as a different product's
     * component pasted in.
     *
     * There used to be six exceptions, and they were all the same exception written six
     * times — MapLibre ships a shadow on its own control group, and `!shadow-none` was how
     * each map took it back off. That is now one `box-shadow: none !important` in
     * `globals.css`, beside the rest of the map chrome, so the allowance this rule used to
     * carry has no callers left and is gone with them. A `!shadow-none` reappearing in a
     * component is a map styling itself again, which is the thing that was just undone.
     *
     * The lookbehind is what keeps `hillshade-shadow-color` out of it: that is terrain
     * relief in a MapLibre paint object, which is a picture of a hill and not a UI shadow.
     * It also excludes the CSS longhand `box-shadow`, for the same reason — the property is
     * not the utility, and the stylesheet is where the one legitimate use now lives.
     */
    const stray = offenders(/(?<![\w-])!?shadow-[\w[\]().-]+/g);
    expect(stray, 'depth is plate colour and hairlines, not shadow').toEqual([]);
  });

  it('blurs nothing behind glass', () => {
    // Same reason, and worse: over a map, `backdrop-blur` makes the thing underneath
    // unreadable without making the thing on top legible. Over-map chrome is opaque.
    expect(offenders(/\bbackdrop-blur\b/g), 'over-map chrome is opaque').toEqual([]);
  });
});

describe('the shared class strings are template literals', () => {
  /**
   * The source with every backtick span blanked to spaces, newlines kept so lines still
   * number.
   *
   * A quote character means nothing on its own — `"` opens an HTML attribute inside the
   * templates that build map attribution, and `'` is just an apostrophe in "I'm hiking".
   * Both live *inside* template literals, which is exactly where an interpolation belongs,
   * so the only way to ask the question is to take the templates away first and look at
   * what is left.
   *
   * A stray unpaired backtick — legal inside a string, and harmless — would desync this and
   * blank the rest of a file. That direction is a missed catch rather than a false alarm,
   * which is the right way round for a rule this cheap.
   */
  const withoutTemplates = (source: string) => {
    let out = '';
    let inside = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '`' && source[i - 1] !== '\\') {
        inside = !inside;
        out += ' ';
      } else out += inside && ch !== '\n' ? ' ' : ch;
    }
    return out;
  };

  it('leaves no `${…}` sitting unread inside a quoted class', () => {
    /*
     * Seven controls once shipped with the literal characters `${HEIGHT.panel}` in their
     * `class` attribute and no height at all. Someone put the token into a string that was
     * quoted rather than backticked, and nothing downstream has an opinion about that:
     * `'a ${b} c'` is a perfectly good JavaScript string, so the compiler is happy, and
     * Tailwind — which only ever scans text — dutifully generated a class *named*
     * `${HEIGHT.panel}`. ESLint caught two of the seven, and only by the accident that
     * `HEIGHT` went unused in those two files; the other five were found by measuring a
     * button in a browser.
     */
    const hits: string[] = [];
    for (const [file, source] of FILES) {
      withoutTemplates(source)
        .split('\n')
        .forEach((line, index) => {
          for (const match of line.matchAll(/(['"])[^'"\n]*\$\{[\w$.]+\}[^'"\n]*\1/g)) {
            hits.push(`${file}:${index + 1}  ${match[0].trim()}`);
          }
        });
    }
    expect(hits, 'a quoted string does not interpolate — use a backtick').toEqual([]);
  });
});

describe('nothing is hidden until hovered', () => {
  it('reveals no control on hover alone', () => {
    /*
     * A control that appears on `:hover` does not exist on a touch screen, and this product
     * is used outdoors on a phone. It also cannot be reached by a keyboard unless someone
     * remembered `focus-within`, and the pattern's own shape — `opacity-0` plus a
     * `group-hover` — is what makes that easy to forget.
     */
    const stray = offenders(/\bopacity-0\b/g).concat(offenders(/group-hover:opacity-100/g));
    expect(stray, 'a hover-only control is a control a thumb cannot press').toEqual([]);
  });
});

describe('the collar is painted, not coloured', () => {
  /**
   * Every JSX opening tag for `name`, as `[file, line, tag text]`.
   *
   * Walked rather than matched because an opening tag is not a `[^>]*` — `style={{…}}` and
   * any arrow handler put a `>` inside braces, and a regex that stops at the first one
   * truncates the tag and then reports on half of it. Brace depth is the whole difference
   * between a rule that reads attributes and a rule that guesses at them.
   */
  const openingTags = (name: RegExp) => {
    const found: { where: string; tag: string }[] = [];
    for (const [file, source] of FILES) {
      for (let i = 0; i < source.length; i++) {
        if (source[i] !== '<') continue;
        const rest = source.slice(i + 1);
        const opener = new RegExp(`^(?:${name.source})(?=[\\s/>])`).exec(rest);
        if (!opener) continue;
        let depth = 0;
        let end = i + 1;
        while (end < source.length) {
          const ch = source[end];
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          else if (ch === '>' && depth === 0) break;
          end++;
        }
        const tag = source.slice(i, end + 1);
        found.push({ where: `${file}:${source.slice(0, i).split('\n').length}`, tag });
        i = end;
      }
    }
    return found;
  };

  it('gives every SVG collar a fill, because `color` does not paint a `<text>`', () => {
    /*
     * The three axis glosses on the section chart shipped black on a dark map for as long as
     * dark mode existed, at a measured 1.17:1 against the field canvas.
     *
     * `.collar` is the small-caps label style, and like every other rule in `globals.css` it
     * sets `color`. On an HTML element that is the whole story. On an SVG `<text>` it is
     * nearly nothing: SVG paints glyphs with `fill`, whose initial value is black and which
     * inherits from no `color` anywhere — there is no `svg text { fill: currentColor }` in
     * this repo or in Tailwind's preflight. So the class applied its font, its size, its
     * tracking and its uppercasing, and left the ink alone.
     *
     * The rule is narrow on purpose: a `.collar` inside an SVG, and nothing else. It is the
     * one place the two paint models meet in this codebase, and it was wrong in exactly that
     * one place. The print sheet and the phone were never affected — both already pass `fill`
     * explicitly, the phone because react-native-svg has no CSS to inherit from at all.
     */
    const stray = openingTags(/text|tspan|g/)
      .filter(({ tag }) => /className=(?:["'][^"']*\bcollar\b|\{[^}]*\bcollar\b)/.test(tag))
      .filter(({ tag }) => !/\bfill=/.test(tag))
      .map(({ where, tag }) => `${where}  ${tag.split('\n')[0]!.trim()}`);
    expect(stray, 'SVG text takes `fill`, not `color` — see .collar in globals.css').toEqual([]);
  });
});
