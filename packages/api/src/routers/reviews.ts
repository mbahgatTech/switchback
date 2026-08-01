/**
 * Reviews. The write path is an upsert, not an append — `@@unique([trailId, userId])` holds one
 * review per person per trail, which is why there is no `create` here.
 *
 * `Trail.rating` and `Trail.reviewCount` are recomputed in the same transaction as every write.
 * `Trail.popularity` is deliberately left alone: `packages/busyness/prior.ts` already counts
 * reviews as their own term in `demandEvidence`, so folding them in here would count every
 * review twice in the busyness prior. `helpfulCount` is read and never written — there is no
 * `ReviewHelpful` join table, so an increment endpoint would be a spam button, not a vote.
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
 * Everything a rendered review needs, plus the author's public fields. `select` rather than
 * `include`, so no `users` column ever reaches the wire that is not named here.
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
  // The timestamp only: `hiddenReason` is the moderator's note, answered on appeal rather than
  // published back to the page the complaint was about.
  hiddenAt: true,
  user: { select: { id: true, username: true, name: true, image: true } },
  // Oldest first and capped. A nested `select` rather than a second round trip, so the shape
  // cannot drift between the list and the caller's own copy.
  photos: {
    // A photograph a moderator took down must not come back attached to a report left up. The
    // strip just gets shorter — a gap in a row of thumbnails communicates nothing.
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
 * How many recent reports the conditions tally reads. A cap rather than a full scan; ordered
 * newest first so it drops the oldest reports rather than an arbitrary page.
 */
const CONDITIONS_SAMPLE_MAX = 500;

/** Every rating that exists, highest first — the order the histogram is always drawn in. */
const RATINGS = [5, 4, 3, 2, 1] as const;

const trailIdInput = z.object({ trailId: z.string().min(1).max(64) });

/**
 * A calendar date out of a `DateTime` column. Written at UTC midnight and read back by slicing
 * the ISO string: formatting it in any local zone, including the server's, turns "hiked it on
 * the 3rd" into the 2nd for half the planet.
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
    /*
     * A hidden report is a tombstone, not a 404 and not a deletion: the row survives so the
     * page can print "removed by a moderator" where the report was, rather than letting it
     * vanish silently on its author and on anyone who linked to it.
     *
     * Everything the moderator objected to is stripped, and so is every *number* the row
     * carried. A value no renderer draws is still published — it ships in the JSON, and it can
     * be read off the row's position in a sorted list. `rating` leaked through `rating_desc`
     * ordering while `ratingCounts` excluded it from the average, so the page both refused the
     * rating and announced it; `helpfulCount` was actually drawn, printing "3 found this
     * useful" under the tombstone once `activityType` was nulled. What survives is that
     * somebody reported on this trail and when. Nothing numeric.
     */
    rating: hidden ? null : row.rating,
    body: hidden ? null : row.body,
    hikedOn: toDateString(row.hikedOn),
    // Re-normalised on the way out as well as in: rows predating this router have no guarantee
    // of canonical order, and the chips must not reshuffle between two identical reviews.
    conditions: hidden ? [] : normaliseConditions(row.conditions),
    activityType: hidden ? null : row.activityType,
    helpfulCount: hidden ? 0 : row.helpfulCount,
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
 * Tombstones last, as a block, in every sort whose key a tombstone no longer carries.
 * `nulls: 'first'` puts the visible rows ahead of the removed ones.
 *
 * This closes the half of the leak that stripping the shape cannot: `toReview` runs after
 * Postgres has sorted, so nulling `rating` changes what a row says and not where it stands,
 * and under `rating_desc` a tombstone in position one says "five stars" to anyone who can
 * count. Deliberately **not** applied to `recent`, which keys on `createdAt` — the tombstone
 * prints that on its own face, and holding it in chronological place is the point of the row.
 */
const TOMBSTONES_LAST = { hiddenAt: { sort: 'desc', nulls: 'first' } } as const;

/**
 * Sort orders, each with a full tiebreak chain. The trailing `id` is not decoration: these
 * pages are offset-based, and Postgres may return equal rows in any order between two queries,
 * so a sort stopping at `rating` can show one review twice and drop another.
 */
export const ORDER_BY: Readonly<Record<ReviewSort, Prisma.ReviewOrderByWithRelationInput[]>> = {
  recent: [{ createdAt: 'desc' }, { id: 'desc' }],
  rating_desc: [TOMBSTONES_LAST, { rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  rating_asc: [TOMBSTONES_LAST, { rating: 'asc' }, { createdAt: 'desc' }, { id: 'desc' }],
  helpful: [TOMBSTONES_LAST, { helpfulCount: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
};

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

type RatingCounts = [number, number, number, number, number];

/**
 * Counts indexed by rating − 1, so `counts[0]` is the one-star bucket. **Hidden reports are not
 * counted, anywhere** — a rating the page may not show that is still inside the mean never
 * self-corrects, since nothing recomputes a trail's average until the next review lands. The
 * filter lives here because this is the only function that reads ratings.
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
 * Recompute the two denormalised columns from the reviews that actually exist. Recomputed
 * rather than incremented — an increment must know whether a write was a create or an edit and
 * by how much the rating moved, and every branch is a way for the card to drift permanently.
 * The average goes through `averageRating`, the same function the summary uses, so the title
 * block and the histogram cannot round differently.
 *
 * Exported because `routers/moderation.ts` must call it: hiding a review changes the mean
 * exactly as much as deleting one.
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

export const reviewsRouter = router({
  /** One page of reviews. Public: reading a public trail's reports needs no account. */
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
   * The distribution and what people are reporting lately. Separate from `list` because it is
   * the same answer for every page and sort, and folding it in would recompute a histogram on
   * every scroll.
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
            // Same rule as the ratings: what a moderator took down is not evidence about the
            // ground.
            hiddenAt: null,
            // Dated by when they were *there*, falling back to when they wrote it. A report
            // filed today about a hike last spring is not evidence about this week's ground.
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

  /** The caller's own review of a trail, or null — the form's initial value. */
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
   * Interactive rather than a batched `$transaction([...])` because the aggregate refresh has
   * to read the rows the upsert just wrote.
   */
  upsert: protectedProcedure
    .input(reviewWriteSchema)
    .mutation(async ({ ctx, input }): Promise<ReviewShape> => {
      await assertTrail(ctx.db, input.trailId);

      /*
       * A report a moderator took down cannot be edited back into existence. The upsert is
       * keyed on `(trailId, userId)`, so without this its author could re-submit the form and
       * replace the body under the same `hiddenAt` — restoring the removed text the day
       * somebody adds an "unhide". `remove` refuses a hidden review for the same reason, and
       * has to: delete the tombstone and the next upsert finds no row, passes this check, and
       * republishes the prose under a fresh id with the audit gone.
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
        // Trimmed to null rather than kept as "": an empty body and no body are the same thing
        // to a reader, and only one of them should reach the renderer.
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
   * Withdraw your own review. Keyed by trail rather than by review id, which makes deleting
   * someone else's structurally impossible: the unique index is `(trailId, userId)` and
   * `userId` is the caller's, never an input.
   *
   * **A removed review cannot be withdrawn** — deleting the tombstone frees the
   * `(trailId, userId)` key, so the next upsert recreates the same prose with no `hiddenAt`,
   * the audit trail gone and every `ContentReport` against the old id orphaned.
   */
  remove: protectedProcedure.input(trailIdInput).mutation(async ({ ctx, input }) => {
    return ctx.db.$transaction(async (tx) => {
      const { count } = await tx.review.deleteMany({
        where: { trailId: input.trailId, userId: ctx.user.id, hiddenAt: null },
      });
      if (count === 0) {
        // Two reasons the delete matched nothing, owed different answers. The second read only
        // happens on the failure path, so the ordinary delete is still one statement.
        const existing = await tx.review.findUnique({
          where: { trailId_userId: { trailId: input.trailId, userId: ctx.user.id } },
          select: { hiddenAt: true },
        });
        if (existing?.hiddenAt) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: `${REMOVED_NOTICE_OWN} You cannot delete it while it is removed.`,
          });
        }
        throw new TRPCError({ code: 'NOT_FOUND', message: 'You have not reviewed this trail.' });
      }
      await refreshRatingAggregates(tx, input.trailId);
      return { removed: true };
    });
  }),
});
