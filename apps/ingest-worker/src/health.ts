/**
 * Republishes the ingest queue's state into Application Insights, on every reading.
 *
 * `switchback-ingest-tile-split`, `switchback-ingest-subtree-stuck` and a wedged tile are all
 * *rows*, not events, so none of them appears in the telemetry of the invocation that caused it —
 * a handler the host killed writes nothing at all. This process reads those tables from inside the
 * subscription that owns `appi-switchback-ingest`, which is what puts them where a rule can query.
 */

import {
  EMPTY_WRITE_MARKER,
  QUEUE_DISTRESS_MARKER,
  QUEUE_HEALTH_MARKER,
  formatEmptyWriteRate,
  formatQueueHealth,
  isDistressed,
  queueHealth,
  readEmptyWriteRates,
} from '@switchback/ingest';
import type { EmptyWriteRate, QueueHealth } from '@switchback/ingest';
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

/**
 * Republishes what share of each source's tile writes found no trails.
 *
 * Its own reading rather than a `QueueHealth` field: empty tiles are ordinary over ocean, and a
 * count of them inside `isDistressed` would hold that alert on for ever. One line per source, so
 * a rule can compare sources without splitting a single line apart.
 *
 * Reads and fails independently of `reportQueueHealth` for the same reason those two are one
 * function and this is another — a database that cannot answer one of them can answer the other,
 * and losing both to one catch is how a signal goes quiet without anybody deciding it should.
 */
export async function reportEmptyWriteRates(
  db: PrismaClient,
  log: WorkerLog,
): Promise<EmptyWriteRate[] | null> {
  let rates: EmptyWriteRate[];
  try {
    rates = await readEmptyWriteRates(db);
  } catch (error) {
    log.error('ingest health: could not read the empty-write rate', error);
    return null;
  }

  for (const rate of rates) log.info(`${EMPTY_WRITE_MARKER} ${formatEmptyWriteRate(rate)}`);
  return rates;
}
