/**
 * Lifeline operations that are not procedures. Kept out of the router — like `orphans.ts` and
 * `tokens.ts` — because both are called from outside a tRPC request, one from the end of a
 * recording and one from the drain cron. See `packages/core/src/lifeline.ts` for the feature.
 */

import type { PrismaClient } from '@switchback/db';
import { overdueByS } from '@switchback/core';

/**
 * End whatever Lifeline is running for a hike, because the hike is over. Deliberately total:
 * failing to close a Lifeline must not fail the request that saves somebody's hike.
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
 * Call off whatever Lifeline is running for a hike, because the hike is being thrown away —
 * `activityId` is `SetNull`, so without this the Lifeline carries on alone and goes overdue for
 * a hike deleted at the trailhead. `cancelled` rather than `completed`: "Called off" is true of
 * an abandoned hike, "Back safely" would be a claim nobody made. Total, as above.
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
 * Mark active sessions that are past their return time. `@@index([status, expectedReturnAt])`
 * exists for this query, and `overdueNotifiedAt` is stamped in the same statement so a future
 * transport can answer "has this contact already been told" without a second table.
 *
 * **This is not what makes the feature work.** The follow page derives lateness from
 * `expectedReturnAt` on every read and is correct whether or not this has run; a safety feature
 * whose correctness depends on a healthy cron fails quietly.
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

  // There is no mail or SMS transport yet, so this is where the notification would go and a
  // log line is what honestly happens instead. The hiker's contact is told by the page they
  // were sent, which updates itself.
  for (const row of due) {
    console.warn('lifeline overdue', {
      id: row.id,
      contactName: row.contactName,
      lateByS: overdueByS(row.expectedReturnAt, now),
    });
  }
  return { flipped: due.length };
}
