/**
 * Lifeline operations that are not procedures.
 *
 * Kept out of the router — like `orphans.ts` and `tokens.ts` — because both of these are
 * called from outside a tRPC request: one from the end of a recording, one from the drain
 * cron. A module that a cron route imports should not drag a router's worth of procedure
 * definitions in behind it.
 *
 * Read `packages/core/src/lifeline.ts` for why the feature is shaped the way it is.
 */

import type { PrismaClient } from '@switchback/db';
import { overdueByS } from '@switchback/core';

/**
 * End whatever Lifeline is running for a hike, because the hike is over.
 *
 * Called from `activities.finish`: somebody who has finished a recording has, by definition,
 * got back — and a Lifeline that stays open after that is exactly the thing that trains a
 * contact to ignore the next one.
 *
 * Deliberately total: it never throws. Failing to close a Lifeline must not fail the request
 * that saves somebody's hike.
 */
export async function endLifelineForActivity(
  db: PrismaClient,
  activityId: string,
  endedAt: Date,
): Promise<number> {
  try {
    const { count } = await db.lifelineSession.updateMany({
      where: { activityId, status: { in: ['active', 'overdue'] } },
      data: { status: 'completed', endedAt },
    });
    return count;
  } catch (error) {
    console.warn('lifeline auto-end failed', error);
    return 0;
  }
}

/**
 * Call off whatever Lifeline is running for a hike, because the hike is being thrown away.
 *
 * The hole this closes: a recording is discarded, the row goes, `activityId` nulls out under
 * `SetNull` — and the Lifeline carries on alone until it goes overdue after dark and rings an
 * alarm for a hike that was deleted at the trailhead. Somebody would be told to worry about a
 * person who never set off.
 *
 * `cancelled` rather than `completed` because they are different things and the follow page
 * says so: "Called off" is true of a hike that was abandoned, "Back safely" would be a claim
 * nobody made. Total, for the same reason as above — a failure here must not block the delete.
 */
export async function cancelLifelineForActivity(
  db: PrismaClient,
  activityId: string,
  endedAt: Date = new Date(),
): Promise<number> {
  try {
    const { count } = await db.lifelineSession.updateMany({
      where: { activityId, status: { in: ['active', 'overdue'] } },
      data: { status: 'cancelled', endedAt },
    });
    return count;
  } catch (error) {
    console.warn('lifeline auto-cancel failed', error);
    return 0;
  }
}

/** How many sessions one sweep will flip. A backstop, not a throughput limit. */
const SWEEP_LIMIT = 200;

export interface OverdueSweep {
  /** Sessions that crossed their return time on this tick. */
  flipped: number;
}

/**
 * Mark active sessions that are past their return time.
 *
 * The `@@index([status, expectedReturnAt])` on the model exists for precisely this query.
 * `overdueNotifiedAt` is stamped in the same statement, so the day a transport lands the
 * question "has this contact already been told" is answerable without a second table — and
 * so that until then the log line is emitted once per session rather than once a minute.
 *
 * **This is not what makes the feature work.** The follow page derives lateness from
 * `expectedReturnAt` on every read and is correct whether or not this has ever run. The
 * sweep persists the status and is the hook an outward notification will attach to. A safety
 * feature whose correctness depends on a cron being healthy is a safety feature that fails
 * quietly, which is the worst way for this particular one to fail.
 */
export async function sweepOverdueLifelines(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<OverdueSweep> {
  const due = await db.lifelineSession.findMany({
    where: { status: 'active', expectedReturnAt: { lte: now }, overdueNotifiedAt: null },
    select: { id: true, contactName: true, expectedReturnAt: true },
    orderBy: { expectedReturnAt: 'asc' },
    take: SWEEP_LIMIT,
  });
  if (due.length === 0) return { flipped: 0 };

  await db.lifelineSession.updateMany({
    where: { id: { in: due.map((row) => row.id) } },
    data: { status: 'overdue', overdueNotifiedAt: now },
  });

  /*
   * There is no mail or SMS transport in this product yet, so this is where the notification
   * would go and a log line is what honestly happens instead. Logged rather than silently
   * dropped: an operator can see that a hiker went overdue, which is the difference between
   * a feature that is incomplete and one that is broken. The hiker's contact is told by the
   * page they were sent, which updates itself — that is the promise the interface actually
   * makes, and it is kept.
   */
  for (const row of due) {
    console.warn('lifeline overdue', {
      id: row.id,
      contactName: row.contactName,
      lateByS: overdueByS(row.expectedReturnAt, now),
    });
  }
  return { flipped: due.length };
}
