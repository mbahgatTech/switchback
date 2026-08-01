/**
 * Type tokens, inverted from the software default the way field guides invert it: Archivo (gothic)
 * for labels, headings and numbers; Source Serif for prose; Plex Mono only for coordinates,
 * grid references and axis ticks.
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
  /** Prose. Its italic carries the hydrography convention: weather and conditions narrative. */
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
 * Graduated like an altimeter rather than by a modular ratio: the jumps widen as they climb, so a
 * page can carry a 60px number and an 11px collar label with nothing between looking wrong.
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
 * In em, so it scales with the size applied to. Archivo's wide sizes need negative tracking;
 * `micro` goes the other way because collar text on a map sheet is letterspaced.
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
 * Archivo's width axis. `condensed` exists for one treatment — the collar label (11px, uppercase,
 * +0.14em, marginalia only). Applied everywhere it becomes wallpaper and stops meaning anything.
 */
export const FONT_WIDTH = {
  condensed: 78,
  normal: 100,
} as const;
