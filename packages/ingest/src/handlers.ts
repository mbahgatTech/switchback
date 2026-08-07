/**
 * The job-kind to handler map. Every caller of the queue uses this — the cron route, the tRPC
 * router's `waitUntil` kick, the CLI — so the immediate path is provably an optimisation over
 * the durable one rather than a divergent implementation of it.
 */

import { JobKind } from '@switchback/db';
import { drainJobs } from './jobs';
import type { ClaimGate, ClaimedJob, DrainResult, JobHandler } from './jobs';
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
 * How many derived jobs a drain claims on top of its batch. Sized against the two callers
 * rather than the backlog: a cron tick's 60 s budget and a `waitUntil` kick hanging off a map
 * request both have slack for two `enrichTrailPhotos` calls, which are a lookup and an image
 * fetch. It is a rate, not a target — two per drain times every viewport that finds new ground
 * is what makes the backlog fall with the traffic it rises with.
 */
export const DEFAULT_DERIVED_SHARE = 2;

/**
 * Drain a batch of ingest work. This is the cron route's entire body.
 *
 * `limit` is small on purpose: a Vercel cron invocation has a wall-clock budget and a tile can
 * take a minute, so claiming twenty would mean nineteen locks expiring unhelpfully.
 * `derivedLimit` defaults to a share rather than zero because derived work sits below every
 * requestable kind and a batch that reserves no room for it never runs any. See `drainJobs`.
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
    /** Bounds how many processes drain at once — see `drainSlotGate`. */
    gate?: ClaimGate;
  } = {},
): Promise<DrainResult> {
  return drainJobs(ingestHandlers(options.deps), {
    limit: options.limit ?? 4,
    workerId: options.workerId,
    derivedLimit: options.derivedLimit ?? DEFAULT_DERIVED_SHARE,
    ...(options.dedupeKeys ? { dedupeKeys: options.dedupeKeys } : {}),
    ...(options.gate ? { gate: options.gate } : {}),
  });
}
