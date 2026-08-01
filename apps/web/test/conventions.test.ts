import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONTROL_HEIGHT, LAYOUT } from '@switchback/ui';

/**
 * The design conventions a reader can see but a compiler cannot. A text scan by necessity:
 * Tailwind v4 finds classes by scanning source text, so `` `min-h-[${n}px]` `` generates no CSS
 * and the shared strings in `controls.ts` are written longhand. Something has to read both.
 *
 * A rule earns its place by having been broken; adding one for a mistake nobody has made turns
 * this into a rulebook nobody reads.
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
 * A gate that scans nothing passes everything: every rule below asserts an empty list, so a walk
 * that returned no files would report a clean website. The floor is not a target.
 */
it('reads the website', () => {
  expect(FILES.length).toBeGreaterThan(100);
  expect(FILES.map(([file]) => file)).toContain(CONTROLS);
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

describe('the control ladder is one ladder', () => {
  const controls = readFileSync(path.join(webRoot, CONTROLS), 'utf8');

  it('spells `CONTROL_HEIGHT` exactly, in the strings Tailwind scans', () => {
    // `String(key)` and `as const` are load-bearing: a destructured capture group is
    // `string | undefined`, which misses `Object.fromEntries`' tuple overload and falls through
    // to the one returning `any` — and an `any` here would equal anything at all.
    const rungs: Record<string, number> = Object.fromEntries(
      [...controls.matchAll(/^\s*(\w+): 'min-h-\[(\d+)px\]',$/gm)].map(
        ([, key, px]) => [String(key), Number(px)] as const,
      ),
    );
    expect(rungs, 'HEIGHT in controls.ts').toEqual(CONTROL_HEIGHT);
  });

  it('sizes the invisible hit box at the touch rung', () => {
    const box = /before:size-\[(\d+)px\]/.exec(controls);
    expect(box?.[1], 'HIT in controls.ts').toBe(String(CONTROL_HEIGHT.touch));
  });

  it('has no fourth rung hiding in a page', () => {
    // The band excludes two real non-controls: a 96px textarea and a 280px empty state.
    const stray = offenders(/min-h-\[(?:2[4-9]|[3-6]\d|7[0-2])px\]/g, (f) => f === CONTROLS);
    expect(stray, 'use HEIGHT.panel / .touch / .field').toEqual([]);
  });
});

describe('the measure is one measure', () => {
  it('names its columns instead of counting characters at each one', () => {
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
    // Every step in `theme.css` carries its own line-height and letter-spacing.
    expect(offenders(/\btext-\[[^\]]+\]/g), 'use text-micro … text-display').toEqual([]);
  });

  it('leaves letter-spacing to the size that owns it', () => {
    // The wordmark is the one place tracking is a decision rather than the ladder restated.
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
     * Depth is plate colour and hairlines. MapLibre's own control shadow is taken off once in
     * `globals.css`, so no `!shadow-none` exemption is left. The lookbehind keeps out
     * `hillshade-shadow-color` (terrain relief in a paint object) and the `box-shadow` longhand.
     */
    const stray = offenders(/(?<![\w-])!?shadow-[\w[\]().-]+/g);
    expect(stray, 'depth is plate colour and hairlines, not shadow').toEqual([]);
  });

  it('blurs nothing behind glass', () => {
    // Over a map, `backdrop-blur` makes what is underneath unreadable without making what is on
    // top legible. Over-map chrome is opaque.
    expect(offenders(/\bbackdrop-blur\b/g), 'over-map chrome is opaque').toEqual([]);
  });
});

describe('the shared class strings are template literals', () => {
  /**
   * The source with every backtick span blanked to spaces, newlines kept so lines still number.
   * Quotes mean nothing on their own — `"` opens an HTML attribute inside the attribution
   * templates — so the templates have to come away before the question can be asked.
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
    // `'a ${b} c'` is a valid string, so the compiler is happy and Tailwind generates a class
    // literally named `${HEIGHT.panel}`. Seven controls once shipped with no height at all.
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
    // A hover-revealed control does not exist on a touch screen, and this product is used
    // outdoors on a phone.
    const stray = offenders(/\bopacity-0\b/g).concat(offenders(/group-hover:opacity-100/g));
    expect(stray, 'a hover-only control is a control a thumb cannot press').toEqual([]);
  });
});

describe('the collar is painted, not coloured', () => {
  /**
   * Every JSX opening tag for `name`, as `[file, line, tag text]`. Walked by brace depth rather
   * than matched: `style={{…}}` and arrow handlers put a `>` inside braces, and a `[^>]*` regex
   * truncates the tag and then reports on half of it.
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
     * `.collar` sets `color`, which paints an HTML element and not an SVG glyph: SVG uses `fill`,
     * whose initial value is black and which inherits from no `color`. The three section-chart
     * axis glosses shipped black on a dark map at 1.17:1. Narrow on purpose — a `.collar` inside
     * an SVG is the one place the two paint models meet in this codebase.
     */
    const stray = openingTags(/text|tspan|g/)
      .filter(({ tag }) => /className=(?:["'][^"']*\bcollar\b|\{[^}]*\bcollar\b)/.test(tag))
      .filter(({ tag }) => !/\bfill=/.test(tag))
      .map(({ where, tag }) => `${where}  ${tag.split('\n')[0]!.trim()}`);
    expect(stray, 'SVG text takes `fill`, not `color` — see .collar in globals.css').toEqual([]);
  });
});
