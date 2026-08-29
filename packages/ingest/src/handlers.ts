/**
 * The job-kind to handler map. Both callers of the queue use this — the Function App's queue
 * trigger and the CLI — so the two cannot drift into divergent implementations of the pipeline.
 */

import { JobKind } from '@switchback/db';
import { backgroundPrisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { drainSlotGate } from './drain-slot';
import { PAYLOAD_INCOMPLETE, drainJobs } from './jobs';
import type { ClaimGate, ClaimedJob, DrainResult, JobHandler } from './jobs';
import { processNetworkTile } from './network';
import { enrichTrailPhotos, processRoute, processTile } from './pipeline';
import type { PipelineDeps } from './pipeline';
import { pipelineDeps } from './config';

function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${PAYLOAD_INCOMPLETE} "${key}"`);
  }
  return value;
}

function requireNumber(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${PAYLOAD_INCOMPLETE} "${key}"`);
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
 * How many derived jobs a drain claims on top of its batch. Sized against the handler that runs
 * them: one invocation's budget has slack for two `enrichTrailPhotos` calls, which are a lookup
 * and an image fetch. It is a rate, not a target — two per drain times every viewport that finds
 * new ground is what makes the backlog fall with the traffic it rises with.
 */
export const DEFAULT_DERIVED_SHARE = 2;

/**
 * Drain a batch of ingest work.
 *
 * `limit` is small on purpose: an invocation has a wall-clock budget and a tile can take minutes,
 * so claiming twenty would mean nineteen leases expiring unhelpfully. `derivedLimit` defaults to a
 * share rather than zero because derived work sits below every requestable kind and a batch that
 * reserves no room for it never runs any. See `drainJobs`.
 *
 * **The Overpass bound is the default, not the call site's to remember.** Every handler above can
 * reach `OverpassClient` and `OVERPASS_MAX_CONCURRENT` bounds only one process, so an omitted
 * `gate` would mean "unbounded against one egress IP" the moment two processes overlap. Opting out
 * is an argument a reader can see and a reviewer can question.
 */
export async function drainIngest(
  options: {
    /** The client the gate and the claim share. Defaults to the ingest pool. */
    db?: PrismaClient;
    limit?: number;
    workerId?: string;
    deps?: Partial<PipelineDeps>;
    /** Claim only these units of work — see `claimJobs`. */
    dedupeKeys?: readonly string[];
    /** Derived jobs to claim alongside — see `drainJobs`. Pass 0 to take none. */
    derivedLimit?: number;
    /**
     * Bounds how many processes drain at once — see `drainSlotGate`. Omitted is that bound over
     * `db`; `null` opts out, and only a caller whose own process is the whole fleet may.
     */
    gate?: ClaimGate | null;
  } = {},
): Promise<DrainResult> {
  const db = options.db ?? backgroundPrisma;
  const gate = options.gate === undefined ? drainSlotGate(db) : options.gate;

  return drainJobs(ingestHandlers(options.deps), {
    db,
    limit: options.limit ?? 4,
    workerId: options.workerId,
    derivedLimit: options.derivedLimit ?? DEFAULT_DERIVED_SHARE,
    ...(options.dedupeKeys ? { dedupeKeys: options.dedupeKeys } : {}),
    ...(gate ? { gate } : {}),
  });
}
