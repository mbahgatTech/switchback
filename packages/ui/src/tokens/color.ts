/**
 * The five-plate palette, borrowed from USGS quadrangle colour separations: each plate has
 * exactly one meaning. Direction in `docs/design.md`; `test/tokens.test.ts` measures contrast.
 */

/** The two surfaces. Not a user preference — two contexts with different jobs. */
export type Scheme = 'field' | 'sheet';

/** Semantic colour roles. Every one changes value between schemes; scheme-independent ramps live below. */
export interface SchemeColors {
  /** Page/screen background. */
  canvas: string;
  /** Raised surface — cards, sheets, the panel floating over a map. */
  surface: string;
  /**
   * 1px rule. On `field` this is what separates surfaces, not a shadow: `surface` sits only
   * 1.27:1 above `canvas`, so the bezel line is the edge.
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
   * Means the user or their safety and nothing else; decorative use breaks it on the ridge.
   */
  survey: string;
  surveyWash: string;
}

/**
 * Washes are 8-digit hex, not `color-mix()`, so one literal works in both a Tailwind utility
 * and a React Native style object. 0x1F is ~12%.
 *
 * Three contrast rules the tests and `e2e/accessibility.spec.ts` enforce:
 * - **Never fade `inkMuted` further.** It sits at 4.83–6.14:1; at 70% opacity all four land in the threes.
 * - **Anything floating over the map is opaque.** Its backdrop is unknown, so a faded panel's
 *   contrast is undefined, not merely low. Translucency over a known backdrop is fine.
 * - **A plate's own wash is a fill, not a text background.** Plate text on its own 12% tint
 *   costs ~0.8 of contrast and fails. Plate text belongs on bare `canvas` or `surface`.
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
   * Light. Anywhere you are reading: descriptions, reviews, settings, prose.
   * The canvas is a woodland-tinted paper (an Ordnance Survey vegetation overprint), not cream.
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
 * Light or dark — the reader's choice, orthogonal to `Scheme`. `Scheme` asks what a surface
 * is for (map chrome or reading paper); `Mode` asks how bright the room is.
 */
export type Mode = 'light' | 'dark';

/**
 * Field, lit. Instrument chrome in daylight — a step darker than reading paper, because the
 * map is the brightest thing in the frame. Plates are the sheet inks, measured for light backgrounds.
 *
 * `surface` is white by arithmetic, not taste: light luminances sit near the ceiling, so it is
 * the only value that keeps the 1.27:1 bezel separation over a canvas dark enough to back a map.
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
 * Sheet, unlit. Paper read at night. Its canvas is deliberately *lighter* than `field`'s: the
 * reading surface is what you look at and the chrome recedes, as it does in daylight.
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
 * Every palette, by mode then scheme. Two of the four alias `SCHEMES` rather than copy it, so
 * adding the mode axis changed no existing colour. Read `SCHEMES` for the palette a *thing* is
 * drawn in (a trail line, a printed contour); `PALETTES` for the one a *reader* chose.
 */
export const PALETTES: Readonly<Record<Mode, Readonly<Record<Scheme, Readonly<SchemeColors>>>>> = {
  light: { field: FIELD_LIGHT, sheet: SCHEMES.sheet },
  dark: { field: SCHEMES.field, sheet: SHEET_DARK },
} as const;

/**
 * Hypsometric tinting — the relief-map elevation ramp, low ground to snowline. Scheme-independent
 * on purpose: this is cartography, so a band is one colour on paper, phone and web. Fills only.
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
 * `hatch` encodes severity as line density independently of hue, so the gradient survives
 * any colour vision deficiency.
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
 * Busyness — the culture plate, which prints in black. Crowds are works of man, so busy times
 * are `ink` at four coverages and no hue, leaving the coloured plates their meanings. Four
 * discrete steps because the model publishes four named levels; a gradient would imply precision
 * the number does not have. Keys are literal, not imported from core, to keep this package
 * dependency-free; `satisfies` keeps them honest.
 */
export const BUSYNESS_INK = {
  quiet: 8,
  moderate: 30,
  busy: 58,
  packed: 88,
} as const satisfies Record<string, number>;

/**
 * A token colour at partial coverage, as 8-digit hex. React Native has no `color-mix()`, so
 * tints resolve to literals. Alpha rather than a pre-blend, so one call works on both schemes.
 */
export function withAlpha(hex: string, percent: number): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const alpha = Math.round((clamped / 100) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${hex.slice(0, 7)}${alpha}`;
}

/**
 * Difficulty reuses the plates rather than adding a scale. "Hard" takes survey because at that
 * point difficulty is a safety statement.
 */
export const DIFFICULTY_PLATE = {
  easy: 'woodland',
  moderate: 'contour',
  hard: 'survey',
} as const satisfies Record<string, keyof SchemeColors>;

export type Difficulty = keyof typeof DIFFICULTY_PLATE;

/**
 * Trail conditions sorted onto the plates rather than given thirteen hues. Each tag takes the
 * plate owning the fact it is about: survey for the reader's safety (poorly marked included —
 * losing the path is how people end up out after dark), water for ground conditions, woodland
 * for a trail in good order, `null` for nuisances, which print as a muted hairline chip.
 * Crowded is deliberately not the culture plate — it would read as a busyness level, not a tag.
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
