/**
 * The bound on how many processes make Overpass requests at once, enforced where it has to be —
 * across processes, in the database.
 *
 * `OVERPASS_MAX_CONCURRENT` bounds one `OverpassClient`, and `config.ts` makes that a per-process
 * singleton. On the Function App that is the whole fleet, because `functionAppScaleLimit=1` and
 * `FUNCTIONS_WORKER_PROCESS_COUNT=1` mean there is one process. On Vercel it is one *lambda*: the
 * platform starts as many as the traffic asks for, each with its own singleton, so the setting
 * bounded a fraction of the drainer and nothing bounded the drainer. Overpass allots slots per
 * client IP and every Vercel instance shares one egress IP, so the fleet was one client with no
 * ceiling — the failure mode being an IP block, which takes the product down.
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
 * Expired leases are reclaimed inside the lock, before the count. A drainer that died still holds
 * `running` rows and would otherwise hold the slot shut until something else swept — which, on
 * Vercel's 60 s wall clock, is most drains. That makes the worst-case block `LEASE_TIMEOUT_MS`
 * rather than a day, and it is the reason `sweepQueue` exists as well.
 *
 * Drainers are counted by `count(distinct "lockedBy")`, so **every caller must pass a `workerId`
 * unique to its process.** A fleet sharing the string `inline` counts as one drainer however many
 * lambdas are running, which is the bug this replaces wearing a lock. The three application
 * entry points — `trails.ts`, `routes.ts` and the cron route — derive theirs from `randomUUID`;
 * `drainJobs` falls back to a timestamp, which is unique enough for the same reason.
 */
export function drainSlotGate(db: PrismaClient = prisma, limit = maxDrainers()): ClaimGate {
  return (claim) =>
    db.$transaction(async (tx) => {
      await tx.$executeRaw`select pg_advisory_xact_lock(${DRAIN_ADMISSION_KEY})`;

      try {
        await reclaimExpiredJobs(tx);
      } catch (error) {
        // A failed sweep makes the count pessimistic, never optimistic: it can only leave dead
        // drainers counted, which refuses admission. Safe to carry on.
        console.warn('[ingest] lease sweep inside the drain gate failed', error);
      }

      const [counted] = await tx.$queryRaw<Array<{ drainers: number }>>`
        select count(distinct "lockedBy")::int as drainers from ingest_jobs where status = 'running'
      `;
      if ((counted?.drainers ?? 0) >= limit) return EMPTY_BATCH;

      return claim(tx);
    });
}

const EMPTY_BATCH: ClaimedBatch = { primary: [], derived: [] };
