/**
 * Type tokens.
 *
 * Inverted from the software default, because field guides invert it: gothic plate
 * headers, serif descriptive text. Archivo carries every label, heading, and number;
 * Source Serif carries anything read in paragraphs; Plex Mono is scoped to coordinates,
 * grid references, and axis ticks and appears nowhere else.
 */

export interface FontRole {
  /** Canonical family name — what expo-font registers and what the CSS stack names first. */
  name: string;
  /** Full CSS stack for the web. The `var()` is the next/font variable in apps/web. */
  stack: string;
}

export const FONTS = {
  /** Wordmark, headings, all UI labels and numbers. Variable: weight 100–900, width 62–125. */
  display: {
    name: 'Archivo',
    stack: "var(--font-archivo), ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  },
  /**
   * Prose. Its italic carries the hydrography convention — water features are always
   * italic on a topo sheet, so weather and conditions narrative is set in italic serif.
   */
  text: {
    name: 'Source Serif 4',
    stack: "var(--font-source-serif), ui-serif, Georgia, 'Times New Roman', serif",
  },
  /** Coordinates, grid references, section axis ticks. Nothing else. */
  mono: {
    name: 'IBM Plex Mono',
    stack: 'var(--font-plex-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
  },
} as const satisfies Record<string, FontRole>;

export type FontRoleName = keyof typeof FONTS;

/**
 * Graduated like an altimeter rather than stepped by a modular ratio. The jumps widen as
 * they climb, which is what lets a page carry a 60px number and an 11px collar label
 * without anything in between looking like a mistake.
 */
export const FONT_SIZE = {
  /** Collar labels only — uppercase, condensed, tracked. */
  micro: 11,
  caption: 13,
  body: 16,
  bodyLg: 18,
  title: 21,
  h4: 26,
  h3: 33,
  h2: 44,
  h1: 60,
  display: 80,
} as const;

export type FontSizeName = keyof typeof FONT_SIZE;

/** Unitless multipliers. Tightens as size grows — 80px does not want 1.6. */
export const LINE_HEIGHT: Readonly<Record<FontSizeName, number>> = {
  micro: 1.4,
  caption: 1.45,
  body: 1.6,
  bodyLg: 1.6,
  title: 1.35,
  h4: 1.25,
  h3: 1.2,
  h2: 1.1,
  h1: 1.05,
  display: 1,
} as const;

/**
 * In em, so it scales with the size it is applied to. Archivo's wide sizes need negative
 * tracking to stop looking loose; `micro` goes the other way because collar text on a map
 * sheet is letterspaced.
 */
export const TRACKING: Readonly<Record<FontSizeName, number>> = {
  micro: 0.14,
  caption: 0.01,
  body: 0,
  bodyLg: 0,
  title: -0.01,
  h4: -0.015,
  h3: -0.02,
  h2: -0.025,
  h1: -0.03,
  display: -0.035,
} as const;

export const FONT_WEIGHT = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/**
 * Archivo's width axis, and the restraint valve for the whole system.
 *
 * `normal` does all the ordinary work. `condensed` exists for one treatment — the collar
 * label: 11px, uppercase, +0.14em, used only where a map sheet would print marginalia
 * (section eyebrows, stat labels, legend keys). Applied everywhere it becomes wallpaper,
 * and the direction stops meaning anything.
 */
export const FONT_WIDTH = {
  condensed: 78,
  normal: 100,
} as const;
