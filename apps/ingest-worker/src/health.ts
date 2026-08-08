/**
 * Republishes the ingest queue's state into Application Insights, on every reading.
 *
 * `switchback-ingest-tile-split`, `switchback-ingest-subtree-stuck` and a wedged tile are all
 * *rows*, not events, so none of them appears in the telemetry of the invocation that caused it —
 * a handler the host killed writes nothing at all. This process reads those tables from inside the
 * subscription that owns `appi-switchback-ingest`, which is what puts them where a rule can query.
 */

import {
  QUEUE_DISTRESS_MARKER,
  QUEUE_HEALTH_MARKER,
  formatQueueHealth,
  isDistressed,
  queueHealth,
} from '@switchback/ingest';
import type { QueueHealth } from '@switchback/ingest';
import type { PrismaClient } from '@switchback/db';
import { BUILD_COMMIT } from './build';
import type { WorkerLog } from './log';

/**
 * Reads the queue, logs `QUEUE_HEALTH_MARKER` every time and `QUEUE_DISTRESS_MARKER` as well
 * when anything is wrong.
 *
 * The heartbeat is unconditional so that its absence means something, and it carries the commit
 * the bundle was built from so that its *presence* means one particular package is mounted. A
 * read failure is the one case that emits neither, which is correct: this process cannot report
 * a queue it cannot see, and `switchback-ingest-worker-silent` is the rule that notices.
 */
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

  const counts = formatQueueHealth(health);
  log.info(`${QUEUE_HEALTH_MARKER} build=${BUILD_COMMIT} ${counts}`);
  if (isDistressed(health)) log.warn(`${QUEUE_DISTRESS_MARKER} ${counts}`);
  return health;
}
