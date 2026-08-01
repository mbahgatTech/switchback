import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CONTROL_HEIGHT,
  DIFFICULTY_PLATE,
  DURATION,
  EASING,
  ELEVATION_BANDS,
  FONT_SIZE,
  FONTS,
  GRADE_STEPS,
  LAYOUT,
  LINE_HEIGHT,
  NATIVE_FALLBACKS,
  NATIVE_FONTS,
  PALETTES,
  RADIUS,
  SCHEMES,
  SPACE,
  TRACKING,
  collarLabel,
  gradeStep,
  nativeTextStyle,
} from '@switchback/ui';
import type { Mode, Scheme, SchemeColors } from '@switchback/ui';

const css = readFileSync(fileURLToPath(new URL('../theme.css', import.meta.url)), 'utf8');

/** Content between the braces that follow `marker`, brace-matched so nesting is safe. */
function block(source: string, marker: string): string {
  const at = source.indexOf(marker);
  expect(at, `theme.css is missing \`${marker}\``).toBeGreaterThan(-1);
  const open = source.indexOf('{', at + marker.length);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  throw new Error(`Unbalanced braces after \`${marker}\``);
}

/** `--name: value;` pairs at any depth of the given fragment. */
function customProperties(fragment: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of fragment.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name!, value!.replace(/\s+/g, ' ').trim());
  }
  return out;
}

const theme = customProperties(block(css, '@theme'));
const controlBlock = customProperties(block(css, ':root'));
const sheetBlock = customProperties(block(css, "[data-scheme='sheet']"));
const fieldBlock = customProperties(block(css, "[data-scheme='field']"));
const prefersDark = customProperties(block(css, 'html:not([data-scheme])'));
const fieldLight = customProperties(block(css, "[data-mode='light'] [data-scheme='field']"));
const sheetDark = customProperties(block(css, "[data-mode='dark'] [data-scheme='sheet']"));
const systemLight = customProperties(block(css, "html:not([data-mode]) [data-scheme='field']"));
const systemDark = customProperties(block(css, "html:not([data-mode]) [data-scheme='sheet']"));
const printSheet = customProperties(block(css, '[data-print-sheet]'));

const rem = (value: string): number => {
  expect(value, `${value} is not in rem`).toMatch(/rem$/);
  return Number.parseFloat(value) * 16;
};

/** CSS custom-property name for a `SchemeColors` key: `inkMuted` → `--color-ink-muted`. */
const cssVar = (key: keyof SchemeColors): string =>
  `--color-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

// Relative luminance / contrast, per WCAG 2.1. Inlined because this package deliberately has
// no dependencies.
const channel = (c: number): number => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('theme.css tracks the TypeScript tokens', () => {
  // `theme.css` is hand-written because packages here have no build step, so this suite is the
  // only thing stopping it drifting from src/tokens.
  it('declares the sheet scheme as the default', () => {
    for (const [key, value] of Object.entries(SCHEMES.sheet)) {
      expect(theme.get(cssVar(key as keyof SchemeColors))).toBe(value.toLowerCase());
    }
  });

  it('overrides every one of them for the field scheme', () => {
    for (const [key, value] of Object.entries(SCHEMES.field)) {
      expect(fieldBlock.get(cssVar(key as keyof SchemeColors))).toBe(value.toLowerCase());
    }
    // Not "at least these" — exactly these. A property overridden in one scheme and not the
    // other is how a card ends up with dark text on a dark surface.
    expect([...fieldBlock.keys()].sort()).toEqual(
      Object.keys(SCHEMES.field)
        .map((k) => cssVar(k as keyof SchemeColors))
        .sort(),
    );
  });

  it('restates the sheet scheme as an attribute, not just as the default', () => {
    // Custom properties inherit, so a sheet nested inside `<html data-scheme="field">` has
    // already inherited the dark values; without this block `data-scheme="sheet"` is a no-op.
    for (const [key, value] of Object.entries(SCHEMES.sheet)) {
      expect(sheetBlock.get(cssVar(key as keyof SchemeColors))).toBe(value.toLowerCase());
    }
    expect([...sheetBlock.keys()].sort()).toEqual([...fieldBlock.keys()].sort());
  });

  it('keeps the prefers-color-scheme fallback identical to the field block', () => {
    // The two lists are duplicated in the stylesheet — CSS cannot alias a block. Duplication
    // is fine; silent divergence is not.
    expect([...prefersDark.entries()].sort()).toEqual([...fieldBlock.entries()].sort());
  });

  it('carries the other two palettes — field in daylight, sheet at night', () => {
    for (const [key, value] of Object.entries(PALETTES.light.field)) {
      expect(fieldLight.get(cssVar(key as keyof SchemeColors))).toBe(value.toLowerCase());
    }
    for (const [key, value] of Object.entries(PALETTES.dark.sheet)) {
      expect(sheetDark.get(cssVar(key as keyof SchemeColors))).toBe(value.toLowerCase());
    }
    // The same completeness rule, for the same reason: a mode that overrides `canvas` and
    // forgets `ink` is how a light theme gets white text on paper.
    expect([...fieldLight.keys()].sort()).toEqual([...fieldBlock.keys()].sort());
    expect([...sheetDark.keys()].sort()).toEqual([...fieldBlock.keys()].sort());
  });

  it('resolves "system" in CSS, so the first paint is already right', () => {
    // The server writes `data-mode` only for a reader who has chosen a side; otherwise these
    // media blocks decide it, which is what buys a flash-free default with no blocking inline
    // script — and only while they say exactly what the explicit blocks say.
    expect([...systemLight.entries()].sort()).toEqual([...fieldLight.entries()].sort());
    expect([...systemDark.entries()].sort()).toEqual([...sheetDark.entries()].sort());
  });

  it('keeps paper light, whatever the screen is doing', () => {
    // The print stylesheet sets `print-color-adjust: exact`, so a dark palette really would
    // reach the paper.
    for (const [key, value] of Object.entries(SCHEMES.sheet)) {
      // `!important` is asserted, not stripped: the sheet element carries `data-print-sheet`
      // and `data-scheme="sheet"` together, so without it this rule loses the cascade to
      // `[data-mode='dark'][data-scheme='sheet']` and does nothing.
      expect(printSheet.get(cssVar(key as keyof SchemeColors))).toBe(
        `${value.toLowerCase()} !important`,
      );
    }
    expect([...printSheet.keys()].sort()).toEqual([...fieldBlock.keys()].sort());
  });

  it('tells the browser how bright the room is, in every palette block', () => {
    // Without `color-scheme` the browser paints scrollbars, `<select>` popups, carets and
    // spinners for a white page. Asserted per block, because it must track the palette it
    // sits with.
    const scheme = (fragment: string): string | undefined =>
      /color-scheme:\s*([^;]+);/.exec(fragment)?.[1]?.trim();

    expect(scheme(block(css, "[data-scheme='sheet']"))).toBe('light');
    expect(scheme(block(css, "[data-scheme='field']"))).toBe('dark');
    expect(scheme(block(css, 'html:not([data-scheme])'))).toBe('dark');
    expect(scheme(block(css, "[data-mode='light'] [data-scheme='field']"))).toBe('light');
    expect(scheme(block(css, "[data-mode='dark'] [data-scheme='sheet']"))).toBe('dark');
    expect(scheme(block(css, "html:not([data-mode]) [data-scheme='field']"))).toBe('light');
    expect(scheme(block(css, "html:not([data-mode]) [data-scheme='sheet']"))).toBe('dark');
    // Same `!important` reasoning as the colours it sits with — and paper has no dark mode.
    expect(scheme(block(css, '[data-print-sheet]'))).toBe('light !important');
  });

  it('leaves the diagonal that already shipped alone', () => {
    // Dark-field and light-sheet are aliased out of `SCHEMES`, not copied. Identity is the
    // assertion, because two objects with equal values would drift apart without failing.
    expect(PALETTES.dark.field).toBe(SCHEMES.field);
    expect(PALETTES.light.sheet).toBe(SCHEMES.sheet);
  });

  it('carries the scheme-independent ramps once, outside both schemes', () => {
    ELEVATION_BANDS.forEach((hex, i) => {
      expect(theme.get(`--color-band-${i}`)).toBe(hex.toLowerCase());
    });
    GRADE_STEPS.forEach((step, i) => {
      expect(theme.get(`--color-grade-${i}`)).toBe(step.color.toLowerCase());
    });
    for (const name of [...fieldBlock.keys()]) {
      expect(name, 'a cartographic ramp must not change between schemes').not.toMatch(
        /^--color-(band|grade)-/,
      );
    }
  });

  it('matches the type scale, in rem', () => {
    const cssName = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
    for (const [key, px] of Object.entries(FONT_SIZE)) {
      const name = cssName(key);
      expect(rem(theme.get(`--text-${name}`)!)).toBeCloseTo(px, 5);
      expect(Number(theme.get(`--text-${name}--line-height`))).toBe(
        LINE_HEIGHT[key as keyof typeof FONT_SIZE],
      );
      expect(theme.get(`--text-${name}--letter-spacing`)).toBe(
        `${TRACKING[key as keyof typeof FONT_SIZE]}em`,
      );
    }
  });

  it('matches the font stacks and the space, radius, and motion scales', () => {
    expect(theme.get('--font-display')).toBe(FONTS.display.stack);
    expect(theme.get('--font-text')).toBe(FONTS.text.stack);
    expect(theme.get('--font-mono')).toBe(FONTS.mono.stack);

    for (const [key, ms] of Object.entries(DURATION)) {
      expect(theme.get(`--duration-${key}`)).toBe(`${ms}ms`);
    }
    expect(theme.get('--ease-standard')).toBe(EASING.standard);
    expect(theme.get('--ease-exit')).toBe(EASING.exit);

    for (const [key, px] of Object.entries(SPACE)) {
      expect(rem(theme.get(`--spacing-${key}`)!)).toBeCloseTo(px, 5);
    }
    for (const [key, px] of Object.entries(RADIUS)) {
      const value = theme.get(`--radius-${key}`)!;
      // `pill` is the one deliberate px value — 999rem is not a radius, it is a mistake.
      expect(key === 'pill' ? Number.parseFloat(value) : rem(value)).toBeCloseTo(px, 5);
    }

    // Tailwind builds `max-w-*` from `--container-*`, so the CSS name is not the TS key:
    // `measureWide` is `--container-measure-wide`.
    for (const [key, value] of Object.entries(LAYOUT)) {
      const name = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      expect(theme.get(`--container-${name}`), `--container-${name}`).toBe(value);
    }
  });

  it('carries the control ladder for the CSS that cannot use a class', () => {
    // In px, not rem: `CONTROL_HEIGHT` is device-independent pixels and `controls.ts` spells it
    // `min-h-[34px]`, so a rem here would make one rung two heights. Exactly these three.
    for (const [key, px] of Object.entries(CONTROL_HEIGHT)) {
      expect(controlBlock.get(`--control-${key}`), `--control-${key}`).toBe(`${px}px`);
    }
    expect([...controlBlock.keys()].sort()).toEqual(
      Object.keys(CONTROL_HEIGHT)
        .map((key) => `--control-${key}`)
        .sort(),
    );
  });
});

describe('the palette is measured, not eyeballed', () => {
  const AA = 4.5;

  /** All four palettes, as `[mode, scheme]` pairs — nothing gets measured only in the dark. */
  const ALL = (['light', 'dark'] as Mode[]).flatMap((mode) =>
    (['field', 'sheet'] as Scheme[]).map((scheme) => [mode, scheme] as const),
  );

  it.each(ALL)('%s %s: every ink clears AA on both surfaces', (mode, scheme) => {
    const c = PALETTES[mode][scheme];
    for (const key of ['ink', 'inkMuted', 'contour', 'water', 'woodland', 'survey'] as const) {
      expect(contrast(c[key], c.canvas), `${key} on canvas`).toBeGreaterThanOrEqual(AA);
      expect(contrast(c[key], c.surface), `${key} on surface`).toBeGreaterThanOrEqual(AA);
    }
  });

  it.each(ALL)(
    '%s %s: keeps the five plates within a narrow band of each other',
    (mode, scheme) => {
      // The four coloured plates must read as peers; `ink` is exempt because structure is
      // allowed to outrank data.
      const c = PALETTES[mode][scheme];
      const ratios = (['contour', 'water', 'woodland', 'survey'] as const).map((k) =>
        contrast(c[k], c.canvas),
      );
      expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(3);
    },
  );

  it.each(['light', 'dark'] as Mode[])(
    '%s: separates the field surfaces enough to see and little enough to stay instrument',
    (mode) => {
      // On `field` the bezel hairline is the edge, not a shadow. Held in daylight too, which is
      // what forces the light field panel to white — see `FIELD_LIGHT`.
      const c = PALETTES[mode].field;
      const r = contrast(c.surface, c.canvas);
      expect(r).toBeGreaterThan(1.2);
      expect(r).toBeLessThan(1.6);
    },
  );

  it('reuses the plates for difficulty rather than adding a scale', () => {
    expect(Object.values(DIFFICULTY_PLATE)).toEqual(['woodland', 'contour', 'survey']);
    for (const plate of Object.values(DIFFICULTY_PLATE)) {
      expect(SCHEMES.sheet).toHaveProperty(plate);
    }
  });
});

describe('the grade ramp', () => {
  it('encodes severity twice — hue and hatch density', () => {
    // The second encoding survives any colour vision deficiency, but only if density is
    // strictly monotonic.
    const hatches = GRADE_STEPS.map((s) => s.hatch);
    expect(hatches).toEqual([...hatches].sort((a, b) => b - a));
    const bounds = GRADE_STEPS.map((s) => s.from);
    expect(bounds).toEqual([...bounds].sort((a, b) => a - b));
  });

  it('bands a gradient, and treats a descent as steep as the climb', () => {
    expect(gradeStep(0).label).toBe('Gentle');
    expect(gradeStep(0.049).label).toBe('Gentle');
    expect(gradeStep(0.05).label).toBe('Rolling');
    expect(gradeStep(0.18).label).toBe('Steep');
    expect(gradeStep(0.4).label).toBe('Very steep');
    expect(gradeStep(-0.4)).toEqual(gradeStep(0.4));
  });
});

describe('the React Native conversion', () => {
  it('turns line-height ratios into points', () => {
    // CSS's unitless 1.6 passed straight to React Native renders 1.6pt of line spacing.
    const body = nativeTextStyle('body');
    expect(body.fontSize).toBe(16);
    expect(body.lineHeight).toBe(Math.round(16 * LINE_HEIGHT.body));
    expect(body.lineHeight).toBeGreaterThan(body.fontSize);
  });

  it('turns em tracking into points', () => {
    // 0.14em on an 11pt label is 1.54pt. Passing 0.14 gives letterspacing you cannot see.
    expect(nativeTextStyle('micro').letterSpacing).toBeCloseTo(11 * TRACKING.micro, 2);
    expect(nativeTextStyle('h1').letterSpacing).toBeCloseTo(60 * TRACKING.h1, 2);
    expect(nativeTextStyle('body').letterSpacing).toBe(0);
  });

  it('ships the collar label as one fixed treatment', () => {
    expect(collarLabel.textTransform).toBe('uppercase');
    expect(collarLabel.fontFamily).toBe(NATIVE_FONTS.displayCondensed.bold);
    expect(collarLabel.fontSize).toBe(FONT_SIZE.micro);
    expect(collarLabel.letterSpacing).toBeGreaterThan(1);
  });

  it('carries weight in the family name and never as fontWeight', () => {
    // expo-font registers one family per file, so `Archivo` + `fontWeight: 600` resolves to
    // nothing, and emitting fontWeight too would make iOS synthesise a bold over the real one.
    const semibold = nativeTextStyle('h2', { weight: 'semibold' });
    expect(semibold.fontFamily).toBe('Archivo_600SemiBold');
    expect(semibold).not.toHaveProperty('fontWeight');
    expect(nativeTextStyle('caption', { family: 'mono', weight: 'medium' }).fontFamily).toBe(
      'IBMPlexMono_500Medium',
    );
  });

  it('names a fallback per role, so a failed load keeps the serif serif', () => {
    for (const family of Object.keys(NATIVE_FONTS) as (keyof typeof NATIVE_FONTS)[]) {
      expect(NATIVE_FALLBACKS[family]).toBeTruthy();
    }
    expect(NATIVE_FALLBACKS.text).toBe(FONTS.text.name);
  });
});
