import { z } from 'zod';
import { publicProfileSchema } from './profile';
import { ACTIVITY_TYPES, TRAIL_CONDITIONS } from './types';
import type { TrailCondition } from './types';

/**
 * Trail reports: the vocabulary, the write and read shapes, and the rating summary.
 * `hikedOn` crosses the wire as `YYYY-MM-DD`, never a `Date` — a `Date` is UTC midnight and
 * renders as the previous day west of Greenwich.
 */

/** The chips a review can carry, in the order they are always shown. */
export const TRAIL_CONDITION_LABEL: Readonly<Record<TrailCondition, string>> = {
  dry: 'Dry',
  muddy: 'Muddy',
  snow: 'Snow',
  icy: 'Icy',
  flooded: 'Flooded',
  washed_out: 'Washed out',
  closed: 'Closed',
  blowdown: 'Fallen trees',
  overgrown: 'Overgrown',
  well_marked: 'Well marked',
  poorly_marked: 'Poorly marked',
  bugs: 'Bugs',
  crowded: 'Crowded',
};

/**
 * Dedupe into the vocabulary's own order. Filtering `TRAIL_CONDITIONS` by membership, rather
 * than de-duplicating the input, is what makes the result independent of tap order and drops
 * values outside the vocabulary.
 */
export function normaliseConditions(values: readonly string[]): TrailCondition[] {
  const chosen = new Set(values);
  return TRAIL_CONDITIONS.filter((condition) => chosen.has(condition));
}

export const REVIEW_SORTS = ['recent', 'rating_desc', 'rating_asc', 'helpful'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

/** Both ends of the scale, deliberately: one-star reports carry the closed bridge and the ford. */
export const REVIEW_SORT_LABEL: Readonly<Record<ReviewSort, string>> = {
  recent: 'Most recent',
  rating_desc: 'Highest rated',
  rating_asc: 'Lowest rated',
  helpful: 'Most helpful',
};

/** Long enough for a genuine trip report, short enough that no page has to paginate one. */
export const REVIEW_BODY_MAX = 5_000;

/**
 * A calendar date with no time and no zone, verified to exist. The round-trip catches
 * 31 February, which `Date` rolls forward rather than rejecting. Keep the `NaN` guard: zod runs
 * refinements even after the regex fails, and `toISOString()` throws on Invalid Date, which
 * tRPC would report as a 500 instead of a validation error.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD.')
  .refine((value) => {
    const instant = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
  }, 'That date does not exist.');

/** One day, not zero: "today" in Auckland is tomorrow in UTC for most of the working day. */
const HIKED_ON_SLACK_DAYS = 1;

/** UTC today, shifted by `days`, as `YYYY-MM-DD`. */
function utcDay(days = 0): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/** When they were actually there. The 1970 floor catches typos like `0202-07-14`. */
export const hikedOnSchema = isoDateSchema
  .refine((value) => value >= '1970-01-01', 'That date is too far back to be a hike.')
  .refine((value) => value <= utcDay(HIKED_ON_SLACK_DAYS), 'That date is in the future.');

/**
 * What a client sends to publish or amend a review. One shape for both: the schema holds one
 * review per person per trail, so writing is an upsert.
 */
export const reviewWriteSchema = z.object({
  trailId: z.string().min(1).max(64),
  rating: z.number().int().min(1).max(5),
  /** Optional — a rating on its own is a legitimate review, and forcing prose invents it. */
  body: z.string().trim().max(REVIEW_BODY_MAX).nullish(),
  hikedOn: hikedOnSchema.nullish(),
  conditions: z
    .array(z.enum(TRAIL_CONDITIONS))
    .max(TRAIL_CONDITIONS.length)
    .transform(normaliseConditions)
    .default([]),
  activityType: z.enum(ACTIVITY_TYPES).nullish(),
});
export type ReviewWrite = z.infer<typeof reviewWriteSchema>;

/** Who wrote it. Picked from the public profile, so a private field disappears from here too. */
export const reviewAuthorSchema = publicProfileSchema.pick({
  id: true,
  username: true,
  name: true,
  image: true,
});
export type ReviewAuthor = z.infer<typeof reviewAuthorSchema>;

/**
 * A photograph filed with a report — thinner than the trail gallery's shape, because these were
 * taken by the person named above them and need no licence or attribution.
 */
export const reviewPhotoSchema = z.object({
  id: z.string(),
  url: z.string(),
  thumbUrl: z.string().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  blurhash: z.string().nullable(),
  caption: z.string().nullable(),
});
export type ReviewPhoto = z.infer<typeof reviewPhotoSchema>;

/** How many photographs a report carries into a list. The upload is not capped; the list is. */
export const REVIEW_PHOTOS_IN_LIST = 6;

export const reviewSchema = z.object({
  id: z.string(),
  trailId: z.string(),
  /**
   * Null on a report a moderator took down, exactly as `body` is. Must stay null rather than be
   * hidden by the renderer: `rating_desc`/`rating_asc` sort on the database column, so a
   * tombstone's position would otherwise disclose the withdrawn rating.
   */
  rating: z.number().int().min(1).max(5).nullable(),
  body: z.string().nullable(),
  /** `YYYY-MM-DD`, the calendar day they hiked it. See this module's header. */
  hikedOn: z.string().nullable(),
  conditions: z.array(z.enum(TRAIL_CONDITIONS)),
  activityType: z.enum(ACTIVITY_TYPES).nullable(),
  /** Zeroed on a removed report — see `rating` above and `toReview`. */
  helpfulCount: z.number().int().nonnegative(),
  createdAt: z.date(),
  /** Equal to `createdAt` until it is edited, which is how the UI knows to say "edited". */
  updatedAt: z.date(),
  author: reviewAuthorSchema,
  /** What they photographed, oldest first — on a hike, the order they were passed in. */
  photos: z.array(reviewPhotoSchema),
  /** True when the signed-in caller wrote this one. Always false when signed out. */
  isMine: z.boolean(),
  /**
   * A moderator took this down. The row still holds its place in the list — see `toReview` in
   * `packages/api/src/routers/reviews.ts`. The server has already stripped `rating`, `body`,
   * `conditions`, `activityType`, `helpfulCount` and `photos`, so a renderer that forgets to
   * branch shows an empty report rather than the text somebody complained about.
   */
  hidden: z.boolean(),
});
export type Review = z.infer<typeof reviewSchema>;

export const reviewPageSchema = z.object({
  reviews: z.array(reviewSchema),
  nextCursor: z.string().nullable(),
  /** Every review on the trail, not just this page — the count the heading prints. */
  total: z.number().int().nonnegative(),
});
export type ReviewPage = z.infer<typeof reviewPageSchema>;

/**
 * How recent a report must be to count toward the conditions tally. An all-time tally is worse
 * than none — February's "icy" would still be the loudest chip in July.
 */
export const CONDITIONS_WINDOW_DAYS = 60;

export const ratingSummarySchema = z.object({
  /** The denormalised average, to one decimal. `null` when nobody has reviewed it. */
  average: z.number().min(0).max(5).nullable(),
  count: z.number().int().nonnegative(),
  /** Five buckets, five stars first. */
  histogram: z
    .array(
      z.object({
        rating: z.number().int().min(1).max(5),
        count: z.number().int().nonnegative(),
      }),
    )
    .length(5),
  /** What people have been reporting lately, most-reported first. Ties keep chip order. */
  recentConditions: z.array(
    z.object({
      condition: z.enum(TRAIL_CONDITIONS),
      count: z.number().int().nonnegative(),
    }),
  ),
  /** How many reports the tally is drawn from, so the UI can say so rather than imply it. */
  recentCount: z.number().int().nonnegative(),
  windowDays: z.number().int().positive(),
});
export type RatingSummary = z.infer<typeof ratingSummarySchema>;

/**
 * The mean, to one decimal, from a rating tally. `null` rather than 0 when nobody has
 * reviewed it: a trail nobody hiked and a trail everybody hated must not print the same number.
 */
export function averageRating(counts: readonly number[]): number | null {
  let total = 0;
  let sum = 0;
  for (const [index, count] of counts.entries()) {
    total += count;
    sum += count * (index + 1);
  }
  return total === 0 ? null : Math.round((sum / total) * 10) / 10;
}
