import { z } from 'zod';
import { publicProfileSchema } from './profile';

/**
 * What a hiker's record adds up to.
 *
 * The distinction this module keeps is between a *total* and a *record*. A total is the
 * sum of everything — how far, how much up, how many times out — and it only ever grows,
 * which makes it a poor thing to look at twice. A record is a single hike that was the
 * furthest, or the steepest, or the highest, and it is the part someone actually tells
 * people about. Both are here, and the UI is expected to give the records the room.
 *
 * Everything is derived from `Completion` joined to `Trail`, never stored. A denormalised
 * `user.totalDistanceM` would be one more column to keep true across a corrected date, a
 * deleted trail, and a re-ingested length, and the query below costs a single index scan
 * on `completions_userId_completedAt_idx`.
 *
 * **A hike is counted per completion, not per trail.** Somebody who has done the same
 * 12 km loop forty times has hiked 480 km. A figure that says 12 is describing the map.
 */

// ---------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------

/**
 * One hike that stands out — the longest, the biggest climb, the highest ground.
 *
 * Carries the trail's slug so the figure is a link. A record nobody can click through to
 * is trivia; a record that takes you back to the trail is the product remembering
 * something for you.
 */
export const hikeRecordSchema = z.object({
  trailId: z.string(),
  trailName: z.string(),
  trailSlug: z.string(),
  /** `YYYY-MM-DD` of the hike that set it. */
  completedAt: z.string(),
  /** The measurement itself, in metres — length, gain, or elevation depending on the field. */
  valueM: z.number(),
});
export type HikeRecord = z.infer<typeof hikeRecordSchema>;

/**
 * One month of the cadence strip.
 *
 * Months with no hiking are present with zeroes rather than omitted, because the gaps are
 * the information: a strip that skips December reads as a year of steady hiking, and a
 * strip with an empty December reads as a winter off.
 */
export const hikeMonthSchema = z.object({
  /** `YYYY-MM`, so it sorts as a string and needs no timezone to compare. */
  month: z.string().regex(/^\d{4}-\d{2}$/u),
  hikes: z.number().int().nonnegative(),
  lengthM: z.number().nonnegative(),
  gainM: z.number().nonnegative(),
});
export type HikeMonth = z.infer<typeof hikeMonthSchema>;

/** Where someone hikes, most-hiked first. */
export const hikeRegionSchema = z.object({
  /** Null where the trail has no region — grouped as one bucket rather than dropped. */
  region: z.string().nullable(),
  hikes: z.number().int().nonnegative(),
  lengthM: z.number().nonnegative(),
});
export type HikeRegion = z.infer<typeof hikeRegionSchema>;

export const hikerStatsSchema = z.object({
  /** Completions, not distinct trails. */
  hikes: z.number().int().nonnegative(),
  /** How many different trails those hikes were on. */
  trails: z.number().int().nonnegative(),
  lengthM: z.number().nonnegative(),
  gainM: z.number().nonnegative(),
  /**
   * Summed Tobler estimates, not measured time. Named for what it is so no UI is tempted
   * to print it as though a stopwatch produced it — Phase 4's recordings are that number.
   */
  estimatedTimeS: z.number().nonnegative(),

  longest: hikeRecordSchema.nullable(),
  steepest: hikeRecordSchema.nullable(),
  highest: hikeRecordSchema.nullable(),

  /** `YYYY-MM-DD` of the earliest and latest hike on the record. */
  firstHike: z.string().nullable(),
  lastHike: z.string().nullable(),

  /** Exactly {@link CADENCE_MONTHS} entries, oldest first, gaps included. */
  months: z.array(hikeMonthSchema),
  /** Capped at {@link TOP_REGIONS}. */
  regions: z.array(hikeRegionSchema),

  reviews: z.number().int().nonnegative(),
  photos: z.number().int().nonnegative(),
});
export type HikerStats = z.infer<typeof hikerStatsSchema>;

/** Nobody has hiked anything yet. Shared so the client and server draw the same zero. */
export const EMPTY_HIKER_STATS: HikerStats = {
  hikes: 0,
  trails: 0,
  lengthM: 0,
  gainM: 0,
  estimatedTimeS: 0,
  longest: null,
  steepest: null,
  highest: null,
  firstHike: null,
  lastHike: null,
  months: [],
  regions: [],
  reviews: 0,
  photos: 0,
};

/**
 * A profile as anyone can read it.
 *
 * `hikesVisible` is the completed list's own `isPublic` flag, surfaced so the page can say
 * *why* a list of hikes is absent rather than rendering an unexplained hole. The stats
 * themselves are always public — an aggregate says how much someone hikes, and the thing
 * worth a privacy control is where and when, which is what the list holds.
 */
export const hikerProfileSchema = z.object({
  profile: publicProfileSchema,
  stats: hikerStatsSchema,
  /** Only lists the owner has published. Empty for a stranger who publishes nothing. */
  lists: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      kind: z.string(),
      trailCount: z.number().int().nonnegative(),
      totalLengthM: z.number().nonnegative(),
      coverPhotoUrl: z.string().url().nullable(),
    }),
  ),
  hikesVisible: z.boolean(),
  /**
   * What to put after `/lists/` to reach this hiker's completed list, or null if it is not
   * readable by the caller.
   *
   * The key rather than the slug, because a list resolves by slug only for its owner — a
   * stranger reaches it by id. Deciding that here, where the owner is known, is the
   * difference between linking to someone's hikes and linking a reader to their own.
   */
  completedKey: z.string().nullable(),
  /** True when the caller is looking at their own profile. */
  isMe: z.boolean(),
});
export type HikerProfile = z.infer<typeof hikerProfileSchema>;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * How many months the cadence strip covers.
 *
 * Thirteen, not twelve. A twelve-month strip ending in July starts in August, so this
 * July sits at one end and last July is off the strip entirely — and "am I out more than
 * I was this time last year" is the one question a year of hiking is asked. Thirteen puts
 * both Julys on it, at opposite ends, which is exactly where a comparison wants them.
 */
export const CADENCE_MONTHS = 13;

/** Regions listed on a profile before the tail is cut. */
export const TOP_REGIONS = 6;

// ---------------------------------------------------------------------------
// Deriving
// ---------------------------------------------------------------------------

/** `YYYY-MM` for a date, in UTC — the same key the stats query groups by. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * The last {@link CADENCE_MONTHS} month keys ending at `now`, oldest first.
 *
 * Built by hiking a UTC date backwards a month at a time rather than by subtracting from
 * the month number, because the naive version puts month 0 minus 1 in the wrong year and
 * nobody notices until January.
 */
export function cadenceMonths(now: Date, count = CADENCE_MONTHS): string[] {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let index = 0; index < count; index += 1) {
    keys.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return keys.reverse();
}

/**
 * Fill a sparse month → totals map out to the full strip.
 *
 * The query returns only the months someone actually hiked in. This is what turns that
 * into a strip with holes in it, which is the thing worth drawing.
 */
export function fillCadence(
  present: ReadonlyMap<string, Omit<HikeMonth, 'month'>>,
  now: Date,
  count = CADENCE_MONTHS,
): HikeMonth[] {
  return cadenceMonths(now, count).map((month) => ({
    month,
    hikes: present.get(month)?.hikes ?? 0,
    lengthM: present.get(month)?.lengthM ?? 0,
    gainM: present.get(month)?.gainM ?? 0,
  }));
}

/**
 * A short month label for the cadence axis — `Jan`, and `Jan '25` when the year turns.
 *
 * The year is printed only where it changes, so a thirteen-month strip carries at most two
 * of them and the axis stays a row of three-letter marks instead of a table.
 */
export function monthLabel(month: string, previous?: string): string {
  const [year, index] = month.split('-');
  const at = Number(index) - 1;
  const name = MONTH_NAMES[at] ?? month;
  const yearChanged = previous === undefined || previous.slice(0, 4) !== year;
  return yearChanged && year ? `${name} ’${year.slice(2)}` : name;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
