import { randomUUID } from 'node:crypto';
import { drainIngest, pruneFinishedJobs, sweepQueue } from '@switchback/ingest';
import type { DrainResult, SweepResult as QueueSweep } from '@switchback/ingest';
import { pruneExpiredAuthRequests } from '@switchback/api/mobile-auth';
import { pruneExpiredRefreshTokens } from '@switchback/api/tokens';
import { type OverdueSweep, sweepOverdueLifelines } from '@switchback/api/lifeline';
import { type SweepResult, sweepOrphanedPhotos } from '@switchback/api/orphans';
import { prisma } from '@switchback/db';
import { env } from '@/env';

/**
 * The durability half of the ingest design: a scheduled `drainIngest` — the same one the request
 * path runs — claims jobs whose inline `after()` kick was lost to a deploy, timeout or reclaim.
 *
 * `apps/web/vercel.json` asks for once a day because Hobby *fails the deployment* for any
 * expression that would run more often, so a per-minute schedule cannot ship on this plan. To
 * get the minute hand back: `* * * * *` on Pro, or any external scheduler hitting the same URL
 * with the same bearer token. Locally, `npm run ingest:drain -- --watch`.
 */
export const runtime = 'nodejs';

/**
 * Overpass is rate-limited and every claimed job calls it at least once, so a batch must fit the
 * function's wall clock with room for a retry: four at ~10 s each leaves most of 60 s spare.
 */
const BATCH = 4;

/**
 * Derived jobs claimed alongside, which `BATCH` would never reach: `claimJobs` orders by
 * `priority DESC` and `enrich_trail`/`ingest_route` are enqueued at `-10`, so this is a separate
 * kind-scoped claim. Six fits — an enrichment is a lookup and an image fetch, not an Overpass
 * query. The real drain rate comes from the inline kicks, which rise and fall with traffic.
 */
const DERIVED_BATCH = 6;

/** Vercel's cron scheduler will not wait longer than this, and neither should we. */
export const maxDuration = 60;

/**
 * Reject anyone who is not the scheduler — unauthenticated, this is a way for a stranger to make
 * us hammer Overpass until our IP is blocked. With no `CRON_SECRET` it refuses rather than
 * running open, so a misconfiguration shows as a 503 in the cron log.
 */
function authorized(req: Request): boolean {
  if (!env.CRON_SECRET) return false;
  const header = req.headers.get('authorization');
  return header === `Bearer ${env.CRON_SECRET}`;
}

/**
 * Sweep spent refresh tokens and sign-in requests. Both keep dead rows for a grace window — reuse
 * detection, and `expired` rather than `unknown_request` on a late claim — and past it they are
 * only a record of who signed in from where. Hung off the drain because Hobby allows very few
 * crons; every sweep below does the same, and all swallow failure so ingest cannot be stopped.
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

/**
 * Collect ingest jobs finished long enough ago to be history. Admission control counts this table
 * on the hot path behind `trails.browse`; `@@index([kind, status])` makes that count index-only,
 * and this keeps the index from growing with lifetime job count.
 */
async function sweepFinishedJobs(): Promise<{ done: number; failed: number } | null> {
  try {
    return await pruneFinishedJobs(prisma);
  } catch (error) {
    console.warn('finished-job sweep failed', error);
    return null;
  }
}

/**
 * The drain half of this route, or nothing when the worker owns ingest.
 *
 * On `servicebus` this must not call `drainIngest`: Vercel making Overpass requests alongside the
 * worker is exactly what breaks the two-concurrent guarantee the Function App's scale limit buys.
 * Lease recovery does not ride along with the decision any more — `sweepQueue` runs beside this,
 * on both drivers, and `GET` counts what it did.
 */
async function drainIfOwned(): Promise<DrainResult> {
  if (env.INGEST_QUEUE_DRIVER === 'servicebus') return IDLE_DRAIN;

  return drainIngest({
    limit: BATCH,
    derivedLimit: DERIVED_BATCH,
    // Unique per invocation, because `drainSlotGate` counts drainers by distinct `lockedBy` and
    // the fixed string `cron` would have collided with any other tick still holding work.
    workerId: `cron-${randomUUID().slice(0, 8)}`,
    // Subdivision's only voice. Without it a tile that defers to four children is
    // indistinguishable in the log from one that ingested — see `TILE_SPLIT_MARKER`.
    deps: { logger: (message, detail) => console.warn(message, detail ?? '') },
  });
}

/** What a tick that drained nothing reports. The sweep's counts are reported separately. */
const IDLE_DRAIN: DrainResult = {
  claimed: 0,
  succeeded: 0,
  failed: 0,
  deferred: 0,
  lost: 0,
  derived: 0,
  requeued: 0,
  retired: 0,
};

/**
 * Take back expired leases and clear orphaned split markers, whatever the drain decided.
 *
 * Its own call rather than a step inside the drain: this tick's own claims die with it on the
 * 60 s wall clock, and while reclaim lived inside `drainJobs` the only thing that could take
 * them back was the next drain — the following day.
 */
async function sweepIngestQueue(): Promise<QueueSweep> {
  return sweepQueue(prisma);
}

export async function GET(req: Request): Promise<Response> {
  if (!env.CRON_SECRET) {
    return Response.json({ error: 'CRON_SECRET is not configured' }, { status: 503 });
  }
  if (!authorized(req)) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const started = Date.now();

  // Before the drain, not beside it: both take back expired leases, and the gate does it inside
  // the transaction that decides admission. Serialising them keeps two writers off the same rows
  // and lets the drain see a queue that has already been swept.
  const sweep = await sweepIngestQueue();

  const [result, swept, orphans, lifelines, jobs] = await Promise.all([
    drainIfOwned(),
    sweepCredentials(),
    sweepOrphans(),
    sweepLifelines(),
    sweepFinishedJobs(),
  ]);
  const durationMs = Date.now() - started;

  // Only failures are logged: a successful drain is visible in `ingest_tiles` and on the map, a
  // failed one only here and in `lastError`.
  if (result.failed > 0) {
    console.warn(
      `ingest drain: ${result.failed} of ${result.claimed} jobs failed in ${durationMs}ms`,
    );
  }

  // A deferred job means something is enqueuing work this build cannot run. Once, mid-deploy, is
  // the system working; sustained, it is a build that never rolled.
  if (result.deferred > 0) {
    console.warn(
      `ingest drain: ${result.deferred} job(s) deferred — this build has no handler for them`,
    );
  }

  // A dead worker's jobs, taken back and either requeued or finally buried. Counted across both
  // the standalone sweep and the drain's own, because either may be the one that reached them:
  // `requeued` is how many function invocations died holding work, and a `retired` job is one
  // that has now killed its worker repeatedly and will not be tried again.
  const requeued = sweep.requeued + result.requeued;
  const retired = sweep.retired + result.retired;
  if (requeued > 0 || retired > 0) {
    console.warn(`ingest drain: reclaimed ${requeued} expired lease(s), retired ${retired}`);
  }

  // Parents that claimed a subdivision which produced nothing, put back on the queue. Named one
  // by one: six of these have sat in production since 2026-08-05 with no route out.
  if (sweep.unsplit.length > 0) {
    console.warn(
      `ingest drain: cleared ${sweep.unsplit.length} orphaned split marker(s): ` +
        sweep.unsplit.map((repair) => repair.quadkey).join(', '),
    );
  }

  // The tuning signal for `LEASE_TIMEOUT_MS`: a lost lease is a worker that finished after its
  // job had been given away, so the work was done twice and the lease is too short.
  if (result.lost > 0) {
    console.warn(
      `ingest drain: ${result.lost} job(s) finished after their lease expired — raise LEASE_TIMEOUT_MS`,
    );
  }

  // The one thing about the sweep worth a log line: it ran out of room.
  if (orphans?.truncated) {
    console.warn(
      `orphan sweep: capped at ${orphans.scanned} scanned / ${orphans.deleted} removed; more remain`,
    );
  }

  return Response.json({ ...result, sweep, swept, orphans, lifelines, jobs, durationMs });
}
