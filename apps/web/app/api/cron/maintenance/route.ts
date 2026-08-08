import { pruneExpiredAuthRequests } from '@switchback/api/mobile-auth';
import { pruneExpiredRefreshTokens } from '@switchback/api/tokens';
import { type OverdueSweep, sweepOverdueLifelines } from '@switchback/api/lifeline';
import { type SweepResult, sweepOrphanedPhotos } from '@switchback/api/orphans';
import { prisma } from '@switchback/db';
import { env } from '@/env';

/**
 * Housekeeping that has to run on Vercel because the credentials it needs are here: R2 for the
 * orphan sweep, and the auth tables for the other two.
 *
 * **It does not touch the ingest queue.** Lease reclaim, split-marker repair and finished-job
 * collection moved to the Function App's `ingestPump`, which runs every two minutes beside the
 * only process that drains — `apps/web/vercel.json` asks for once a day, because Hobby fails the
 * deployment for any expression that would run more often, and a daily tick was never a schedule
 * for a twelve-minute lease.
 */
export const runtime = 'nodejs';

/** Vercel's cron scheduler will not wait longer than this, and neither should we. */
export const maxDuration = 60;

/**
 * Reject anyone who is not the scheduler. With no `CRON_SECRET` it refuses rather than running
 * open, so a misconfiguration shows as a 503 in the cron log.
 */
function authorized(req: Request): boolean {
  if (!env.CRON_SECRET) return false;
  return req.headers.get('authorization') === `Bearer ${env.CRON_SECRET}`;
}

/**
 * Sweep spent refresh tokens and sign-in requests. Both keep dead rows for a grace window — reuse
 * detection, and `expired` rather than `unknown_request` on a late claim — and past it they are
 * only a record of who signed in from where.
 */
async function sweepCredentials(): Promise<{ tokens: number; authRequests: number } | null> {
  try {
    const [tokens, authRequests] = await Promise.all([
      pruneExpiredRefreshTokens(prisma),
      pruneExpiredAuthRequests(prisma),
    ]);
    return { tokens, authRequests };
  } catch (error) {
    console.warn('credential sweep failed', error);
    return null;
  }
}

/**
 * Collect photograph bytes no row points at. The upload flow writes the object before the row on
 * purpose (`packages/api/orphans.ts` argues why), so an abandoned upload leaves bytes we pay for
 * and cannot see.
 */
async function sweepOrphans(): Promise<SweepResult | null> {
  try {
    return await sweepOrphanedPhotos(prisma);
  } catch (error) {
    console.warn('orphan sweep failed', error);
    return null;
  }
}

/**
 * Flip Lifelines whose hiker is past their return time. Swallowing failure is safe only because
 * the follow page derives lateness from the expected return time on every read — a failed tick
 * costs a persisted status, not a contact who is never told. That ordering is what makes the
 * feature work on a once-a-day cron.
 */
async function sweepLifelines(): Promise<OverdueSweep | null> {
  try {
    return await sweepOverdueLifelines(prisma);
  } catch (error) {
    console.warn('lifeline sweep failed', error);
    return null;
  }
}

export async function GET(req: Request): Promise<Response> {
  if (!env.CRON_SECRET) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!authorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();
  const [swept, orphans, lifelines] = await Promise.all([
    sweepCredentials(),
    sweepOrphans(),
    sweepLifelines(),
  ]);

  // The one thing about the sweep worth a log line: it ran out of room.
  if (orphans?.truncated) {
    console.warn(
      `orphan sweep: capped at ${orphans.scanned} scanned / ${orphans.deleted} removed; more remain`,
    );
  }

  return Response.json({ swept, orphans, lifelines, durationMs: Date.now() - started });
}
