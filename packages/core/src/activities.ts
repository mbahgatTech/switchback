import { z } from 'zod';
import { publicProfileSchema, VISIBILITIES, type Visibility } from './profile';
import { ACTIVITY_TYPES, trailSummarySchema, type ActivityType } from './types';

/**
 * A recording — one person's hike, as opposed to the trail it was hiked on. `Activity.trailId`
 * is nullable because plenty of recordings match nothing we hold. The server derives every
 * number in `packages/geo/track` from the fixes that arrived, so a phone that dies at the summit
 * yields a shorter recording rather than a lost one. Sampling is 1 Hz on the phone and much
 * sparser in the database — see `SAMPLE_BATCH`, `TRACK_SIMPLIFY_M`.
 */

/** Prose names for the activity types. A `Record` keyed by the union, so adding a type to
 * `ACTIVITY_TYPES` is a compile error here until it has a label. */
export const ACTIVITY_TYPE_LABELS: Readonly<Record<ActivityType, string>> = {
  hiking: 'Hiking',
  trail_running: 'Trail running',
  backpacking: 'Backpacking',
  mountain_biking: 'Mountain biking',
  road_biking: 'Road biking',
  horseback_riding: 'Horseback riding',
  snowshoeing: 'Snowshoeing',
  skiing: 'Skiing',
  via_ferrata: 'Via ferrata',
  scrambling: 'Scrambling',
};

/** The four offered as buttons on the recorder; the rest are behind the full list. */
export const COMMON_ACTIVITY_TYPES: readonly ActivityType[] = [
  'hiking',
  'trail_running',
  'backpacking',
  'mountain_biking',
];

/** How a recording is described in the visibility picker, from the owner's side. */
export const VISIBILITY_LABELS: Readonly<Record<Visibility, string>> = {
  private: 'Only me',
  followers: 'People who follow me',
  public: 'Anyone',
};

export const ACTIVITY_NAME_MAX = 120;
export const ACTIVITY_NOTES_MAX = 4_000;

/** Fixes per upload call — at 1 Hz, a little over eight minutes, the interval a recording flushes
 * on. A dropped request costs that much retry rather than a whole hike. */
export const SAMPLE_BATCH = 500;

/** Douglas–Peucker tolerance applied before samples are persisted. Two metres is under the
 * accuracy of a good consumer fix, so it removes the jitter of standing still, not the path. */
export const TRACK_SIMPLIFY_M = 2;

/** Fixes worse than this are dropped on arrival. One 300 m cold-start fix adds 600 m of phantom
 * distance that no downstream smoothing removes. Generous by design — this discards garbage. */
export const MAX_FIX_ACCURACY_M = 100;

/** One fix as the client records it. `t` is seconds since the recording started, not a timestamp:
 * it survives a phone whose clock steps mid-hike. Absolute time is `startedAt + t`. */
export const trackFixSchema = z.object({
  t: z
    .number()
    .int()
    .min(0)
    .max(60 * 60 * 48),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  eleM: z.number().min(-500).max(9_500).nullable().optional(),
  accuracyM: z.number().min(0).max(10_000).nullable().optional(),
  speedMps: z.number().min(0).max(200).nullable().optional(),
  heartRate: z.number().int().min(20).max(260).nullable().optional(),
  cadence: z.number().int().min(0).max(300).nullable().optional(),
});
export type TrackFix = z.infer<typeof trackFixSchema>;

/** One kilometre or mile of the hike — the one statistic a total cannot express. Computed
 * against distance, not time, so the final partial split is marked. */
export const splitSchema = z.object({
  /** 1-based, so the first row reads "1" under a heading that says km. */
  index: z.number().int().min(1),
  distanceM: z.number(),
  elapsedS: z.number().int(),
  movingS: z.number().int(),
  gainM: z.number(),
  lossM: z.number(),
  /** Seconds per unit of distance. The number the row is actually about. */
  paceSPerUnit: z.number(),
  /** False for the last row when the hike did not end on a whole unit. */
  complete: z.boolean(),
});
export type Split = z.infer<typeof splitSchema>;

/** The stats a recording produces. Every one of them is derived from the samples. */
export const activityStatsSchema = z.object({
  distanceM: z.number(),
  gainM: z.number(),
  lossM: z.number(),
  minEleM: z.number().nullable(),
  maxEleM: z.number().nullable(),
  movingTimeS: z.number().int(),
  elapsedTimeS: z.number().int(),
  avgSpeedMps: z.number().nullable(),
  maxSpeedMps: z.number().nullable(),
});
export type ActivityStats = z.infer<typeof activityStatsSchema>;

/** A recording in a list — the card on a profile or the row in a feed. */
export const activitySummarySchema = activityStatsSchema.extend({
  id: z.string(),
  name: z.string().nullable(),
  activityType: z.enum(ACTIVITY_TYPES),
  visibility: z.enum(VISIBILITIES),
  startedAt: z.date(),
  endedAt: z.date().nullable(),
  /** Null while a recording is still open. */
  syncedAt: z.date().nullable(),
  trail: trailSummarySchema.nullable(),
  photoCount: z.number().int(),
  /** Present on another hiker's activity; omitted on your own, where it is you. */
  owner: publicProfileSchema.pick({ id: true, username: true, name: true, image: true }).nullable(),
});
export type ActivitySummary = z.infer<typeof activitySummarySchema>;

/** A recording on its own page. Adds the track, the splits, and the writing. */
export const activityDetailSchema = activitySummarySchema.extend({
  notes: z.string().nullable(),
  device: z.string().nullable(),
  /** `[[lng, lat, eleM | null], …]` — a third of the bytes of an object array, and what
   * MapLibre wants anyway. */
  track: z.array(z.tuple([z.number(), z.number(), z.number().nullable()])),
  splits: z.array(splitSchema),
  isMine: z.boolean(),
});
export type ActivityDetail = z.infer<typeof activityDetailSchema>;

/** What a recording is called when nobody named it — the trail, or the time of day. */
export function defaultActivityName(
  type: ActivityType,
  startedAt: Date,
  trailName?: string | null,
): string {
  if (trailName) return trailName;
  const hour = startedAt.getHours();
  const partOfDay =
    hour < 5
      ? 'Night'
      : hour < 12
        ? 'Morning'
        : hour < 17
          ? 'Afternoon'
          : hour < 21
            ? 'Evening'
            : 'Night';
  return `${partOfDay} ${ACTIVITY_TYPE_LABELS[type].toLowerCase()}`;
}
