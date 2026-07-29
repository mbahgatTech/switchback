/**
 * Trail difficulty.
 *
 * The base score is the Shenandoah National Park hiking-difficulty rating, which is
 * the most widely cited objective formula in US trail guides:
 *
 *     rating = sqrt(elevation_gain_ft * 2 * distance_mi)
 *
 * Expressed in metric inputs, the unit conversions fold into a single constant:
 *
 *     rating = sqrt(SHENANDOAH_METRIC_CONSTANT * gain_m * distance_km)
 *
 * That score alone is not enough, because it is blind to terrain. A 1.5 km scramble
 * with 300 m of gain scores 43 — "easy" — while actually requiring hands and a head
 * for exposure. So OSM's `sac_scale` acts as a floor, and sustained steepness bumps
 * the result up a band. Both adjustments only ever raise difficulty, never lower it.
 *
 * @see https://www.nps.gov/shen/planyourvisit/how-to-determine-hiking-difficulty.htm
 * @see https://wiki.openstreetmap.org/wiki/Key:sac_scale
 */

export const DIFFICULTIES = ['easy', 'moderate', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/**
 * What a difficulty band is called on screen.
 *
 * Here rather than in each surface that prints one, because it had been written out three
 * times — the filter chips, the trail card and the selection panel — and a fourth was about
 * to be written for the route planner. Three copies of a display string is where a product
 * starts saying "Moderate" in one place and "Medium" in another.
 */
export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: 'Easy',
  moderate: 'Moderate',
  hard: 'Hard',
};

export const SAC_SCALES = [
  'hiking',
  'mountain_hiking',
  'demanding_mountain_hiking',
  'alpine_hiking',
  'demanding_alpine_hiking',
  'difficult_alpine_hiking',
] as const;
export type SacScale = (typeof SAC_SCALES)[number];

/** Shenandoah band edges. Below 50 is easy; 50–99 moderate; 100+ hard. */
const BAND_MODERATE = 50;
const BAND_HARD = 100;

/**
 * Metric-input constant for the Shenandoah formula (see module docs).
 *
 * Derived from the international definitions — 1 ft = 0.3048 m and 1 mi = 1609.344 m, both
 * exact — rather than written as a rounded literal. Rounded conversion factors compound:
 * `3.28084 * 2 * 0.621371` gives 4.07742, which is off in the fifth digit and pulls our
 * ratings away from the published NPS numbers we validate against.
 */
export const SHENANDOAH_METRIC_CONSTANT = (1 / 0.3048) * 2 * (1000 / 1609.344);

/** Minimum difficulty implied by terrain class, regardless of length or gain. */
const SAC_FLOOR: Record<SacScale, Difficulty> = {
  hiking: 'easy',
  mountain_hiking: 'easy',
  demanding_mountain_hiking: 'moderate',
  alpine_hiking: 'hard',
  demanding_alpine_hiking: 'hard',
  difficult_alpine_hiking: 'hard',
};

const RANK: Record<Difficulty, number> = { easy: 0, moderate: 1, hard: 2 };

export interface DifficultyInput {
  /** Total ascent in metres. */
  gainM: number;
  /** Trail length in metres. */
  lengthM: number;
  /** OSM sac_scale, when the source data carries one. */
  sacScale?: SacScale | null;
  /**
   * Steepest sustained grade as a fraction (0.25 = 25%), measured over a window
   * rather than between adjacent samples so DEM noise doesn't dominate.
   */
  maxSustainedGrade?: number | null;
}

export interface DifficultyResult {
  difficulty: Difficulty;
  /** Raw Shenandoah score, useful for sorting within a band. */
  score: number;
  /** Which inputs pushed the result above the raw score, for UI explanation. */
  raisedBy: Array<'sac_scale' | 'sustained_grade'>;
}

/** Raw Shenandoah numerical rating. Exported for sorting and for tests. */
export function shenandoahScore(gainM: number, lengthM: number): number {
  if (!Number.isFinite(gainM) || !Number.isFinite(lengthM)) return 0;
  const gain = Math.max(0, gainM);
  const distanceKm = Math.max(0, lengthM) / 1000;
  return Math.sqrt(SHENANDOAH_METRIC_CONSTANT * gain * distanceKm);
}

function bandFromScore(score: number): Difficulty {
  if (score >= BAND_HARD) return 'hard';
  if (score >= BAND_MODERATE) return 'moderate';
  return 'easy';
}

function raise(current: Difficulty, floor: Difficulty): Difficulty {
  return RANK[floor] > RANK[current] ? floor : current;
}

export function classifyDifficulty(input: DifficultyInput): DifficultyResult {
  const score = shenandoahScore(input.gainM, input.lengthM);
  let difficulty = bandFromScore(score);
  const raisedBy: DifficultyResult['raisedBy'] = [];

  if (input.sacScale) {
    const floor = SAC_FLOOR[input.sacScale];
    const next = raise(difficulty, floor);
    if (next !== difficulty) {
      difficulty = next;
      raisedBy.push('sac_scale');
    }
  }

  // A sustained pitch above 25% is strenuous whatever the total numbers say;
  // above 35% it is hard regardless of how short the trail is.
  const grade = input.maxSustainedGrade ?? null;
  if (grade !== null && Number.isFinite(grade)) {
    const floor: Difficulty | null = grade >= 0.35 ? 'hard' : grade >= 0.25 ? 'moderate' : null;
    if (floor) {
      const next = raise(difficulty, floor);
      if (next !== difficulty) {
        difficulty = next;
        raisedBy.push('sustained_grade');
      }
    }
  }

  return { difficulty, score, raisedBy };
}

/**
 * Ground too steep to hike up.
 *
 * "Hard" is the top band, and that is a problem the day the catalogue ingests something
 * like Mount Assiniboine — an OSM way tagged as a route, 6.9 km long, 1,981 m of ascent,
 * and a sustained grade of 147 %. Every one of those numbers is correct. Read together
 * under the word "Hard" they describe a long day out, and the thing they actually describe
 * is a technical alpine climb with a 55° face on it. A difficulty band cannot carry that,
 * because the scale it lives on ends before the terrain does.
 *
 * So this is a separate claim rather than a fourth band. Difficulty answers "how big a
 * day"; this answers "is this a hike at all", and the two are independent — a short steep
 * gully scores "easy" and still wants your hands.
 *
 * The thresholds are the ones the ground itself sets, not round numbers:
 *
 * - **70 % (35°)** is where a hiker starts using their hands on the way up. Below it a
 *   graded path can switchback; above it there is nowhere to put the switchback.
 * - **100 % (45°)** is where it stops being scrambling. Snow at this angle slides, rock at
 *   this angle is climbed rather than ascended, and no amount of fitness substitutes.
 *
 * Measured over `GRADE_WINDOW_M` — a hundred metres of ground, not one DEM sample — so a
 * single noisy pixel cannot trip it. What *can* still trip it honestly is a line that
 * crosses a cliff, which is exactly the case worth warning about.
 */
export const TERRAIN_CAUTIONS = ['scramble', 'climbing'] as const;
export type TerrainCaution = (typeof TERRAIN_CAUTIONS)[number];

/** 35° — hands come out of pockets. */
const SCRAMBLE_GRADE = 0.7;
/** 45° — it is a climb. */
const CLIMBING_GRADE = 1.0;

export function terrainCaution(
  maxSustainedGrade: number | null | undefined,
): TerrainCaution | null {
  if (maxSustainedGrade == null || !Number.isFinite(maxSustainedGrade)) return null;
  if (maxSustainedGrade >= CLIMBING_GRADE) return 'climbing';
  if (maxSustainedGrade >= SCRAMBLE_GRADE) return 'scramble';
  return null;
}

/**
 * What to say about it, in the product's own voice.
 *
 * Two sentences each: what the ground does, then where the figure came from. The second is
 * not a hedge — the grade is read off a 20 m elevation model, and on a cliff a model that
 * coarse is describing the cliff rather than the path across it. Someone standing at the
 * trailhead deciding whether to go up deserves to know which of those they are reading.
 */
export const TERRAIN_CAUTION_COPY: Record<TerrainCaution, { title: string; body: string }> = {
  scramble: {
    title: 'Steep enough to need your hands',
    body: 'Part of this line is steeper than a hiking path can be graded, so expect scrambling rather than hiking. The figure comes from an elevation model, which reads a crag as steeper than the path picking its way up it — check a guidebook before you commit.',
  },
  climbing: {
    title: 'This is a climbing route, not a hike',
    body: 'Somewhere along it the ground is steeper than 45° for a hundred metres at a stretch. That is climbing terrain, and the distance and ascent above describe it the way they would describe a footpath, which is misleading. Treat this as a mountaineering objective and find a proper route description before going.',
  },
};
