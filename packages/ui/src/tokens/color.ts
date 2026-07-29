/**
 * The five-plate palette.
 *
 * A USGS quadrangle is printed from five colour separations and every hiker who reads
 * maps already knows the code. We borrow the separation and give each plate exactly one
 * job, so colour in this product is a legend rather than decoration. See `docs/design.md`
 * for the full direction; the rules that constrain code are repeated here.
 *
 * Every ink below clears 4.5:1 against every surface it is permitted on, and on the light
 * scheme the five land within 5.18–5.42 of each other deliberately — a legend where one
 * entry is louder is a hierarchy pretending to be a legend. `test/tokens.test.ts` measures
 * this, so an ink cannot be nudged without the measurement being re-made.
 */

/** The two surfaces. Not a user preference — two contexts with different jobs. */
export type Scheme = 'field' | 'sheet';

/**
 * Semantic colour roles. Every one of these changes value between schemes; anything
 * scheme-independent (the hypsometric ramp, the grade ramp) lives further down and is
 * deliberately not part of this type.
 */
export interface SchemeColors {
  /** Page/screen background. */
  canvas: string;
  /** Raised surface — cards, sheets, the panel floating over a map. */
  surface: string;
  /**
   * 1px rule. On `field` this is what separates surfaces, not a shadow: `surface` sits
   * only 1.27:1 above `canvas`, so the bezel line is the edge. Instrument, not dialog.
   */
  bezel: string;
  /** Primary text. */
  ink: string;
  /** Secondary text, collar labels, axis ticks. */
  inkMuted: string;

  /** Contour plate — elevation, gain/loss, grade, "moderate". */
  contour: string;
  contourWash: string;
  /** Water plate — weather, conditions, precipitation, freezing level. */
  water: string;
  waterWash: string;
  /** Woodland plate — the trail itself, surface type, confirmed state, "easy". */
  woodland: string;
  woodlandWash: string;
  /**
   * Survey plate — you, now. Live position, off-route, safety flags, "hard".
   *
   * Load-bearing rule: this colour means the user or their safety and nothing else. No
   * red buttons, no red "new" badges, no red on a delete that isn't dangerous. The moment
   * it appears decoratively it stops working on the ridge, which is the only place it has
   * to work.
   */
  survey: string;
  surveyWash: string;
}

/**
 * Washes are 8-digit hex rather than `color-mix()` or an opacity prop, because the same
 * literal has to work in a Tailwind utility and in a React Native style object. 0x1F is
 * ~12%, which reads as a tint on both canvases without either one turning muddy.
 *
 * **`inkMuted` is the quietest text either scheme has. Do not fade it further.** It is set
 * where it is on purpose. Against the four backgrounds it actually sits on it measures
 * 4.83:1 (field surface), 5.18:1 (sheet canvas), 5.96:1 (sheet surface) and 6.14:1 (field
 * canvas) — all clear of the 4.5:1 WCAG AA asks of body text, and the first of them only
 * just. An `/70`, an `/80`, or an `opacity-…` on top of it takes every one of those into
 * the threes: the same four, faded to 70%, measure 3.13, 2.88, 3.10 and 3.65. That is text
 * that stops being readable in daylight, which is the condition this product is used in.
 * Ten call sites had drifted into exactly that before `e2e/accessibility.spec.ts` was
 * written and caught them.
 *
 * When a third tier below `ink` and `ink-muted` seems necessary, it almost always isn't:
 * `ink` → `inkMuted` is already a drop from roughly 14:1 to 5:1, which is a large step and
 * plenty of hierarchy. Reach for size, weight, or space instead — all three recede without
 * costing legibility.
 *
 * **The same rule applies to the background, and that is the less obvious half.** Fading a
 * panel is arithmetically the same act as fading the text on it, and a panel that floats
 * over the *map* has no fixed backdrop to compute against — so its contrast is not low, it
 * is undefined, and it changes when the reader switches basemap. `surface` at 95 % holds
 * 4.90:1 over the dark app canvas and drops to 4.28:1 over a topo sheet and 4.15:1 over
 * snow; at 80 %, which is where the MapLibre scale bar sat, it reaches 2.53:1. Opaque, it
 * is 4.83:1 on every basemap there is. A scale bar is a measuring instrument, and the
 * conditions it most has to survive — bright imagery, low sun — are exactly the ones
 * translucency fails in.
 *
 * So: **anything floating over the map is opaque.** Eleven panels were not, and the axe run
 * could only ever catch the one that happened to be open at audit time. Translucency over a
 * *known* backdrop is fine and stays — the selected card in the Explore index is
 * `surface/60` over the app canvas at 5.38:1, and the photo-fallback plate is `bezel/30` at
 * 5.51:1 — because there the composite is a number you can actually compute.
 *
 * **A plate's own wash is a fill, not a text background.** The five inks are measured below
 * against `canvas` and `surface`, which are the two backgrounds the test knows about — and a
 * wash is neither. Laying a plate's text on its own 12 % tint costs about 0.8 of contrast and
 * is enough to fail: on the sheet, `survey` and `water` fall from 5.32 and 5.22 to **4.44**,
 * and `contour` lands on 4.54 with nothing to spare; on the field scheme `survey` over a card
 * goes from 4.68 to **4.03**. Which of those applies depends on whether the element happens to
 * sit on the page or inside a panel, so the figure is not merely low — like a translucent
 * panel over the map, it is undefined until you know the container.
 *
 * Washes are for fills the eye reads as area — a highlighted row, a drop target, a map
 * polygon. Text in a plate colour belongs on bare `canvas` or `surface`, where it measures
 * 4.68–8.47 and the number does not move.
 */
export const SCHEMES: Readonly<Record<Scheme, Readonly<SchemeColors>>> = {
  /** Dark. Anywhere the map is: browse, navigate, record. */
  field: {
    canvas: '#111819',
    surface: '#222D2F',
    bezel: '#2E3B3D',
    ink: '#EAEFE9',
    inkMuted: '#8D9A93',

    contour: '#D9975A',
    contourWash: '#D9975A1F',
    water: '#63B8D6',
    waterWash: '#63B8D61F',
    woodland: '#8FBF7A',
    woodlandWash: '#8FBF7A1F',
    survey: '#F2695C',
    surveyWash: '#F2695C1F',
  },

  /**
   * Light. Anywhere you are reading: descriptions, reviews, settings, the website's prose.
   *
   * The canvas is a woodland-tinted paper — the green-grey vegetation overprint of an
   * Ordnance Survey sheet — not the cream that every generated site converges on.
   */
  sheet: {
    canvas: '#EDF0EA',
    surface: '#FFFFFF',
    bezel: '#C9D0C4',
    ink: '#161C1D',
    inkMuted: '#5C6660',

    contour: '#8A5524',
    contourWash: '#8A55241F',
    water: '#1F6A8C',
    waterWash: '#1F6A8C1F',
    woodland: '#3F6B36',
    woodlandWash: '#3F6B361F',
    survey: '#B4322A',
    surveyWash: '#B4322A1F',
  },
} as const;

/**
 * Light or dark. The reader's choice, and orthogonal to `Scheme`.
 *
 * These are two different questions and conflating them is the mistake this type exists to
 * prevent. `Scheme` asks *what is this surface for* — instrument chrome beside a map, or
 * paper to read. `Mode` asks *how bright is the room*. A trail description is a reading
 * page at midnight and a reading page at noon; it should not become the map's chrome
 * because the sun went down.
 */
export type Mode = 'light' | 'dark';

/**
 * Field, lit. The instrument chrome in daylight.
 *
 * Not `sheet` with a different name. The chrome sits *behind* the map and the map is the
 * brightest thing in the frame, so this canvas is a step darker than reading paper and the
 * bezel a step stronger — the same relationship `field` has to `sheet` in the dark, kept
 * intact when the lights come on. The four plates are the sheet inks, which are the ones
 * measured for light backgrounds; re-tuning them would give the same trail two greens
 * depending on which panel it was named in.
 *
 * `surface` is white rather than a tint, and that is forced arithmetic rather than taste.
 * The dark scheme holds `surface` 1.27:1 above `canvas` so the bezel hairline reads as the
 * edge; light luminances sit near the ceiling, so the only way to keep that separation on a
 * canvas dark enough to sit behind a map is to take the panel all the way up. #f5f7f3 over
 * this canvas measures 1.14:1 — a panel you cannot see the edge of.
 */
const FIELD_LIGHT: Readonly<SchemeColors> = {
  canvas: '#E4E9E3',
  surface: '#FFFFFF',
  bezel: '#BFC7BA',
  ink: '#131819',
  inkMuted: '#545E58',

  contour: '#8A5524',
  contourWash: '#8A55241F',
  water: '#1F6A8C',
  waterWash: '#1F6A8C1F',
  woodland: '#3F6B36',
  woodlandWash: '#3F6B361F',
  survey: '#B4322A',
  surveyWash: '#B4322A1F',
};

/**
 * Sheet, unlit. Paper read at night.
 *
 * Its canvas is *lighter* than `field`'s, which looks backwards written down and is right
 * on screen: in the dark the reading surface is the thing you are looking at and the chrome
 * around it recedes, exactly as it does in daylight. Inverting that — making the article
 * darker than the app around it — is how a dark theme ends up with the text sitting in a
 * hole. Plates are the field inks, for the same reason `FIELD_LIGHT` borrows the sheet's.
 */
const SHEET_DARK: Readonly<SchemeColors> = {
  canvas: '#1A2122',
  surface: '#232B2D',
  bezel: '#333E40',
  ink: '#EDF1EB',
  inkMuted: '#96A29C',

  contour: '#D9975A',
  contourWash: '#D9975A1F',
  water: '#63B8D6',
  waterWash: '#63B8D61F',
  woodland: '#8FBF7A',
  woodlandWash: '#8FBF7A1F',
  survey: '#F2695C',
  surveyWash: '#F2695C1F',
};

/**
 * Every palette, by mode and then by scheme — four in total.
 *
 * Two of the four are `SCHEMES` itself, aliased rather than copied: `SCHEMES.field` was
 * always the dark instrument and `SCHEMES.sheet` the light paper, so adding a mode axis
 * does not change a single existing colour. That is the whole reason `SCHEMES` survives
 * unchanged and every map style, print sheet and React Native screen that reads it keeps
 * working. Read `SCHEMES` when you want the palette a *thing* is drawn in — a trail line,
 * a printed contour — and `PALETTES` when you want the palette a *reader* has chosen.
 */
export const PALETTES: Readonly<Record<Mode, Readonly<Record<Scheme, Readonly<SchemeColors>>>>> = {
  light: { field: FIELD_LIGHT, sheet: SCHEMES.sheet },
  dark: { field: SCHEMES.field, sheet: SHEET_DARK },
} as const;

/**
 * Hypsometric tinting — the elevation ramp used on relief maps, low ground to snowline.
 *
 * Scheme-independent on purpose. This is cartography, not chrome: a 2,400 m band is the
 * same colour on paper, on the phone at night, and on the website, exactly as it would be
 * on a printed sheet. Fills only; text never sits on these.
 */
export const ELEVATION_BANDS = [
  '#3E5D3A', // valley woodland
  '#61793F', // upland pasture
  '#9A9350', // open moor
  '#B08B50', // scree, tan
  '#8E6242', // rock
  '#7C6A62', // talus, bare rock
  '#D8D6CF', // permanent snow and ice
] as const;

/**
 * Grade ramp for the section's hatched terrain fill and the map's slope-angle overlay.
 *
 * `hatch` is the line spacing in CSS px / dp for the fill pattern, and it is the reason
 * this ramp is worth having: density encodes severity independently of hue, so a reader
 * with any colour vision deficiency still gets the gradient. Tighter lines, steeper ground.
 */
export interface GradeStep {
  /** Inclusive lower bound of the band, as a fraction (0.05 = 5 %). */
  from: number;
  color: string;
  /** Hatch line spacing in px. Smaller is denser is steeper. */
  hatch: number;
  label: string;
}

export const GRADE_STEPS: readonly GradeStep[] = [
  { from: 0, color: '#7FA36B', hatch: 9, label: 'Gentle' },
  { from: 0.05, color: '#B5A55A', hatch: 7, label: 'Rolling' },
  { from: 0.1, color: '#C98A47', hatch: 5, label: 'Sustained climb' },
  { from: 0.15, color: '#B4603A', hatch: 3.5, label: 'Steep' },
  { from: 0.25, color: '#8E3A2E', hatch: 2, label: 'Very steep' },
] as const;

/** Pick the grade band for a gradient fraction. Negative grades use their magnitude. */
export function gradeStep(grade: number): GradeStep {
  const g = Math.abs(grade);
  let step = GRADE_STEPS[0] as GradeStep;
  for (const candidate of GRADE_STEPS) if (g >= candidate.from) step = candidate;
  return step;
}

/**
 * Busyness — the culture plate, which prints in black.
 *
 * On a quadrangle the culture plate carries the works of man; crowds are works of man, so
 * busy times are drawn in `ink` at four coverages and no hue at all. That leaves the four
 * coloured plates meaning what they mean everywhere else: red is still the reader's safety,
 * blue is still the weather. The numbers are percentages of full ink, one per published
 * level, chosen so adjacent steps are distinguishable at a 12pt cell on a phone.
 *
 * Four steps rather than a continuous ramp, because the model publishes four named levels.
 * A gradient would look more precise and would be a lie about a modelled number.
 *
 * The keys are written out rather than imported from `@switchback/core`'s `BUSYNESS_LEVELS`
 * — this package has no dependencies on purpose, which is what lets a Next.js server
 * bundle, a browser and Hermes all read it. `satisfies` is what keeps the list honest.
 */
export const BUSYNESS_INK = {
  quiet: 8,
  moderate: 30,
  busy: 58,
  packed: 88,
} as const satisfies Record<string, number>;

/**
 * A token colour at partial coverage, as 8-digit hex.
 *
 * React Native has no `color-mix()` and no CSS custom properties, so a tint that the web
 * writes as `color-mix(in srgb, var(--color-ink) 30%, transparent)` has to be resolved to
 * a literal here. Alpha rather than a blend toward the canvas so the same call works on
 * both schemes — `field` and `sheet` have opposite backgrounds and a pre-blended tint
 * would be wrong on one of them.
 */
export function withAlpha(hex: string, percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const alpha = Math.round((clamped / 100) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex.slice(0, 7)}${alpha}`;
}

/**
 * Difficulty reuses the plates rather than introducing a fourth scale — and "hard" being
 * the survey plate is a claim, not a convenience: at that point difficulty is a safety
 * statement, which is what red is for.
 */
export const DIFFICULTY_PLATE = {
  easy: 'woodland',
  moderate: 'contour',
  hard: 'survey',
} as const satisfies Record<string, keyof SchemeColors>;

export type Difficulty = keyof typeof DIFFICULTY_PLATE;

/**
 * Trail conditions, sorted onto the plates rather than given thirteen colours.
 *
 * Thirteen tags in thirteen hues is a rainbow, and a rainbow is what a legend looks like
 * once it has stopped meaning anything. So each tag takes the plate that already owns what
 * it is a fact *about*, and most of them take none at all:
 *
 * - **survey** — closed, washed out, flooded, icy, poorly marked. The reader's safety, which
 *   is the only thing red is ever allowed to mean. "Poorly marked" is in here rather than
 *   with the nuisances because being unable to find the path is how people end up out after
 *   dark, and it belongs beside the ford that has gone.
 * - **water** — dry, muddy, snow. Ground conditions, which is a fact about precipitation.
 *   These three share a plate because they are the trio a hiker compares to pick boots, and
 *   a shared colour is what lets the eye group them across a list of reports.
 * - **woodland** — well marked. The plate of the trail itself, in good order.
 * - **`null`** — overgrown, fallen trees, bugs, crowded. Worth reporting, genuinely nobody's
 *   safety. A tag with no plate prints as a hairline chip in muted ink, which is the honest
 *   rendering of "noted".
 *
 * Crowded is deliberately *not* the culture plate: busyness prints in black at four
 * coverages, and a chip that borrowed one of them would read as a level rather than a tag.
 */
export const CONDITION_PLATE = {
  closed: 'survey',
  washed_out: 'survey',
  flooded: 'survey',
  icy: 'survey',
  poorly_marked: 'survey',

  dry: 'water',
  muddy: 'water',
  snow: 'water',

  well_marked: 'woodland',

  overgrown: null,
  blowdown: null,
  bugs: null,
  crowded: null,
} as const satisfies Record<string, keyof SchemeColors | null>;
