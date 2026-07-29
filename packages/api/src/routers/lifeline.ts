/**
 * Lifeline — the note left at the pub, kept current by a phone.
 *
 * Read `packages/core/src/lifeline.ts` first; the reasoning lives there. What this file adds
 * is the enforcement.
 *
 * **The token is the only credential on the follow route, so it is generated the way a
 * credential is.** 24 random bytes from the CSPRNG, base64url, not a cuid — cuids embed a
 * timestamp and a counter and are guessable in bulk by design, which is fine for a row id
 * and disqualifying for a link that discloses somebody's position.
 *
 * **`follow` is the only public procedure here and it is written defensively.** It returns a
 * hand-built object rather than a row: no user id, no activity id, no track. And it withholds
 * the position entirely once the session is over, which is the promise in the core module
 * made mechanical — the shape has nowhere to put a position for a finished hike.
 *
 * **Overdue is derived on every read.** The sweep in the drain cron persists it, but nothing
 * on the follow page depends on the sweep having run. A safety feature that only works when
 * a cron is healthy is a safety feature that fails silently.
 */

import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  LIFELINE_CONTACT_NAME_MAX,
  LIFELINE_MESSAGE_MAX,
  MAX_LIFELINE_MINUTES,
  MIN_LIFELINE_MINUTES,
  isLive,
  isStalePing,
  overdueByS,
} from '@switchback/core';
import type { LifelineFollow, LifelineSession } from '@switchback/core';
import type { Prisma } from '@switchback/db';
import { protectedProcedure, publicProcedure, router } from '../trpc';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

const trailSelect = { id: true, slug: true, name: true, regionName: true } as const;

const sessionSelect = {
  id: true,
  token: true,
  status: true,
  contactName: true,
  message: true,
  startedAt: true,
  expectedReturnAt: true,
  endedAt: true,
  lastPingAt: true,
  activityId: true,
  trail: { select: trailSelect },
} satisfies Prisma.LifelineSessionSelect;

type SessionRow = Prisma.LifelineSessionGetPayload<{ select: typeof sessionSelect }>;

/**
 * The hiker's own view.
 *
 * `status` is corrected on the way out rather than trusted from the row, for the same reason
 * the follow view does it: a hiker who opens the app twenty minutes late should see that
 * they are late, whether or not a cron has run in the meantime.
 */
function toSession(row: SessionRow, now: Date): LifelineSession {
  return {
    id: row.id,
    token: row.token,
    status:
      row.status === 'active' && row.expectedReturnAt.getTime() <= now.getTime()
        ? 'overdue'
        : row.status,
    contactName: row.contactName,
    message: row.message,
    startedAt: row.startedAt,
    expectedReturnAt: row.expectedReturnAt,
    endedAt: row.endedAt,
    lastPingAt: row.lastPingAt,
    activityId: row.activityId,
    trail: row.trail,
  };
}

/** 32 characters of base64url. Long enough that guessing is not a strategy. */
function mintToken(): string {
  return randomBytes(24).toString('base64url');
}

function minutesFromNow(minutes: number, now: Date): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const lifelineRouter = router({
  /**
   * Start telling somebody.
   *
   * Any Lifeline already running is called off first. One hiker is on one hike, and two live
   * links to two different return times is a way to get somebody looked for on the wrong hill.
   * Called off rather than replaced, so a contact holding the old link sees `Called off`
   * rather than a page that quietly starts describing a different hike.
   */
  create: protectedProcedure
    .input(
      z.object({
        activityId: z.string().min(1).max(64).nullish(),
        trailId: z.string().min(1).max(64).nullish(),
        contactName: z.string().trim().min(1).max(LIFELINE_CONTACT_NAME_MAX).nullish(),
        message: z.string().trim().max(LIFELINE_MESSAGE_MAX).nullish(),
        minutes: z.number().int().min(MIN_LIFELINE_MINUTES).max(MAX_LIFELINE_MINUTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();

      await ctx.db.lifelineSession.updateMany({
        where: { userId: ctx.user.id, status: { in: ['active', 'overdue'] } },
        data: { status: 'cancelled', endedAt: now },
      });

      // Both foreign keys are verified against the caller rather than taken on trust: an
      // activityId belonging to somebody else would attach a stranger's hike to this link.
      const activity = input.activityId
        ? await ctx.db.activity.findFirst({
            where: { id: input.activityId, userId: ctx.user.id },
            select: { id: true, trailId: true },
          })
        : null;
      const trailId = input.trailId ?? activity?.trailId ?? null;
      const trail = trailId
        ? await ctx.db.trail.findUnique({ where: { id: trailId }, select: { id: true } })
        : null;

      const row = await ctx.db.lifelineSession.create({
        data: {
          userId: ctx.user.id,
          activityId: activity?.id ?? null,
          trailId: trail?.id ?? null,
          token: mintToken(),
          status: 'active',
          contactName: input.contactName ?? null,
          message: input.message ?? null,
          startedAt: now,
          expectedReturnAt: minutesFromNow(input.minutes, now),
          /*
           * `contactEmail` and `contactPhone` stay null. The row can hold them and the day a
           * transport lands they will be collected; writing an address we cannot send to
           * would tell the hiker somebody gets notified, which is not true today.
           */
        },
        select: sessionSelect,
      });
      return toSession(row, now);
    }),

  /** The Lifeline currently running, if there is one. What the recorder asks on load. */
  active: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();
    const row = await ctx.db.lifelineSession.findFirst({
      where: { userId: ctx.user.id, status: { in: ['active', 'overdue'] } },
      orderBy: { startedAt: 'desc' },
      select: sessionSelect,
    });
    return row ? toSession(row, now) : null;
  }),

  /**
   * Where they are now.
   *
   * Its own mutation rather than a field on `activities.append`, because a Lifeline does not
   * require a recording — somebody who just wants their partner to be able to see where they
   * are should not have to record a hike to get it. Accuracy is not stored: the follow page
   * shows one dot and a time, and a radius on it would invite a precision the fix does not
   * have.
   */
  ping: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        lng: z.number().min(-180).max(180),
        lat: z.number().min(-90).max(90),
        eleM: z.number().min(-500).max(9_500).nullish(),
        batteryPct: z.number().int().min(0).max(100).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const { count } = await ctx.db.lifelineSession.updateMany({
        where: { id: input.id, userId: ctx.user.id, status: { in: ['active', 'overdue'] } },
        data: {
          lastPingAt: now,
          lastLng: input.lng,
          lastLat: input.lat,
          lastEleM: input.eleM ?? null,
          lastBatteryPct: input.batteryPct ?? null,
        },
      });
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That Lifeline is not running.' });
      }
      return { at: now };
    }),

  /**
   * Push the return time back.
   *
   * Measured from now rather than from the original return time. A hiker who is already an
   * hour late and asks for two more hours means two hours from this moment; adding to the
   * old deadline would leave them overdue the instant they pressed the button.
   *
   * An overdue session comes back to `active` and `overdueNotifiedAt` is cleared, so the next
   * overrun is a fresh event rather than one the sweep considers already reported.
   */
  extend: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        minutes: z.number().int().min(MIN_LIFELINE_MINUTES).max(MAX_LIFELINE_MINUTES),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const { count } = await ctx.db.lifelineSession.updateMany({
        where: { id: input.id, userId: ctx.user.id, status: { in: ['active', 'overdue'] } },
        data: {
          status: 'active',
          expectedReturnAt: minutesFromNow(input.minutes, now),
          overdueNotifiedAt: null,
        },
      });
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That Lifeline is not running.' });
      }
      const row = await ctx.db.lifelineSession.findUnique({
        where: { id: input.id },
        select: sessionSelect,
      });
      if (!row)
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That Lifeline is not running.' });
      return toSession(row, now);
    }),

  /**
   * "I'm back."
   *
   * `completed` and `cancelled` both end a session and both stop the position being served;
   * they differ only in what the follower is told. `cancelled` is for a hike that never
   * happened — the weather turned in the car park — where "Back safely" would be a small lie
   * in a place where lies are expensive.
   */
  end: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        outcome: z.enum(['completed', 'cancelled']).default('completed'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const { count } = await ctx.db.lifelineSession.updateMany({
        where: { id: input.id, userId: ctx.user.id, status: { in: ['active', 'overdue'] } },
        data: { status: input.outcome, endedAt: now },
      });
      if (count === 0) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'That Lifeline is not running.' });
      }
      return { endedAt: now };
    }),

  /** The hiker's own history. Their token is theirs to see; nobody else's ever is. */
  mine: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(50).default(10) }).optional())
    .query(async ({ ctx, input }) => {
      const now = new Date();
      const rows = await ctx.db.lifelineSession.findMany({
        where: { userId: ctx.user.id },
        orderBy: { startedAt: 'desc' },
        take: input?.limit ?? 10,
        select: sessionSelect,
      });
      return rows.map((row) => toSession(row, now));
    }),

  /**
   * What the link shows. The one public procedure in this router.
   *
   * A wrong token is `NOT_FOUND` with a message written for a worried person rather than for
   * a developer, because the most likely reader of that error is somebody who mistyped a link
   * they were sent, at the exact moment they least want to read the word "invalid".
   */
  follow: publicProcedure
    .input(z.object({ token: z.string().min(16).max(64) }))
    .query(async ({ ctx, input }): Promise<LifelineFollow> => {
      const row = await ctx.db.lifelineSession.findUnique({
        where: { token: input.token },
        select: {
          status: true,
          contactName: true,
          message: true,
          startedAt: true,
          expectedReturnAt: true,
          endedAt: true,
          lastPingAt: true,
          lastLng: true,
          lastLat: true,
          lastEleM: true,
          lastBatteryPct: true,
          trail: { select: trailSelect },
          user: { select: { name: true, username: true } },
        },
      });
      if (!row) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'This link does not point at a hike. Check it against the one you were sent.',
        });
      }

      const now = new Date();
      const status =
        row.status === 'active' && row.expectedReturnAt.getTime() <= now.getTime()
          ? 'overdue'
          : row.status;

      /*
       * The rule, in one place: a position is served only while the hike is live. Once it is
       * over — safely or not — the link keeps saying what happened and stops saying where
       * anybody is. Both coordinates are required together; half a position is not one.
       */
      const live = isLive(status);
      const at: LifelineFollow['at'] =
        live && row.lastLng != null && row.lastLat != null ? [row.lastLng, row.lastLat] : null;

      return {
        status,
        hikerName: row.user.name ?? (row.user.username ? `@${row.user.username}` : 'A hiker'),
        contactName: row.contactName,
        message: row.message,
        startedAt: row.startedAt,
        expectedReturnAt: row.expectedReturnAt,
        endedAt: row.endedAt,
        trail: row.trail,
        at,
        eleM: at ? (row.lastEleM ?? null) : null,
        lastPingAt: live ? row.lastPingAt : null,
        batteryPct: at ? (row.lastBatteryPct ?? null) : null,
        overdueByS: overdueByS(row.expectedReturnAt, now),
        // A finished hike has no current position, so it is never "current" — reporting it as
        // fresh would be the one wrong answer here.
        stale: live ? isStalePing(row.lastPingAt, now) : true,
      };
    }),
});
