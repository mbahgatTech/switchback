/**
 * The job-kind → handler map, in one place.
 *
 * Every caller of the queue uses this: the cron route drains with it, the tRPC router's
 * `waitUntil` kick drains with it, and so does the CLI. Keeping the mapping here rather
 * than in the routes is what makes those paths provably the same code — the immediate path
 * is an optimisation over the durable one, never a divergent implementation of it. A job
 * the request path finishes is one the cron then finds already done, because both went
 * through the same claim.
 */

import { JobKind } from '@switchback/db';
import { drainJobs } from './jobs';
import type { ClaimedJob, DrainResult, JobHandler } from './jobs';
import { processNetworkTile } from './network';
import { enrichTrailPhotos, processRoute, processTile } from './pipeline';
import type { PipelineDeps } from './pipeline';
import { pipelineDeps } from './config';

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`job payload missing "${key}"`);
  }
  return value;
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`job payload missing "${key}"`);
  }
  return value;
}

export function ingestHandlers(deps?: Partial<PipelineDeps>): Partial<Record<JobKind, JobHandler>> {
  const resolved = pipelineDeps(deps);
  return {
    [JobKind.ingest_tile]: async (job: ClaimedJob) => {
      await processTile(requireString(job.payload, 'quadkey'), resolved);
    },
    [JobKind.refresh_tile]: async (job: ClaimedJob) => {
      await processTile(requireString(job.payload, 'quadkey'), resolved);
    },
    [JobKind.ingest_route]: async (job: ClaimedJob) => {
      await processRoute(requireNumber(job.payload, 'osmId'), resolved);
    },
    [JobKind.enrich_trail]: async (job: ClaimedJob) => {
      await enrichTrailPhotos(requireString(job.payload, 'trailId'), resolved);
    },
    [JobKind.ingest_network]: async (job: ClaimedJob) => {
      await processNetworkTile(requireString(job.payload, 'quadkey'), resolved);
    },
  };
}

/**
 * How many derived jobs a drain claims on top of its batch, unless told otherwise.
 *
 * Two, and the number is chosen against the two places this runs rather than against the
 * backlog. A cron tick has a 60 s budget mostly spent on tile fetches; an inline kick is
 * `waitUntil` work hanging off a map request, where the cost is a background function
 * holding a connection a little longer. `enrichTrailPhotos` is the cheap end of the job
 * table — a lookup and an image fetch, not an Overpass query — so two of them fit in the
 * slack of either caller.
 *
 * It is a rate, not a target: two per drain times every viewport that finds new ground is
 * what makes the backlog fall with traffic, which is the same thing it rises with. The
 * alternative — one big periodic sweep — needs a scheduler this deploy does not have.
 */
export const DEFAULT_DERIVED_SHARE = 2;

/**
 * Drain a batch of ingest work. This is the cron route's entire body.
 *
 * `limit` is small on purpose. A Vercel cron invocation has a wall-clock budget and a tile
 * can take a minute; claiming twenty would mean nineteen locks expiring unhelpfully. Four
 * per minute, with the immediate `waitUntil` path handling anything a user is watching, is
 * the right shape.
 *
 * `derivedLimit` is separate from `limit` and defaults to a share rather than to zero,
 * because derived work is enqueued below every requestable kind and `claimJobs` orders by
 * priority — a batch that does not reserve room for it never runs any. See `drainJobs`.
 */
export async function drainIngest(
  options: {
    limit?: number;
    workerId?: string;
    deps?: Partial<PipelineDeps>;
    /** Claim only these units of work — see `claimJobs`. */
    dedupeKeys?: readonly string[];
    /** Derived jobs to claim alongside — see `drainJobs`. Pass 0 to take none. */
    derivedLimit?: number;
  } = {},
): Promise<DrainResult> {
  return drainJobs(ingestHandlers(options.deps), {
    limit: options.limit ?? 4,
    workerId: options.workerId,
    derivedLimit: options.derivedLimit ?? DEFAULT_DERIVED_SHARE,
    ...(options.dedupeKeys ? { dedupeKeys: options.dedupeKeys } : {}),
  });
}
