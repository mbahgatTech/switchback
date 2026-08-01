/**
 * Receiving a complaint, and acting on one.
 *
 * The two things a product needs before it will host imagery at a permanent public URL,
 * and neither is worth having alone. See `packages/core/src/moderation.ts` for why hiding
 * is soft, why aggregates exclude hidden rows, and why there is no image classifier here.
 *
 * **The tiers.** `report` is public — a complaint from somebody with no account is still a
 * complaint, and quite often the most urgent one, because the person who finds their own
 * house in a photograph is not a member. Everything that acts on a report is
 * `moderatorProcedure`, and the one procedure that grants the role is `adminProcedure`.
 * Both of those are middleware in `trpc.ts`, so the check happens before the resolver and
 * before the database, and hiding a button in the UI is not part of the enforcement.
 *
 * **Why hide and resolve are one call.** A moderator who hides something has decided the
 * complaint was right, and making them say so a second time in a separate action is how a
 * queue fills up with items that were dealt with and never closed. So `hide` upholds every
 * open report against that item in the same transaction, and `dismiss` closes them without
 * touching the content.
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
 * How many open reports one signed-in account may have outstanding.
 *
 * Not a rate limit — there is no rate limiter in this product yet, and pretending otherwise
 * would be worse than saying so. It is a cap on how much of the queue a single person can
 * occupy, which is the failure mode that actually stops the operator working: a hundred
 * reports from one account buries the one report from ninety-nine others.
 */
const MAX_OPEN_REPORTS_PER_REPORTER = 20;

/**
 * How many open complaints one item may collect before the rest are absorbed.
 *
 * **This is the bound that does not depend on having an account**, and it is why the cap
 * above is no longer defeated by signing out. Three open complaints about one photograph is
 * already more than enough for an operator to act — the fourth adds no information and one
 * more row to read — so the fourth is answered exactly as a duplicate is: `{ filed: true }`,
 * with nothing written. An abuser with no session can no longer put a thousand rows against
 * one review id, and the queue's `createdAt asc` ordering can no longer be stuffed.
 *
 * The cost is real and is worth stating: a genuine fourth reporter of a busy item is not
 * heard individually. They are not losing anything an operator would have acted on — the
 * item is already in the queue three times over — and the alternative is the flood.
 */
const MAX_OPEN_REPORTS_PER_SUBJECT = 3;

/**
 * How deep the anonymous half of the queue may get before it stops accepting more.
 *
 * The second identity-free bound, and the one that stops a flood spread thinly across many
 * scraped subject ids from reaching the per-item cap on all of them at once. Signed-in
 * reports are counted separately and are never refused by this, so a flood cannot displace
 * the reports we can actually answer. The refusal names the email address, which is the
 * route that still works when the box is full.
 */
const MAX_OPEN_ANONYMOUS_REPORTS = 500;

/**
 * Why a photograph is hidden when its trail report was the thing taken down.
 *
 * A sentinel rather than the moderator's note, and matched exactly on the way back: `unhide`
 * clears only the photographs the cascade hid, so a frame that was taken down on its own
 * merits — an unrelated complaint, a different decision, possibly a different moderator —
 * stays down when the report it happened to be filed with is put back. The moderator's own
 * note lives on the review row, which is where the decision was made.
 */
const CASCADED_FROM_REVIEW = 'Filed with a trail report that was taken down.';

const subjectRef = z.object({
  subject: z.enum(REPORT_SUBJECTS),
  subjectId: z.string().min(1).max(64),
});

/**
 * The thing being complained about exists, and where it lives.
 *
 * Checked before a report is written so a bad id is refused rather than filed: a queue full
 * of complaints about rows that never existed is a queue an operator stops reading. Returns
 * the trail id so the report can carry it, which is what lets the queue be read by place
 * even after the content itself has been deleted.
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

/**
 * Close every open complaint about one item, in the same breath as acting on it.
 *
 * `updateMany` rather than a loop: three people reporting the same photograph is the
 * ordinary case, not the exception, and all three are answered by the one decision.
 */
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
   * Tell us about something.
   *
   * Public, and that is the whole point — see this module's header. The reporter's id comes
   * from the session when there is one and is null when there is not; it is never accepted
   * from the input, which is why `reportSubmitSchema` has no field for it.
   *
   * **Every bound here holds without an account.** The per-reporter cap below was once the
   * only one, which made it a cap on being polite enough to stay signed in: the same POST
   * without a session cookie skipped it, and this is the only unauthenticated write in the
   * product that keeps a row. So the two identity-free bounds run first and run for
   * everybody — how many open complaints one item may hold, and how deep the anonymous half
   * of the queue may get — in the same spirit as the four `trails.fetchArea` documents for
   * the other public write.
   *
   * A submission absorbed by a cap returns as though it worked. Telling somebody "this has
   * been reported three times already" is information about a queue they cannot see, and the
   * honest answer to "I reported this" is the same either way: we have it.
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
        /*
         * Scoped to open reports, which is the only claim the dedupe can honestly make.
         * Without the status filter one report of an item silences that reporter about it
         * forever — including after the report was dismissed and the author edited the
         * review into something worse, which is exactly when a second complaint matters.
         */
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
        // The same dedupe, on the only handle an anonymous reporter leaves. Costs one
        // indexed lookup and closes the easy duplicate — somebody pressing send twice.
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
          // Says what happened and where to go instead. The address is read by a person and
          // is not behind this cap.
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
   * The queue: what is waiting, oldest first.
   *
   * Oldest first rather than newest, which is the opposite of every other list in this
   * product. A feed is read newest first because the new thing is the interesting one; a
   * queue is worked oldest first because the old thing is the one that has been ignored
   * longest, and a moderator who works from the top of a newest-first list never reaches
   * the bottom of it.
   *
   * The content itself is fetched alongside rather than joined, because the subject is an
   * id and a kind rather than a foreign key — see `ContentReport` in the schema for why
   * that is deliberate. A report whose content has since been deleted comes back with a
   * null `content`, which is correct: the complaint still happened.
   *
   * **Paged.** One hundred rows was the whole of the queue and there was no way past them,
   * so a run of junk at the front made every genuine report behind it unreachable rather
   * than merely late. Same offset cursor the review list uses.
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
                /*
                 * The photographs filed with the report, because they are usually what the
                 * complaint is actually about — "sexual", "personal information" and
                 * "copyright" against a review are nearly always about an image attached to
                 * it. An operator deciding without seeing them is deciding blind, and the
                 * takedown now cascades onto exactly these rows, so this is also the list
                 * of what the button will hide.
                 */
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
   * Take something down.
   *
   * One procedure for both kinds, because the decision is the same decision and splitting it
   * would give two places for the aggregate refresh to be forgotten in.
   *
   * **The aggregate refresh is the part that is easy to leave out and expensive to leave
   * out.** Hiding a one-star review without recomputing the trail's mean leaves a rating on
   * a card that includes a review the page will not show, and it never self-corrects,
   * because nothing else recomputes it until the next person writes a review. Same for a
   * photograph: the count on the card and the hero on the trail both have to settle onto the
   * photographs that are still visible.
   *
   * **Hiding a review hides the photographs filed with it.** A review's photographs are
   * ordinary trail photographs — `commit` writes the `trailId` and `attach` only adds the
   * `reviewId` afterwards — so they satisfy `trails.photos`'s `{ trailId, hiddenAt: null }`
   * on their own. Without the cascade the reader got "Removed by a moderator after a report."
   * in the reports list and the reported image itself two sections up the same page, still
   * counted, still a candidate for the hero at the top and for the page's OG image. The
   * complaint is very often *about* the photograph; taking down only the prose around it is
   * not a takedown.
   *
   * Idempotent. Hiding something already hidden refreshes the timestamp and closes any
   * reports that arrived since, which is what a moderator working a queue of duplicates
   * actually wants.
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
          /*
           * `hiddenAt: null` in the predicate so a photograph already down on its own merits
           * keeps its own reason and is not relabelled as a casualty of this decision — which
           * is what lets `unhide` leave it down.
           */
          await tx.photo.updateMany({
            where: { reviewId: review.id, hiddenAt: null },
            data: { ...hidden, hiddenReason: CASCADED_FROM_REVIEW },
          });
          await refreshRatingAggregates(tx, review.trailId);
          // Now that photographs may have left the gallery, the count and the hero have to
          // settle — the same reason the photo branch below has always called this.
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
   * Put it back.
   *
   * The half of a takedown lever that makes it safe to use. A moderator who cannot reverse
   * a decision hesitates over every borderline one, and hesitating is how the genuinely bad
   * thing stays up for a week. The aggregates are refreshed on the way back in for the same
   * reason they are on the way out.
   *
   * This does *not* reopen the reports that were upheld. They were answered; the answer has
   * since been changed, and `resolutionNote` is where that is written down.
   *
   * **The photograph cascade reverses asymmetrically, on purpose.** Putting a review back
   * restores only the photographs `hide` took down with it — matched on the sentinel reason
   * — and leaves alone any frame that was hidden by its own complaint. The alternative
   * un-hides somebody's reported photograph as a side effect of an unrelated appeal
   * succeeding, which is the sort of quiet re-publication a takedown process cannot afford.
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
   * Read it, decide there is nothing to do, and close it.
   *
   * Distinct from `hide` on purpose: "we looked and left it up" is a real outcome and has
   * to be recordable, or the only way to empty the queue is to take things down.
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
   * Appoint or demote somebody. **The only write to `User.role` in the product.**
   *
   * `adminProcedure`, not `moderatorProcedure`, and the difference is the point: the
   * takedown lever is delegable and this is not. See `trpc.ts`.
   *
   * **An administrator cannot change their own role.** Not paternalism — it removes the
   * only single-call path from "an admin session was taken" to "there are no admins left",
   * and it makes the last-administrator problem impossible to reach by accident. Demoting
   * yourself is a database operation, performed deliberately, by somebody who has checked
   * that another administrator exists.
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
   * Who currently holds the lever.
   *
   * Moderators may read this, not only administrators: "who else can act on this" is a
   * question a moderator has during an incident, and the answer is a handful of usernames
   * rather than anything sensitive.
   */
  operators: moderatorProcedure.query(({ ctx }) =>
    ctx.db.user.findMany({
      where: { role: { in: ['moderator', 'admin'] } },
      select: { id: true, username: true, name: true, role: true },
      orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
    }),
  ),
});
