/**
 * The bound on how many processes make Overpass requests at once, enforced where it has to be —
 * across processes, in the database.
 *
 * `OVERPASS_MAX_CONCURRENT` bounds one `OverpassClient`, and `config.ts` makes that a per-process
 * singleton, so a platform argument about process count is the only thing that could turn it into
 * a fleet bound. `functionAppScaleLimit=1` and `FUNCTIONS_WORKER_PROCESS_COUNT=1` come close, but
 * they hold only while exactly one host is running: across a recycle two overlap, each with its
 * own singleton, and several processes each honouring "two concurrent" locally is not two
 * concurrent. Overpass allots slots per client IP and the whole estate shares one egress IP, so
 * the failure mode is an IP block, which takes the product down.
 */

import { prisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { reclaimExpiredJobs } from './jobs';
import type { ClaimGate, ClaimedBatch } from './jobs';

/**
 * Advisory-lock key for the admission decision. Arbitrary but fixed; it names this decision and
 * nothing else, and `pg_advisory_xact_lock` releases it when the transaction ends whatever
 * happens to the process holding it.
 *
 * Exported because `unsplitTile` takes the same lock: every claim of a tile job happens under it,
 * so holding it is the only way to be sure no descendant job starts between reading that none is
 * running and deleting the subtree.
 */
export const DRAIN_ADMISSION_KEY = 4_155_923_017n;

/**
 * Processes that may hold Overpass-making work at once, when `INGEST_MAX_DRAINERS` does not say
 * otherwise. One, so the fleet's Overpass concurrency is `1 × OVERPASS_MAX_CONCURRENT` — the two
 * the public instances document, and the number every doc in this repository now states.
 *
 * Raising it multiplies: two drainers at `OVERPASS_MAX_CONCURRENT: 2` is four in flight against
 * one IP.
 */
export const INGEST_MAX_DRAINERS = 1;

/** `INGEST_MAX_DRAINERS` from the environment; an absent, blank or non-positive value is 1. */
export function maxDrainers(source: NodeJS.ProcessEnv = process.env): number {
  const value = Number(source.INGEST_MAX_DRAINERS);
  return Number.isInteger(value) && value > 0 ? value : INGEST_MAX_DRAINERS;
}

/**
 * Admit this process to drain only if fewer than `limit` others already are, and claim under the
 * same lock.
 *
 * The check and the claim are one transaction because they cannot be two. Under `READ COMMITTED`
 * a process that counted drainers, found none, and then claimed would be racing every other
 * process doing the same: both read the pre-claim state, both claim, and the bound is a comment.
 * `pg_advisory_xact_lock` serialises the pair; the count that follows it takes a fresh snapshot,
 * so it sees the rows the previous holder committed.
 *
 * Expired leases are reclaimed *before* the transaction opens, not inside it. A drainer that died
 * still holds `running` rows and would otherwise hold the slot shut until something else swept, so
 * sweeping here makes the worst-case block `LEASE_TIMEOUT_MS` rather than indefinite. Outside the
 * transaction because a statement that errors inside one aborts it (`25P02`): catching the sweep in
 * place would leave every statement after it failing anyway, so the gate would die on a failed
 * sweep rather than carry on. Committing the reclaim first also means the count below sees its
 * effect, which is the only reason it runs here at all. `sweepQueue` on the pump's two-minute tick
 * is the other half, and it runs whether or not anything drains.
 *
 * A sweep that fails leaves the count pessimistic, never optimistic — dead drainers stay counted,
 * which refuses admission — and leaves `classifyDisposition` a `running` row past its lease to
 * report as `stranded`. That is the reachability `switchback-ingest-signal-stranded` depends on.
 *
 * Drainers are counted by `count(distinct "lockedBy")`, so **every caller must pass a `workerId`
 * unique to its process.** A fleet sharing one string counts as one drainer however many processes
 * are running, which is the bug this replaces wearing a lock. `runIngestSignal` derives its from
 * the host's `invocationId`; `drainJobs` falls back to a timestamp, which is unique enough for the
 * same reason.
 */
export function drainSlotGate(db: PrismaClient = prisma, limit = maxDrainers()): ClaimGate {
  return async (claim) => {
    try {
      await reclaimExpiredJobs(db);
    } catch (error) {
      console.warn('[ingest] lease sweep ahead of the drain gate failed', error);
    }

    return db.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(${DRAIN_ADMISSION_KEY})`;

      const [counted] = await tx.$queryRaw<Array<{ drainers: number }>>`
        select count(distinct "lockedBy")::int as drainers from ingest_jobs where status = 'running'
      `;
      if ((counted?.drainers ?? 0) >= limit) return EMPTY_BATCH;

      return claim(tx);
    });
  };
}

const EMPTY_BATCH: ClaimedBatch = { primary: [], derived: [] };
