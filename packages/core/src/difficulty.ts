/**
 * Trail difficulty, from the Shenandoah National Park rating:
 *
 *     rating = sqrt(elevation_gain_ft * 2 * distance_mi)
 *            = sqrt(SHENANDOAH_METRIC_CONSTANT * gain_m * distance_km)
 *
 * The score is blind to terrain, so `sac_scale` acts as a floor and sustained steepness bumps
 * a band. Both adjustments only ever raise difficulty, never lower it.
 *
 * @see https://www.nps.gov/shen/planyourvisit/how-to-determine-hiking-difficulty.htm
 * @see https://wiki.openstreetmap.org/wiki/Key:sac_scale
 */

export const DIFFICULTIES = ['easy', 'moderate', 'hard'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** What a difficulty band is called on screen. One source, so nothing says "Medium". */
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
 * Metric-input constant for the Shenandoah formula (see module docs). Keep it derived from the
 * exact definitions (1 ft = 0.3048 m, 1 mi = 1609.344 m): a rounded literal such as
 * `3.28084 * 2 * 0.621371` is off in the fifth digit and pulls ratings away from the NPS numbers
 * the tests validate against.
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
  /** Steepest sustained grade as a fraction (0.25 = 25%), measured over a window. */
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
 * Ground too steep to hike up — a separate claim, not a fourth band. Difficulty answers "how big
 * a day"; this answers "is this a hike at all", and a short steep gully scores easy on the first
 * while still wanting your hands. Measured over `GRADE_WINDOW_M`, so one noisy DEM sample cannot
 * trip it.
 */
export const TERRAIN_CAUTIONS = ['scramble', 'climbing'] as const;
export type TerrainCaution = (typeof TERRAIN_CAUTIONS)[number];

/** 35° — hands come out of pockets; a graded path has nowhere to put a switchback. */
const SCRAMBLE_GRADE = 0.7;
/** 45° — snow slides and rock is climbed rather than ascended. */
const CLIMBING_GRADE = 1.0;

export function terrainCaution(
  maxSustainedGrade: number | null | undefined,
): TerrainCaution | null {
  if (maxSustainedGrade == null || !Number.isFinite(maxSustainedGrade)) return null;
  if (maxSustainedGrade >= CLIMBING_GRADE) return 'climbing';
  if (maxSustainedGrade >= SCRAMBLE_GRADE) return 'scramble';
  return null;
}

/** What to say about it. Each body names the ground and then the figure's provenance: the grade
 * comes off a 20 m elevation model, which on a cliff describes the cliff, not the path across it. */
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
