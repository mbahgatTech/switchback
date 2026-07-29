import { z } from 'zod';
import { publicProfileSchema, VISIBILITIES, type Visibility } from './profile';
import { ACTIVITY_TYPES, trailSummarySchema, type ActivityType } from './types';

/**
 * A recording — the hike itself, as opposed to the trail it was hiked on.
 *
 * The distinction this file exists to hold is between a **trail** and an **activity**. A
 * trail is a fact about the world that we ingested and everyone sees the same one. An
 * activity is a fact about one person's afternoon: it has a start time, a track, and an
 * owner, and two people hiking the same trail produce two of them. `Activity.trailId` is
 * nullable precisely because plenty of recordings match nothing we hold — a beach, a lane,
 * a hill with no path on it — and those are still worth keeping.
 *
 * **The server derives the numbers, the client sends the fixes.** Distance, ascent, moving
 * time and pace are all recomputed in `packages/geo/track` from the samples that arrive.
 * Not from distrust of the client so much as from the shape of the failure: a phone that
 * dies at the summit has already uploaded its fixes, and totals computed from those are
 * right, whereas totals the phone was going to send at the end are gone. Deriving from
 * samples makes an interrupted recording a shorter recording rather than a lost one.
 *
 * **Sampling is 1 Hz at the phone and much sparser in the database.** Six hours at 1 Hz is
 * 21,600 fixes; nobody needs them and nothing renders them. The client batches, the server
 * simplifies, and what lands is a track that draws the same pixels — see `SAMPLE_BATCH` and
 * the note on `TRACK_SIMPLIFY_M`.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Prose names for the activity types.
 *
 * A `Record` keyed by the union rather than a `switch`, so adding a type to `ACTIVITY_TYPES`
 * is a compile error here until it is given a label — which is the only way a new type never
 * reaches a screen as `mountain_biking`.
 */
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

/**
 * The four offered as buttons on the recorder; the rest are behind the full list.
 *
 * Chosen by what someone is plausibly doing at the moment they press record on a phone in
 * the cold, not by what the database can store. Skiing and via ferrata are real options
 * and are not worth a tap of everyone else's time.
 */
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

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const ACTIVITY_NAME_MAX = 120;
export const ACTIVITY_NOTES_MAX = 4_000;

/**
 * Fixes per upload call.
 *
 * At 1 Hz this is a little over eight minutes of hiking, which is the interval a recording
 * flushes on. Small enough that a dropped request costs eight minutes of retry rather than a
 * whole hike, large enough that a six-hour recording is forty-odd requests and not thousands.
 */
export const SAMPLE_BATCH = 500;

/**
 * Douglas–Peucker tolerance applied before samples are persisted.
 *
 * Two metres is under the accuracy of a good consumer GPS fix, so nothing this removes was
 * ever a real feature of the path — it removes the jitter of standing still, which is the
 * bulk of what a 1 Hz recording contains.
 */
export const TRACK_SIMPLIFY_M = 2;

/**
 * Fixes worse than this are dropped on arrival rather than stored.
 *
 * A 300 m fix from a cold start under canopy is not a position, and one of them at the
 * start of a recording adds 600 m of phantom distance that no amount of downstream
 * smoothing removes. The threshold is deliberately generous — this is throwing away
 * garbage, not curating.
 */
export const MAX_FIX_ACCURACY_M = 100;

// ---------------------------------------------------------------------------
// The wire shapes
// ---------------------------------------------------------------------------

/**
 * One fix as the client records it.
 *
 * `t` is seconds since the recording started rather than a timestamp: it is smaller, it
 * survives a phone whose clock steps mid-hike, and every split and pace calculation wants
 * elapsed seconds anyway. The absolute time of any fix is `startedAt + t`.
 */
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

/**
 * One kilometre or mile of the hike.
 *
 * Splits are the one statistic that says something a total cannot: a hike with an even pace
 * and a hike that fell apart on the last climb have the same average and look nothing alike
 * here. Computed against distance, not time, so the final partial split is marked.
 */
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
  /** `[[lng, lat, eleM | null], …]` — a tuple array rather than objects, which is a third
   * of the bytes on a track with ten thousand points and is what MapLibre wants anyway. */
  track: z.array(z.tuple([z.number(), z.number(), z.number().nullable()])),
  splits: z.array(splitSchema),
  isMine: z.boolean(),
});
export type ActivityDetail = z.infer<typeof activityDetailSchema>;

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/**
 * What a recording is called when nobody named it.
 *
 * "Morning hike" beats "Activity 7" for the same reason a photograph is better filed under
 * where it was taken than under its serial number: the list is read by someone scanning for
 * a specific afternoon, and the time of day is what they remember.
 */
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
