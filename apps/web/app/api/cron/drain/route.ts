import { drainIngest, pruneFinishedJobs } from '@switchback/ingest';
import { pruneExpiredAuthRequests } from '@switchback/api/mobile-auth';
import { pruneExpiredRefreshTokens } from '@switchback/api/tokens';
import { type OverdueSweep, sweepOverdueLifelines } from '@switchback/api/lifeline';
import { type SweepResult, sweepOrphanedPhotos } from '@switchback/api/orphans';
import { prisma } from '@switchback/db';
import { env } from '@/env';

/**
 * The durability half of the ingest design.
 *
 * A viewport request kicks its own tiles off with `after`, which is fast and usually
 * enough. What it cannot survive is a deploy mid-flight, a function timeout, or a serverless
 * instance being reclaimed the moment the response is flushed. This route is what makes
 * those recoverable: jobs live in Postgres with a visibility timeout, and a scheduled drain
 * claims whatever has been sitting unclaimed for too long.
 *
 * It runs the same `drainIngest` the request path runs. There is no second code path to
 * keep in step, and no class of job that only one of them knows how to handle.
 *
 * **Schedule.** `apps/web/vercel.json` asks for once a day, and the reason is a deploy-time
 * check rather than a preference. Hobby rejects any expression that would run more than
 * daily — not by quietly slowing it down, but by failing the deployment outright — so the
 * per-minute schedule this route was written for is not a plan we can ship on the plan this
 * project targets. A cron that reads well and refuses to deploy is worth less than a daily
 * one that runs.
 *
 * What that costs is smaller than it looks, because the request-path `after()` kick already
 * does essentially all the work; this is the backstop for what the kick drops, and a job it
 * drops is one nobody is currently waiting on. Two ways to get the minute-hand back: change
 * this one field to `* * * * *` on Vercel Pro, or point any external scheduler at the same
 * URL with the same bearer token, which is free. Locally there is no scheduler at all, so
 * use `npm run ingest:drain -- --watch`.
 */
export const runtime = 'nodejs';

/**
 * Overpass is rate-limited and every claimed job makes at least one call to it, so a batch
 * has to fit comfortably inside the function's wall clock with room for a retry. Four jobs
 * at roughly ten seconds each leaves most of a 60 s budget spare; the next tick takes the
 * next four.
 */
const BATCH = 4;

/** Vercel's cron scheduler will not wait longer than this, and neither should we. */
export const maxDuration = 60;

/**
 * Reject anyone who is not the scheduler.
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` on every cron invocation. Without the
 * check this endpoint is an unauthenticated way for a stranger to make us hammer Overpass —
 * which would get our IP blocked and take trail ingest down for everyone.
 *
 * With no `CRON_SECRET` set the route refuses rather than running open. That is deliberate:
 * an unset secret in production is a misconfiguration, and failing closed makes it visible
 * as a 503 in the cron log instead of silently inviting abuse. Locally you can still drain
 * by hand with `npm run ingest:drain`.
 */
function authorized(req: Request): boolean {
  if (!env.CRON_SECRET) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${env.CRON_SECRET}`;
}

/**
 * Sweep spent credentials while we are already awake.
 *
 * Two tables accumulate rows that are dead but not deleted: refresh tokens keep a revoked
 * row for a grace period so reuse detection has something to match against, and sign-in
 * requests keep an expired row for an hour so a late claim gets `expired` rather than
 * `unknown_request`. Past those windows the rows are only a growing record of who signed in
 * from where, which is not something to keep by accident.
 *
 * Hung off the drain rather than given its own cron because Vercel's Hobby plan allows very
 * few of them, and a sweep that runs whenever the ingest runs is close enough — neither
 * window is measured in minutes. Failures are logged and swallowed: an uncollected row is a
 * tidiness problem, and it must not stop trail ingest.
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
 * Collect photograph bytes that no row points at.
 *
 * The upload flow writes the object before the row on purpose — `packages/api/orphans.ts`
 * argues why — which means an upload abandoned between those two steps leaves bytes we pay
 * for and cannot see. This is what collects them.
 *
 * It runs on every tick rather than on a schedule of its own for the same reason the
 * credential sweep does: Vercel's Hobby plan allows very few crons, and a sweep that happens
 * whenever the ingest happens is close enough for something with a 24-hour grace period. The
 * cost is one bucket listing, which is a rounding error against the Overpass calls the same
 * request is making.
 *
 * Swallowed on failure, like the credential sweep, and for a stronger reason: a bucket that
 * refuses a LIST must not be able to stop trail ingest.
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
 * Flip Lifelines whose hiker is past their return time.
 *
 * The only sweep here that is about a person rather than about tidiness, which changes what
 * "swallowed on failure" has to mean. It is still swallowed — a failed update must not stop
 * trail ingest — but the follow page does not depend on this having run: it derives lateness
 * from the expected return time on every read. So a tick that fails costs a persisted status
 * and a log line, not a contact who is never told.
 *
 * On Vercel Hobby, where crons run once a day, that ordering is not a nicety. It is the
 * reason the feature works at all on the plan this is deployed to.
 */
async function sweepLifelines(): Promise<OverdueSweep | null> {
  try {
    return await sweepOverdueLifelines(prisma);
  } catch (error) {
    console.warn('lifeline sweep failed', error);
    return null;
  }
}

/**
 * Collect ingest jobs that finished long enough ago to be history.
 *
 * `ingest_jobs` had no prune at all, and it is not a table that can go without one: admission
 * control counts it on the hot path behind `trails.browse`, so every row ever recorded was
 * work done on every viewport that found new ground. The `@@index([kind, status])` makes that
 * count index-only; this keeps the index from growing with lifetime job count.
 *
 * Hung off the drain for the same reason the other sweeps are — Hobby allows very few crons,
 * and rows a week past their completion are in no hurry. Swallowed on failure: an uncollected
 * row is a tidiness problem and must not stop trail ingest.
 */
async function sweepFinishedJobs(): Promise<{ done: number; failed: number } | null> {
  try {
    return await pruneFinishedJobs(prisma);
  } catch (error) {
    console.warn('finished-job sweep failed', error);
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
  const [result, swept, orphans, lifelines, jobs] = await Promise.all([
    drainIngest({ limit: BATCH, workerId: 'cron' }),
    sweepCredentials(),
    sweepOrphans(),
    sweepLifelines(),
    sweepFinishedJobs(),
  ]);
  const durationMs = Date.now() - started;

  // Only failures are logged. A successful drain is visible in `ingest_tiles` and, more to
  // the point, on the map; a failed one is invisible everywhere except here and the
  // `lastError` column, and it is the thing you go looking for when the map stops filling.
  if (result.failed > 0) {
    console.warn(
      `ingest drain: ${result.failed} of ${result.claimed} jobs failed in ${durationMs}ms`,
    );
  }

  // A deferred job is not a failure and is not retried into oblivion, which is exactly why
  // it needs saying out loud: it means something is enqueuing work this build cannot run.
  // Once, mid-deploy, that is the system working. Every minute for an hour is a build that
  // never rolled, and the only place it shows is a queue that quietly stops draining.
  if (result.deferred > 0) {
    console.warn(
      `ingest drain: ${result.deferred} job(s) deferred — this build has no handler for them`,
    );
  }

  // The one thing about the sweep worth a line in the log: it ran out of room. Everything
  // else about it is in the response body for whoever asked.
  if (orphans?.truncated) {
    console.warn(
      `orphan sweep: capped at ${orphans.scanned} scanned / ${orphans.deleted} removed; more remain`,
    );
  }

  return Response.json({ ...result, swept, orphans, lifelines, jobs, durationMs });
}
