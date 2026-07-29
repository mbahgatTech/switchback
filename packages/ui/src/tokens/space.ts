/**
 * Space, radius, and layout.
 *
 * A 4px grid, but graduated rather than linear — the same reason a map scale bar is
 * 0-1-2-5-10 and not 1-2-3-4-5. Adjacent steps at the small end need to be
 * distinguishable; at the large end they need to be different enough to mean something.
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
 * Near-square. Printed sheets have no radius at all and instruments have a small one;
 * zero would put us in the hairline-broadsheet look, which is a different product's
 * design. `pill` exists for exactly one thing — the live position dot — and using it
 * anywhere else makes that dot stop reading as "you".
 */
export const RADIUS = {
  none: 0,
  hair: 2,
  panel: 4,
  pill: 999,
} as const;

/**
 * 1 CSS px on the web. React Native should prefer `StyleSheet.hairlineWidth`, which is one
 * *device* pixel and is the thinner, correcter line on a retina screen — `native.ts`
 * exposes that substitution rather than making every call site remember it.
 */
export const HAIRLINE = 1;

/**
 * How wide a column of anything is allowed to get.
 *
 * Every value here is a string with its unit attached, because these are consumed as CSS
 * `--container-*` variables — Tailwind reads that namespace to generate `max-w-*`, so
 * `measure` below *is* `max-w-measure`. `theme.css` mirrors them and
 * `packages/ui/test/tokens.test.ts` fails the build when the two drift.
 *
 * The previous version of this block declared one measure and one rail and was read by
 * nothing at all — the same failure the height ladder had. What the website had actually
 * grown in its place was eight prose widths (36, 38, 46, 48, 52, 54, 62, 78ch) and two
 * page rails, with 54 and 62 accounting for forty-nine of the fifty-five paragraphs and
 * the six strays being ordinary sentences that wrap identically at 54. So: two measures,
 * two rails, and the numbers are the ones the pages were already using rather than the
 * ones the token wished they were.
 *
 * **Why `ch` for prose and `px` for rails.** A measure is a claim about how many
 * characters fit on a line before the eye loses the return sweep — 45 to 75 of them, which
 * is a fact about reading and not about screens. In `ch` it stays true when the serif is
 * set at caption size; in pixels it would silently become 90 characters. A rail is the
 * opposite: it is a claim about the window, and the window is measured in pixels.
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
 * How tall a control is, in device-independent pixels. Three rungs, and no fourth.
 *
 * This lives beside the spacing scale rather than in either client because the two clients
 * had each answered it separately and had answered it differently: the website's ladder was
 * 34/44/52, the phone used 44 and 48 in roughly equal numbers with strays at 38, 40 and 46,
 * and a token here called `tapTarget: 48` — documented as *the* minimum, cold hands and all —
 * was referenced by neither. Three decisions about one number is not a system; it is three
 * products that happen to share a repository. So the number is decided once, here, and both
 * clients derive from it: `HEIGHT` in `apps/web/src/components/controls.ts` as Tailwind
 * minimums, and `minHeight` in the phone's stylesheets directly.
 *
 * Picking a rung is a decision about **who is pressing it**, never about how important the
 * control is:
 *
 * - `panel` — a pointer, indoors, in a dense rail of other controls; or a small mark that
 *   carries its own `hitSlop` to reach the touch rung without growing. Filters, the print
 *   options, the planner bar, a chip. Nothing here is pressed while moving.
 * - `touch` — a finger. Anything over the map, anything on a phone, and every control on the
 *   record and Lifeline screens. **48 rather than the 44 named by Apple's HIG and WCAG 2.5.5**,
 *   which are floors rather than targets: a trail is walked with cold hands, in gloves, on the
 *   move, and the four extra pixels cost nothing anywhere they are spent.
 * - `field` — a gloved hand, outdoors, mid-hike, looking at the trail rather than the screen.
 *   Start, pause, finish, and the rows of an over-map picker where the whole row is the target.
 *
 * `apps/web/test/conventions.test.ts` fails the build on a fourth, and on a web `HEIGHT` whose
 * pixel values have drifted from these.
 */
export const CONTROL_HEIGHT = {
  panel: 34,
  touch: 48,
  field: 56,
} as const;

export type ControlHeightName = keyof typeof CONTROL_HEIGHT;

/**
 * Motion is instrument motion: decisive, short, and only where it means something.
 *
 * `section` is the one long duration in the system — the elevation profile plotting itself
 * left to right on first paint, once per trail. Everything else is 120–200ms.
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
 * `prefers-reduced-motion` collapses every duration to zero and the section renders
 * complete — not a gentler animation, none. Exported as a value so React Native, which
 * has no media query, applies the same rule from `AccessibilityInfo`.
 */
export const REDUCED_MOTION_DURATION = 0;
