/**
 * Receiving a complaint, and acting on one. See `packages/core/src/moderation.ts` for why
 * hiding is soft, why aggregates exclude hidden rows, and why there is no image classifier.
 *
 * `report` is public — the person who finds their own house in a photograph is usually not a
 * member. Everything acting on a report is `moderatorProcedure` and the one role grant is
 * `adminProcedure`; both are middleware in `trpc.ts`, so the check runs before the resolver.
 * `hide` upholds every open report against the item in the same transaction and `dismiss`
 * closes them without touching the content, so a queue cannot fill with items already dealt
 * with.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  MODERATION_CONTACT,
  MODERATION_NOTE_MAX,
  REPORT_SUBJECTS,
  USER_ROLES,
  reportSubmitSchema,
} from '@switchback/core';
import type { ReportSubject } from '@switchback/core';
import type { Prisma } from '@switchback/db';
import { decodeCursor, encodeCursor } from '../cursor';
import { adminProcedure, moderatorProcedure, publicProcedure, router } from '../trpc';
import { refreshRatingAggregates } from './reviews';
import { refreshTrailPhotos } from './photos';

/**
 * How many open reports one signed-in account may have outstanding. Not a rate limit — there
 * is no rate limiter here — but a cap on how much of the queue one person can occupy.
 */
const MAX_OPEN_REPORTS_PER_REPORTER = 20;

/**
 * How many open complaints one item may collect before the rest are absorbed. The first bound
 * that does not depend on having an account, so the cap above is not defeated by signing out.
 * The fourth complaint is answered exactly as a duplicate is, `{ filed: true }`, with nothing
 * written — a genuine fourth reporter is not heard individually, and the alternative is a
 * thousand rows against one review id stuffing the queue's `createdAt asc` ordering.
 */
const MAX_OPEN_REPORTS_PER_SUBJECT = 3;

/**
 * How deep the anonymous half of the queue may get before it stops accepting more. The second
 * identity-free bound, stopping a flood spread thinly across many scraped subject ids. Signed-in
 * reports are counted separately and never refused by this, so a flood cannot displace the
 * reports we can answer; the refusal names the email address, which still works when full.
 */
const MAX_OPEN_ANONYMOUS_REPORTS = 500;

/**
 * Why a photograph is hidden when its trail report was the thing taken down. A sentinel rather
 * than the moderator's note, matched exactly on the way back so `unhide` clears only the
 * photographs this cascade hid and a frame taken down on its own merits stays down.
 */
const CASCADED_FROM_REVIEW = 'Filed with a trail report that was taken down.';

const subjectRef = z.object({
  subject: z.enum(REPORT_SUBJECTS),
  subjectId: z.string().min(1).max(64),
});

/**
 * The thing being complained about exists, and where it lives. Checked before a report is
 * written, so a bad id is refused rather than filed. Returns the trail id so the report can
 * carry it, which lets the queue be read by place even after the content is deleted.
 */
async function locateSubject(
  db: Prisma.TransactionClient,
  subject: ReportSubject,
  subjectId: string,
): Promise<{ trailId: string | null }> {
  if (subject === 'review') {
    const review = await db.review.findUnique({
      where: { id: subjectId },
      select: { trailId: true },
    });
    if (!review) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such report.' });
    return { trailId: review.trailId };
  }

  const photo = await db.photo.findUnique({
    where: { id: subjectId },
    select: { trailId: true },
  });
  if (!photo) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such photograph.' });
  return { trailId: photo.trailId };
}

/** Close every open complaint about one item, in the same breath as acting on it. */
async function closeReports(
  db: Prisma.TransactionClient,
  subject: ReportSubject,
  subjectId: string,
  status: 'upheld' | 'dismissed',
  moderatorId: string,
  note: string | null,
): Promise<number> {
  const { count } = await db.contentReport.updateMany({
    where: { subject, subjectId, status: 'open' },
    data: {
      status,
      resolvedAt: new Date(),
      resolvedById: moderatorId,
      resolutionNote: note,
    },
  });
  return count;
}

export const moderationRouter = router({
  /**
   * Tell us about something. Public. The reporter's id comes from the session when there is
   * one and is never accepted from the input, which is why `reportSubmitSchema` has no field
   * for it.
   *
   * **Every bound here holds without an account.** This is the only unauthenticated write in
   * the product that keeps a row, and the per-reporter cap alone was defeated by dropping the
   * session cookie, so the two identity-free bounds run first and run for everybody. A
   * submission absorbed by a cap returns as though it worked: telling somebody "this has been
   * reported three times already" is information about a queue they cannot see.
   */
  report: publicProcedure.input(reportSubmitSchema).mutation(async ({ ctx, input }) => {
    const { trailId } = await locateSubject(ctx.db, input.subject, input.subjectId);
    const reporterId = ctx.user?.id ?? null;
    const contactEmail = input.contactEmail?.trim() ? input.contactEmail.trim() : null;
    const about = { subject: input.subject, subjectId: input.subjectId, status: 'open' } as const;

    // First, and for everybody. Served by `@@index([subject, subjectId])`.
    const onSubject = await ctx.db.contentReport.count({ where: about });
    if (onSubject >= MAX_OPEN_REPORTS_PER_SUBJECT) return { filed: true };

    if (reporterId !== null) {
      const [already, open] = await Promise.all([
        // Scoped to open reports, the only claim the dedupe can honestly make: without the
        // status filter one report silences that reporter about the item forever, including
        // after a dismissal and an edit into something worse.
        ctx.db.contentReport.findFirst({ where: { ...about, reporterId }, select: { id: true } }),
        ctx.db.contentReport.count({ where: { reporterId, status: 'open' } }),
      ]);

      if (already) return { filed: true };
      if (open >= MAX_OPEN_REPORTS_PER_REPORTER) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: `You have ${open} reports waiting on a moderator. Give us a chance to read those first.`,
        });
      }
    } else {
      const [already, openAnonymous] = await Promise.all([
        // The same dedupe, on the only handle an anonymous reporter leaves.
        contactEmail === null
          ? Promise.resolve(null)
          : ctx.db.contentReport.findFirst({
              where: { ...about, contactEmail },
              select: { id: true },
            }),
        ctx.db.contentReport.count({ where: { reporterId: null, status: 'open' } }),
      ]);

      if (already) return { filed: true };
      if (openAnonymous >= MAX_OPEN_ANONYMOUS_REPORTS) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          // The address is read by a person and is not behind this cap.
          message: `We have more reports waiting than a moderator can read. Write to ${MODERATION_CONTACT.email} and say what and where.`,
        });
      }
    }

    await ctx.db.contentReport.create({
      data: {
        subject: input.subject,
        subjectId: input.subjectId,
        trailId,
        reason: input.reason,
        detail: input.detail?.trim() ? input.detail.trim() : null,
        reporterId,
        contactEmail,
      },
    });

    return { filed: true };
  }),

  /**
   * The queue: what is waiting, oldest first — a queue is worked from the oldest item, where
   * a feed is read from the newest. Paged, so a run of junk at the front cannot make every
   * genuine report behind it unreachable.
   *
   * The content is fetched alongside rather than joined, because the subject is an id and a
   * kind rather than a foreign key (see `ContentReport` in the schema). A report whose content
   * has since been deleted comes back with a null `content`: the complaint still happened.
   */
  queue: moderatorProcedure
    .input(
      z.object({
        status: z.enum(['open', 'upheld', 'dismissed']).default('open'),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const offset = decodeCursor(input.cursor);
      const where = { status: input.status };

      const [reports, count] = await Promise.all([
        ctx.db.contentReport.findMany({
          where,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: offset,
          take: input.limit,
        }),
        ctx.db.contentReport.count({ where }),
      ]);

      const reviewIds = reports.filter((r) => r.subject === 'review').map((r) => r.subjectId);
      const photoIds = reports.filter((r) => r.subject === 'photo').map((r) => r.subjectId);

      const [reviews, photos] = await Promise.all([
        reviewIds.length === 0
          ? Promise.resolve([])
          : ctx.db.review.findMany({
              where: { id: { in: reviewIds } },
              select: {
                id: true,
                trailId: true,
                body: true,
                rating: true,
                hiddenAt: true,
                createdAt: true,
                user: { select: { id: true, username: true, name: true } },
                // Usually what the complaint is actually about, and now also the list of what
                // the takedown button will hide.
                photos: {
                  select: { id: true, thumbUrl: true, hiddenAt: true },
                  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                },
              },
            }),
        photoIds.length === 0
          ? Promise.resolve([])
          : ctx.db.photo.findMany({
              where: { id: { in: photoIds } },
              select: {
                id: true,
                trailId: true,
                url: true,
                thumbUrl: true,
                caption: true,
                hiddenAt: true,
                createdAt: true,
                user: { select: { id: true, username: true, name: true } },
              },
            }),
      ]);

      const byId = new Map<string, unknown>();
      for (const review of reviews) byId.set(`review:${review.id}`, review);
      for (const photo of photos) byId.set(`photo:${photo.id}`, photo);

      const consumed = offset + reports.length;
      return {
        reports: reports.map((report) => ({
          ...report,
          content: byId.get(`${report.subject}:${report.subjectId}`) ?? null,
        })),
        nextCursor: consumed < count ? encodeCursor(consumed) : null,
        total: count,
      };
    }),

  /**
   * Take something down. One procedure for both kinds, so there is only one place the
   * aggregate refresh can be forgotten — and it must not be: hiding a one-star review without
   * recomputing the mean leaves a rating on a card that includes a review the page will not
   * show, and nothing else recomputes it until the next review lands.
   *
   * **Hiding a review hides the photographs filed with it.** A review's photographs are
   * ordinary trail photographs — `commit` writes the `trailId` and `attach` only adds the
   * `reviewId` — so without the cascade the reported image stays two sections up the same
   * page, still counted and still a candidate for the hero and the OG image.
   *
   * Idempotent: hiding something already hidden refreshes the timestamp and closes reports
   * that arrived since.
   */
  hide: moderatorProcedure
    .input(subjectRef.extend({ note: z.string().trim().max(MODERATION_NOTE_MAX).nullish() }))
    .mutation(async ({ ctx, input }) => {
      const note = input.note?.trim() ? input.note.trim() : null;

      return ctx.db.$transaction(async (tx) => {
        const hidden = { hiddenAt: new Date(), hiddenById: ctx.user.id, hiddenReason: note };

        if (input.subject === 'review') {
          const review = await tx.review.findUnique({
            where: { id: input.subjectId },
            select: { id: true, trailId: true },
          });
          if (!review) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such report.' });

          await tx.review.update({ where: { id: review.id }, data: hidden });
          // `hiddenAt: null` in the predicate so a photograph already down on its own merits
          // keeps its own reason, which is what lets `unhide` leave it down.
          await tx.photo.updateMany({
            where: { reviewId: review.id, hiddenAt: null },
            data: { ...hidden, hiddenReason: CASCADED_FROM_REVIEW },
          });
          await refreshRatingAggregates(tx, review.trailId);
          // Photographs may have left the gallery, so the count and the hero have to settle.
          await refreshTrailPhotos(tx, review.trailId);
        } else {
          const photo = await tx.photo.findUnique({
            where: { id: input.subjectId },
            select: { id: true, trailId: true },
          });
          if (!photo) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such photograph.' });

          await tx.photo.update({ where: { id: photo.id }, data: hidden });
          if (photo.trailId) await refreshTrailPhotos(tx, photo.trailId);
        }

        const closed = await closeReports(
          tx,
          input.subject,
          input.subjectId,
          'upheld',
          ctx.user.id,
          note,
        );
        return { hidden: true, reportsClosed: closed };
      });
    }),

  /**
   * Put it back — the half of a takedown lever that makes it safe to use. Does *not* reopen
   * the reports that were upheld; they were answered, and `resolutionNote` records that the
   * answer changed.
   *
   * **The photograph cascade reverses asymmetrically, on purpose:** only the frames matched by
   * the sentinel reason come back, so an appeal succeeding cannot quietly re-publish a
   * photograph that was hidden by its own complaint.
   */
  unhide: moderatorProcedure
    .input(subjectRef.extend({ note: z.string().trim().max(MODERATION_NOTE_MAX).nullish() }))
    .mutation(async ({ ctx, input }) => {
      const cleared = { hiddenAt: null, hiddenById: null, hiddenReason: null };

      return ctx.db.$transaction(async (tx) => {
        if (input.subject === 'review') {
          const review = await tx.review.findUnique({
            where: { id: input.subjectId },
            select: { id: true, trailId: true },
          });
          if (!review) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such report.' });

          await tx.review.update({ where: { id: review.id }, data: cleared });
          await tx.photo.updateMany({
            where: { reviewId: review.id, hiddenReason: CASCADED_FROM_REVIEW },
            data: cleared,
          });
          await refreshRatingAggregates(tx, review.trailId);
          await refreshTrailPhotos(tx, review.trailId);
        } else {
          const photo = await tx.photo.findUnique({
            where: { id: input.subjectId },
            select: { id: true, trailId: true },
          });
          if (!photo) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such photograph.' });

          await tx.photo.update({ where: { id: photo.id }, data: cleared });
          if (photo.trailId) await refreshTrailPhotos(tx, photo.trailId);
        }

        return { hidden: false };
      });
    }),

  /**
   * Read it, decide there is nothing to do, and close it. Distinct from `hide` because "we
   * looked and left it up" has to be recordable, or the only way to empty the queue is to take
   * things down.
   */
  dismiss: moderatorProcedure
    .input(subjectRef.extend({ note: z.string().trim().max(MODERATION_NOTE_MAX).nullish() }))
    .mutation(async ({ ctx, input }) => {
      const closed = await closeReports(
        ctx.db,
        input.subject,
        input.subjectId,
        'dismissed',
        ctx.user.id,
        input.note?.trim() ? input.note.trim() : null,
      );
      return { reportsClosed: closed };
    }),

  /**
   * Appoint or demote somebody. **The only write to `User.role` in the product**, and
   * `adminProcedure` rather than `moderatorProcedure`: the takedown lever is delegable and
   * this is not.
   *
   * **An administrator cannot change their own role.** That removes the only single-call path
   * from "an admin session was taken" to "there are no admins left".
   */
  setRole: adminProcedure
    .input(z.object({ userId: z.string().min(1).max(64), role: z.enum(USER_ROLES) }))
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.user.id) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Change your own role from the database, with another administrator watching.',
        });
      }

      const target = await ctx.db.user.findUnique({
        where: { id: input.userId },
        select: { id: true },
      });
      if (!target) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such account.' });

      const updated = await ctx.db.user.update({
        where: { id: input.userId },
        data: { role: input.role },
        select: { id: true, username: true, role: true },
      });
      return updated;
    }),

  /**
   * Who currently holds the lever. Moderators may read this too: "who else can act on this" is
   * a question they have during an incident, and the answer is a handful of usernames.
   */
  operators: moderatorProcedure.query(({ ctx }) =>
    ctx.db.user.findMany({
      where: { role: { in: ['moderator', 'admin'] } },
      select: { id: true, username: true, name: true, role: true },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    }),
  ),
});
