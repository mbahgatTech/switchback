/**
 * Space, radius, and layout. A 4px grid, graduated rather than linear — for the same reason a
 * map scale bar runs 0-1-2-5-10.
 */
export const SPACE = {
  none: 0,
  hair: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
  '4xl': 64,
  '5xl': 96,
  '6xl': 128,
  '7xl': 192,
} as const;

export type SpaceName = keyof typeof SPACE;

/**
 * Near-square, as printed sheets and instruments are. `pill` is for exactly one thing — the
 * live position dot — and using it elsewhere stops that dot reading as "you".
 */
export const RADIUS = {
  none: 0,
  hair: 2,
  panel: 4,
  pill: 999,
} as const;

/**
 * 1 CSS px on the web. React Native prefers `StyleSheet.hairlineWidth` (one *device* pixel);
 * `native.ts` makes that substitution so call sites do not have to.
 */
export const HAIRLINE = 1;

/**
 * How wide a column of anything is allowed to get. Values carry their unit because they are
 * consumed as CSS `--container-*` variables, which Tailwind turns into `max-w-*`; `theme.css`
 * mirrors them and `packages/ui/test/tokens.test.ts` fails the build when the two drift.
 *
 * Prose is in `ch` because a measure is a claim about characters per line (45–75), which stays
 * true when the serif is set at caption size. Rails are in `px` because they are a claim about
 * the window.
 */
export const LAYOUT = {
  /** Prose that shares its line with something else — a card, a photo, a form, a map. */
  measure: '54ch',
  /** Prose that *is* the page. The long reads: attribution, a lifeline briefing, a report. */
  measureWide: '62ch',
  /** The website's content rail. The map itself is always edge-to-edge. */
  rail: '1080px',
  /** The print sheet, which is paper and holds a map plus its margin notes. */
  sheet: '1180px',
} as const;

/**
 * How tall a control is, in device-independent pixels. Three rungs, and no fourth: the number
 * is decided here so both clients derive from it — `HEIGHT` in
 * `apps/web/src/components/controls.ts`, and `minHeight` in the phone's stylesheets.
 *
 * Pick a rung by **who is pressing it**, never by how important the control is:
 * - `panel` — a pointer indoors, in a dense rail; or a small mark carrying its own `hitSlop`.
 * - `touch` — a finger. 48 rather than the 44 of Apple's HIG and WCAG 2.5.5, which are floors:
 *   this is pressed with cold hands, in gloves, on the move.
 * - `field` — a gloved hand, mid-hike, looking at the trail. Start, pause, finish.
 *
 * `apps/web/test/conventions.test.ts` fails the build on a fourth rung, or on a web `HEIGHT`
 * that has drifted from these.
 */
export const CONTROL_HEIGHT = {
  panel: 34,
  touch: 48,
  field: 56,
} as const;

export type ControlHeightName = keyof typeof CONTROL_HEIGHT;

/**
 * Motion is instrument motion: decisive, short, and only where it means something. `section` is
 * the one long duration — the elevation profile plotting itself, once per trail.
 */
export const DURATION = {
  instant: 0,
  quick: 120,
  base: 200,
  slow: 320,
  section: 640,
} as const;

export const EASING = {
  /** Fast out, settle in. The needle arriving. */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** Leaving does not need to be watched. */
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

/**
 * `prefers-reduced-motion` collapses every duration to zero and the section renders complete —
 * not a gentler animation, none. A value rather than a media query so React Native can apply the
 * same rule from `AccessibilityInfo`.
 */
export const REDUCED_MOTION_DURATION = 0;
