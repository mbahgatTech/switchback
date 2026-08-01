import { z } from 'zod';
import { publicProfileSchema } from './profile';

/**
 * What a hiker's record adds up to: totals, standout hikes, and the cadence strip. Everything is
 * derived from `Completion` joined to `Trail`, never stored — a denormalised total is one more
 * column to keep true across a corrected date, a deleted trail and a re-ingested length. A hike
 * is counted **per completion, not per trail**: the same 12 km loop done forty times is 480 km.
 */

/** One hike that stands out. Carries the trail's slug so the figure can be a link. */
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

/** One month of the cadence strip. Months with no hiking carry zeroes rather than being
 * omitted — a strip that skips December reads as a year of steady hiking. */
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
  /** Summed Tobler estimates, not measured time. Named for what it is so no UI prints it as
   * though a stopwatch produced it. */
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

/** A profile as anyone can read it. `hikesVisible` is the completed list's own `isPublic`, so
 * the page can say *why* a list is absent. The stats themselves are always public. */
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
   * What to put after `/lists/` to reach this hiker's completed list, or null when the caller
   * cannot read it. The key, not the slug: a list resolves by slug only for its owner, so
   * deciding it here stops a reader being linked to their own hikes.
   */
  completedKey: z.string().nullable(),
  /** True when the caller is looking at their own profile. */
  isMe: z.boolean(),
});
export type HikerProfile = z.infer<typeof hikerProfileSchema>;

/**
 * How many months the cadence strip covers. Thirteen, not twelve: a twelve-month strip ending in
 * July puts last July off the end, and that comparison is the question a year of hiking is asked.
 */
export const CADENCE_MONTHS = 13;

/** Regions listed on a profile before the tail is cut. */
export const TOP_REGIONS = 6;

/** `YYYY-MM` for a date, in UTC — the same key the stats query groups by. */
export function monthKey(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last {@link CADENCE_MONTHS} month keys ending at `now`, oldest first. Steps a UTC date
 * back a month at a time — subtracting from the month number puts 0 − 1 in the wrong year. */
export function cadenceMonths(now: Date, count = CADENCE_MONTHS): string[] {
  const keys: string[] = [];
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  for (let index = 0; index < count; index += 1) {
    keys.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return keys.reverse();
}

/** Fill a sparse month → totals map out to the full strip. The query returns only months hiked. */
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

/** A short month label for the cadence axis. The year prints only where it changes. */
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
