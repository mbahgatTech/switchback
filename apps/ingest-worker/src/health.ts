/**
 * Republishes the ingest queue's distress into Application Insights.
 *
 * The drainer that actually runs is on Vercel, which has no Application Insights, so
 * `switchback-ingest-tile-split`, `switchback-ingest-subtree-stuck` and a mirror's 429 reach a
 * console nobody is watching and no alert can query. Every one of those conditions leaves a row
 * in `ingest_jobs` or `ingest_tiles`, and this process — the only one inside the subscription
 * that owns `appi-switchback-ingest` — can read them.
 *
 * It runs regardless of `INGEST_QUEUE_DRIVER`, which is the point: `postgres` is exactly the
 * setting under which the drainer is invisible.
 */

import { QUEUE_DISTRESS_MARKER, isDistressed, queueHealth } from '@switchback/ingest';
import type { QueueHealth } from '@switchback/ingest';
import type { PrismaClient } from '@switchback/db';
import type { WorkerLog } from './log';

/** Reads the queue and logs `QUEUE_DISTRESS_MARKER` when anything is wrong. */
export async function reportQueueHealth(
  db: PrismaClient,
  log: WorkerLog,
): Promise<QueueHealth | null> {
  let health: QueueHealth;
  try {
    health = await queueHealth(db);
  } catch (error) {
    // Reporting must not be able to stop the pump it is hung off.
    log.error('ingest health: could not read the queue', error);
    return null;
  }

  if (!isDistressed(health)) return health;

  log.warn(
    `${QUEUE_DISTRESS_MARKER} dead=${health.dead} staleLeases=${health.staleLeases} ` +
      `rateLimited=${health.rateLimited} orphanedSplits=${health.orphanedSplits} ` +
      `stuckSubtrees=${health.stuckSubtrees}`,
  );
  return health;
}
