import { z } from 'zod';
import { publicProfileSchema } from './profile';
import { ACTIVITY_TYPES, TRAIL_CONDITIONS } from './types';
import type { TrailCondition } from './types';

/**
 * Reviews — the one thing on this product that cannot be derived from OpenStreetMap.
 *
 * Everything else a trail page shows is computed: the length from the geometry, the climb
 * from the DEM, the weather from a model, the crowds from a prior. This is the only part
 * that has to be *reported*, by someone who actually hiked it, and that asymmetry is why
 * the shapes here are stricter than the rest of `core`. A wrong gain figure is a bug we can
 * fix by re-running a pass; a review that misrepresents what someone said is not.
 *
 * Two decisions are worth stating because neither is obvious from the types:
 *
 * **`hikedOn` crosses the wire as `YYYY-MM-DD`, never as a `Date`.** It is a calendar date
 * — the day someone was on the hill — and it has no time and no zone. Sent as a `Date` it
 * would be UTC midnight, which renders as *the previous day* for every reader west of
 * Greenwich. That is the exact bug `localtime.ts` exists to prevent, and it would be
 * embarrassing to reintroduce it on the one field a human typed by hand.
 *
 * **Conditions are canonicalised, not stored as tapped.** `normaliseConditions` dedupes and
 * re-sorts into the vocabulary's own order, so two reviews reporting the same three things
 * print the same three chips in the same three positions. Reading down a list of reports
 * looking for "icy" should be scanning a column, not a word search.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The chips a review can carry, in the order they are always shown.
 *
 * Grouped by what the reader is asking. Ground first — it decides footwear and it is what
 * changes week to week. Then the hazards, then whether the way is findable, then the
 * nuisances that are worth knowing and are nobody's safety.
 */
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
 * Dedupe and canonicalise, in one pass over the vocabulary.
 *
 * Filtering `TRAIL_CONDITIONS` by membership rather than de-duplicating the input is what
 * makes the order independent of the order someone tapped the chips — and it drops any
 * value that is not in the vocabulary at all, which matters because this also runs over
 * rows read back from a database column typed as an enum array.
 */
export function normaliseConditions(values: readonly string[]): TrailCondition[] {
  const chosen = new Set(values);
  return TRAIL_CONDITIONS.filter((condition) => chosen.has(condition));
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export const REVIEW_SORTS = ['recent', 'rating_desc', 'rating_asc', 'helpful'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

/**
 * Both ends of the scale are offered on purpose.
 *
 * A page that sorts to "highest rated" and stops is a marketing page. The one-star reports
 * are where the closed bridge and the washed-out ford get written down, and burying them
 * under a sort nobody can reverse is how a review section stops being useful for planning.
 */
export const REVIEW_SORT_LABEL: Readonly<Record<ReviewSort, string>> = {
  recent: 'Most recent',
  rating_desc: 'Highest rated',
  rating_asc: 'Lowest rated',
  helpful: 'Most helpful',
};

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Long enough for a genuine trip report, short enough that no page has to paginate one. */
export const REVIEW_BODY_MAX = 5_000;

/**
 * A calendar date with no time and no zone, verified to be a date that exists.
 *
 * The round-trip is what catches 31 February: `2026-02-31T00:00:00Z` is a well-formed
 * timestamp that `Date` rolls forward to 3 March rather than rejecting, so comparing the
 * normalised string against the input is the check.
 *
 * The `NaN` guard in front of it is not defensive padding. A month of `13` does not conform
 * to the date-time format at all, so `Date` returns Invalid Date and `toISOString()` *throws*
 * — and zod still runs a refinement after an earlier check has failed, so the regex above
 * does not shield it. Unguarded, `hikedOn: '2026-13-01'` leaves this schema as a thrown
 * `RangeError` rather than a returned validation error, which tRPC reports as a 500 and a
 * form renders as "something went wrong" instead of "that date does not exist".
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the form YYYY-MM-DD.')
  .refine((value) => {
    const instant = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(instant.getTime()) && instant.toISOString().slice(0, 10) === value;
  }, 'That date does not exist.');

/**
 * The furthest ahead a hiked-on date may be, in days.
 *
 * One, not zero. "Today" in Auckland is tomorrow in UTC for most of the working day, and
 * rejecting a hiker's own date because our clock is behind theirs is a bug that would only
 * ever be reported by the people furthest from us.
 */
const HIKED_ON_SLACK_DAYS = 1;

/** UTC today, shifted by `days`, as `YYYY-MM-DD`. */
function utcDay(days = 0): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * When they were actually there, which is often not when they wrote this.
 *
 * Bounded below at 1970 because the regex will happily accept `0202-07-14`, and a typo that
 * sorts eighteen centuries early is worse than no date. Bounded above at today because a
 * report of a hike that has not happened yet is not a report.
 */
export const hikedOnSchema = isoDateSchema
  .refine((value) => value >= '1970-01-01', 'That date is too far back to be a hike.')
  .refine((value) => value <= utcDay(HIKED_ON_SLACK_DAYS), 'That date is in the future.');

/**
 * What a client sends to publish or amend a review.
 *
 * There is no separate create and update shape because there is no separate create and
 * update: the schema holds one review per person per trail, so writing is an upsert and
 * editing is the same form with the same fields already filled in.
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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Who wrote it, and nothing more.
 *
 * Picked from the public profile rather than declared separately so that the day a field
 * becomes private it disappears from here too, instead of leaking through a second shape
 * nobody remembered to change. `bio` and `createdAt` are dropped: a review list is not a
 * directory, and 40 copies of a joined-in date is 40 lines of nothing.
 */
export const reviewAuthorSchema = publicProfileSchema.pick({
  id: true,
  username: true,
  name: true,
  image: true,
});
export type ReviewAuthor = z.infer<typeof reviewAuthorSchema>;

/**
 * A photograph filed with a report.
 *
 * Deliberately thinner than the trail gallery's shape, and the difference is the point. A
 * gallery frame has to carry its licence, its attribution, its distance along the route and
 * whether the viewer owns it, because it sits in a mixed set of scraped and contributed
 * pictures and each one has to account for itself. These do not: they were taken by the
 * person whose name is on the line above them, which is the only credit they need. Sending
 * the full shape would put nine redundant fields on the wire for every photograph on every
 * report of a forty-report trail.
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

/**
 * How many photographs a single report carries into a list.
 *
 * A cap, not a limit on the upload: someone may attach a dozen, and all twelve show on the
 * trail's own gallery. What this bounds is the list — eight reports each dragging twelve
 * thumbnails is ninety-six requests on a page whose job is to be read.
 */
export const REVIEW_PHOTOS_IN_LIST = 6;

export const reviewSchema = z.object({
  id: z.string(),
  trailId: z.string(),
  /**
   * Null on a report a moderator took down, exactly as `body` is.
   *
   * It was non-null once, and both renderers simply declined to draw it on a hidden row —
   * which left the number in every `reviews.list` response and, worse, left it ordering the
   * list. `rating_desc` and `rating_asc` sort on the database column, so a tombstone sitting
   * first under "Highest rated" told a reader the withdrawn rating was a five without
   * printing it. A value the page refuses to show must not be readable off the row's
   * position, and the only way to guarantee that is for the client not to have it.
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
  /**
   * What they photographed while they were there, oldest first — the order they were taken
   * in, which on a hike is the order they were passed in.
   */
  photos: z.array(reviewPhotoSchema),
  /** True when the signed-in caller wrote this one. Always false when signed out. */
  isMine: z.boolean(),
  /**
   * A moderator took this down.
   *
   * The row is still returned and still occupies its place in the list — see
   * `toReview` in `packages/api/src/routers/reviews.ts` for why a tombstone beats both a
   * 404 and a silent disappearance. When this is true the server has already stripped
   * `rating`, `body`, `conditions`, `activityType`, `helpfulCount` and `photos`, so a
   * renderer that forgets to branch on it shows an empty report rather than the text
   * somebody complained about. The rating is not in the trail's average either way.
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

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

/**
 * How recent a report has to be to count toward the conditions tally.
 *
 * Sixty days. An all-time tally is worse than none: February's "icy" would still be the
 * loudest chip on a trail in July, which is precisely the mistake that makes a reader stop
 * trusting the section. Two months is long enough that a quiet trail still has something to
 * say and short enough that it is a claim about now.
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
 * The mean, to one decimal, from a rating tally.
 *
 * One decimal because that is the precision the count can support — a second would claim to
 * separate 4.62 from 4.63 on eleven reviews. `null` rather than 0 when there is nothing to
 * average, because a trail nobody has hiked and a trail everybody hated are not the same
 * trail and must not print the same number.
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
