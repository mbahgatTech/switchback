/**
 * Reviews.
 *
 * The write path is an **upsert, not an append** — the schema holds one review per person
 * per trail (`@@unique([trailId, userId])`), so revisiting a trail edits what you said
 * rather than stacking a second opinion beside the first. That is a product decision the
 * database is enforcing, and it is the reason there is no `create` here.
 *
 * **Two aggregates are maintained here and one deliberately is not.** `Trail.rating` and
 * `Trail.reviewCount` are recomputed inside the same transaction as every write, because a
 * card that shows a stale average is showing a number nobody ever said. `Trail.popularity`
 * is left completely alone: `packages/busyness/prior.ts` already counts reviews as their own
 * term in `demandEvidence` (`popularity + 2*photos + reviews + parking/3`), so folding them
 * into `popularity` as well would count every review twice in the busyness prior. Popularity
 * belongs to completions and recorded activities, which nothing else counts.
 *
 * **`helpfulCount` is read here and never written.** There is no `ReviewHelpful` join table,
 * so an increment endpoint would be a spam button rather than a vote. The column is real,
 * the sort works, and the vote arrives with the table that can make it mean something.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  CONDITIONS_WINDOW_DAYS,
  REVIEW_PHOTOS_IN_LIST,
  REVIEW_SORTS,
  REMOVED_NOTICE_OWN,
  averageRating,
  normaliseConditions,
  reviewWriteSchema,
} from '@switchback/core';
import type {
  RatingSummary,
  Review as ReviewShape,
  ReviewPage,
  ReviewSort,
  TrailCondition,
} from '@switchback/core';
import type { Prisma, PrismaClient } from '@switchback/db';
import { decodeCursor, encodeCursor } from '../cursor';
import { protectedProcedure, publicProcedure, router } from '../trpc';

/**
 * Everything a rendered review needs, and the author's public fields — never their email.
 *
 * `select` rather than `include` for exactly that reason: an `include: { user: true }` here
 * would put every column of the `users` table on the wire, which is how private fields leak
 * from products that grew quickly.
 */
const reviewSelect = {
  id: true,
  trailId: true,
  userId: true,
  rating: true,
  body: true,
  hikedOn: true,
  conditions: true,
  activityType: true,
  helpfulCount: true,
  createdAt: true,
  updatedAt: true,
  /*
   * Read on every row so `toReview` can print a tombstone rather than a report. Only the
   * timestamp: `hiddenReason` is the moderator's note and is answered on appeal, not
   * published back to the page that the complaint was about.
   */
  hiddenAt: true,
  user: { select: { id: true, username: true, name: true, image: true } },
  /*
   * The photographs filed with the report, oldest first and capped.
   *
   * A nested `select` rather than a second round trip keyed by review id: Prisma issues one
   * extra query for the whole page either way, and doing it here means the shape cannot drift
   * between the list and the caller's own copy. Ordered by `createdAt` so a set uploaded in
   * one go stays in the order it was picked, which on a hike is the order it was hiked.
   */
  photos: {
    /*
     * A photograph a moderator has taken down must not come back attached to a report that
     * was left up. The strip simply gets shorter — there is no tombstone here, because a
     * gap in a row of thumbnails communicates nothing and a grey box communicates less.
     */
    where: { hiddenAt: null },
    select: {
      id: true,
      url: true,
      thumbUrl: true,
      width: true,
      height: true,
      blurhash: true,
      caption: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: REVIEW_PHOTOS_IN_LIST,
  },
} satisfies Prisma.ReviewSelect;

type ReviewRow = Prisma.ReviewGetPayload<{ select: typeof reviewSelect }>;

/**
 * How many recent reports the conditions tally reads.
 *
 * A cap rather than a full scan: on a famous trail "the last sixty days" is thousands of
 * rows, and the tally is a rough shape — the two-hundredth report does not move it. Ordered
 * newest first so the cap drops the oldest reports rather than an arbitrary page.
 */
const CONDITIONS_SAMPLE_MAX = 500;

/** Every rating that exists, highest first — the order the histogram is always drawn in. */
const RATINGS = [5, 4, 3, 2, 1] as const;

const trailIdInput = z.object({ trailId: z.string().min(1).max(64) });

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/**
 * A calendar date out of a `DateTime` column.
 *
 * Written at UTC midnight and read back by slicing the ISO string, so it survives the round
 * trip as the same three numbers a human typed. Formatting it in any local zone — including
 * the server's — is what turns "hiked it on the 3rd" into the 2nd for half the planet.
 */
export function toDateString(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** The reverse: a calendar date into the instant that represents it. */
export function toUtcMidnight(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function toReview(row: ReviewRow, viewerId: string | null): ReviewShape {
  const hidden = row.hiddenAt !== null;

  return {
    id: row.id,
    trailId: row.trailId,
    rating: row.rating,
    /*
     * **A hidden report is a tombstone, not a 404 and not a deletion.**
     *
     * The row survives and the list still returns it, so the page prints "removed by a
     * moderator" where the report was. Dropping it from the list instead was the obvious
     * alternative and it is worse in both directions: to its author the report silently
     * vanishes, which reads as a bug in the product rather than as a decision somebody
     * made and can be argued with; and to anybody who linked to the page, a thread of
     * replies loses its subject with no explanation.
     *
     * What is stripped is everything the moderator objected to — the prose, the
     * photographs, the condition chips. What survives is that somebody rated this trail
     * and when. The rating is *not* counted in the average: `ratingCounts` filters
     * `hiddenAt: null`, so the number under the histogram already excludes this row. It
     * stays on the shape only so the tombstone can keep the row's shape without the list
     * jumping, and nothing renders it.
     */
    body: hidden ? null : row.body,
    hikedOn: toDateString(row.hikedOn),
    // Re-normalised on the way out as well as in. Rows predating this router, or written by
    // a future admin path, have no guarantee of canonical order and the chips must not
    // reshuffle between two reviews saying the same thing.
    conditions: hidden ? [] : normaliseConditions(row.conditions),
    activityType: hidden ? null : row.activityType,
    helpfulCount: row.helpfulCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    author: {
      id: row.user.id,
      username: row.user.username,
      name: row.user.name,
      image: row.user.image,
    },
    photos: hidden ? [] : row.photos,
    isMine: viewerId !== null && row.userId === viewerId,
    hidden,
  };
}

/**
 * Sort orders, each with a full tiebreak chain.
 *
 * The trailing `id` is not decoration. These pages are offset-based, and Postgres is free to
 * return equal rows in any order it likes between two queries — on a trail where forty
 * people all gave four stars, a sort that stops at `rating` can show the same review on page
 * one and page two and drop another entirely.
 */
export const ORDER_BY: Readonly<Record<ReviewSort, Prisma.ReviewOrderByWithRelationInput[]>> = {
  recent: [{ createdAt: 'desc' }, { id: 'desc' }],
  rating_desc: [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  rating_asc: [{ rating: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
  helpful: [{ helpfulCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
};

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

type RatingCounts = [number, number, number, number, number];

/**
 * Counts indexed by rating − 1, so `counts[0]` is the one-star bucket.
 *
 * **Hidden reports are not counted, anywhere.** A rating the page is not permitted to show
 * that is still inside the mean is a number on a card corresponding to nothing anybody
 * said, and it never self-corrects — nothing recomputes a trail's average until the next
 * person writes a review, so one moderated one-star can sit in the figure for months. The
 * filter belongs here rather than at each call site because this is the only function that
 * reads ratings, and a filter written once cannot be forgotten in one of three places.
 */
async function ratingCounts(db: Prisma.TransactionClient, trailId: string): Promise<RatingCounts> {
  const buckets = await db.review.groupBy({
    by: ['rating'],
    where: { trailId, hiddenAt: null },
    _count: { _all: true },
  });
  const counts: RatingCounts = [0, 0, 0, 0, 0];
  for (const bucket of buckets) {
    const index = bucket.rating - 1;
    if (index >= 0 && index < counts.length) counts[index] = bucket._count._all;
  }
  return counts;
}

function total(counts: RatingCounts): number {
  return counts[0] + counts[1] + counts[2] + counts[3] + counts[4];
}

/**
 * Recompute the two denormalised columns from the reviews that actually exist.
 *
 * Recomputed rather than incremented, and that is worth the extra query: an increment has to
 * know whether this write was a create or an edit and by how much the old rating differed,
 * and every one of those branches is a way for the average on a card to drift permanently
 * away from the reviews under it. A `GROUP BY` on an indexed column is cheap, and it is
 * self-healing — one run repairs a row that drifted for any other reason.
 *
 * The average goes through `averageRating`, the same function the summary endpoint uses, so
 * the number in the title block and the number over the histogram cannot round differently.
 *
 * Exported because `routers/moderation.ts` has to call it too: hiding a review changes the
 * mean exactly as much as deleting one does, and a takedown that skipped this would leave a
 * rating on the card that includes a report the page refuses to show.
 */
export async function refreshRatingAggregates(
  db: Prisma.TransactionClient,
  trailId: string,
): Promise<void> {
  const counts = await ratingCounts(db, trailId);
  await db.trail.update({
    where: { id: trailId },
    data: { rating: averageRating(counts), reviewCount: total(counts) },
  });
}

/** The trail exists — checked before a write so a bad id is a 404, not a foreign-key 500. */
async function assertTrail(db: PrismaClient, trailId: string): Promise<void> {
  const trail = await db.trail.findUnique({ where: { id: trailId }, select: { id: true } });
  if (!trail) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such trail.' });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const reviewsRouter = router({
  /**
   * One page of reviews.
   *
   * Public: reading what people said about a public trail does not require an account, and
   * putting a sign-in wall in front of it would make the page useless to the person deciding
   * whether to sign up.
   */
  list: publicProcedure
    .input(
      trailIdInput.extend({
        sort: z.enum(REVIEW_SORTS).default('recent'),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(50).default(10),
      }),
    )
    .query(async ({ ctx, input }): Promise<ReviewPage> => {
      const offset = decodeCursor(input.cursor);
      const where = { trailId: input.trailId };

      const [rows, count] = await Promise.all([
        ctx.db.review.findMany({
          where,
          select: reviewSelect,
          orderBy: ORDER_BY[input.sort],
          skip: offset,
          take: input.limit,
        }),
        ctx.db.review.count({ where }),
      ]);

      const consumed = offset + rows.length;
      return {
        reviews: rows.map((row) => toReview(row, ctx.user?.id ?? null)),
        nextCursor: consumed < count ? encodeCursor(consumed) : null,
        total: count,
      };
    }),

  /**
   * The distribution and what people are reporting lately.
   *
   * Separate from `list` on purpose: it is the same answer for every page and every sort, so
   * folding it into the list response would recompute a histogram every time someone scrolls.
   */
  summary: publicProcedure
    .input(trailIdInput)
    .query(async ({ ctx, input }): Promise<RatingSummary> => {
      const since = new Date(Date.now() - CONDITIONS_WINDOW_DAYS * 86_400_000);

      const [counts, recent] = await Promise.all([
        ratingCounts(ctx.db, input.trailId),
        ctx.db.review.findMany({
          where: {
            trailId: input.trailId,
            // Same rule as the ratings: what a moderator took down is not evidence about
            // the ground, and a chip tallied out of a removed report is a claim with no
            // source a reader can go and check.
            hiddenAt: null,
            // Dated by when they were *there*, falling back to when they wrote it. A report
            // filed today about a hike last spring is not evidence about this week's ground,
            // and treating it as such is the failure mode this window exists to avoid.
            OR: [{ hikedOn: { gte: since } }, { hikedOn: null, createdAt: { gte: since } }],
          },
          select: { conditions: true },
          orderBy: [{ hikedOn: 'desc' }, { createdAt: 'desc' }],
          take: CONDITIONS_SAMPLE_MAX,
        }),
      ]);

      const tally = new Map<TrailCondition, number>();
      for (const row of recent) {
        for (const condition of normaliseConditions(row.conditions)) {
          tally.set(condition, (tally.get(condition) ?? 0) + 1);
        }
      }

      return {
        average: averageRating(counts),
        count: total(counts),
        histogram: RATINGS.map((rating) => ({ rating, count: counts[rating - 1] ?? 0 })),
        // Most-reported first; ties keep the vocabulary's order, which `normaliseConditions`
        // established on the way in, because `Map` iterates in insertion order.
        recentConditions: [...tally.entries()]
          .map(([condition, count]) => ({ condition, count }))
          .sort((a, b) => b.count - a.count),
        recentCount: recent.length,
        windowDays: CONDITIONS_WINDOW_DAYS,
      };
    }),

  /**
   * The caller's own review of a trail, or null.
   *
   * Its only job is to fill the form in. Null is the ordinary answer for someone who has not
   * reviewed this trail, so it is not an error.
   */
  mine: protectedProcedure
    .input(trailIdInput)
    .query(async ({ ctx, input }): Promise<ReviewShape | null> => {
      const row = await ctx.db.review.findUnique({
        where: { trailId_userId: { trailId: input.trailId, userId: ctx.user.id } },
        select: reviewSelect,
      });
      return row === null ? null : toReview(row, ctx.user.id);
    }),

  /**
   * Publish or amend. One review per person per trail, so this is the only write path.
   *
   * Interactive rather than a batched `$transaction([...])` because the aggregate refresh has
   * to read the rows the upsert just wrote. Two concurrent writes on the same trail serialise
   * on the trail row's update, so the last one out still leaves a correct average.
   */
  upsert: protectedProcedure
    .input(reviewWriteSchema)
    .mutation(async ({ ctx, input }): Promise<ReviewShape> => {
      await assertTrail(ctx.db, input.trailId);

      /*
       * **A report a moderator took down cannot be edited back into existence.**
       *
       * Without this the takedown lever is a suggestion: the write path here is an upsert
       * keyed on `(trailId, userId)`, so the author of a hidden review re-submitting the
       * form would update the same row — leaving `hiddenAt` set but replacing the body,
       * and, on the day somebody adds an "unhide" to a queue, restoring exactly the text
       * that was removed. Refusing the write is the only version of this that holds.
       *
       * Deleting their own hidden review is still allowed. That is `remove` below, it is
       * their own content, and the outcome — the text is gone — is the one the takedown
       * was for.
       */
      const existing = await ctx.db.review.findUnique({
        where: { trailId_userId: { trailId: input.trailId, userId: ctx.user.id } },
        select: { hiddenAt: true },
      });
      if (existing?.hiddenAt) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `${REMOVED_NOTICE_OWN} You cannot edit it while it is removed.`,
        });
      }

      const fields = {
        rating: input.rating,
        // Trimmed to null rather than kept as "": an empty body and no body are the same
        // thing to a reader, and only one of them should reach the renderer.
        body: input.body?.trim() ? input.body.trim() : null,
        hikedOn: input.hikedOn == null ? null : toUtcMidnight(input.hikedOn),
        conditions: { set: input.conditions },
        activityType: input.activityType ?? null,
      };

      const row = await ctx.db.$transaction(async (tx) => {
        const saved = await tx.review.upsert({
          where: { trailId_userId: { trailId: input.trailId, userId: ctx.user.id } },
          create: { trailId: input.trailId, userId: ctx.user.id, ...fields },
          update: fields,
          select: reviewSelect,
        });
        await refreshRatingAggregates(tx, input.trailId);
        return saved;
      });

      return toReview(row, ctx.user.id);
    }),

  /**
   * Withdraw your own review.
   *
   * Keyed by trail rather than by review id, which makes it structurally impossible to
   * delete someone else's: the unique index is `(trailId, userId)` and `userId` is the
   * caller's, never an input. A count of zero means there was nothing of theirs to remove.
   */
  remove: protectedProcedure.input(trailIdInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const { count } = await tx.review.deleteMany({
        where: { trailId: input.trailId, userId: ctx.user.id },
      });
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'You have not reviewed this trail.' });
      }
      await refreshRatingAggregates(tx, input.trailId);
      return { removed: true };
    });
  }),
});
