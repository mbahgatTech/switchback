/**
 * The dead-letter queue's way back. A message lands there when the worker could not reach Postgres
 * across `maxDeliveryCount` deliveries — see `runIngestSignal` — and nothing else empties it.
 */

import { JobStatus } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { namedKeys } from '@switchback/ingest';
import type { WorkerLog } from './log';

/** One message off the dead-letter sub-queue, with the broker's settlement bound to it. */
export interface DeadLetter {
  /** The `ingest_jobs` row it names, or null when the body is not a signal this estate wrote. */
  dedupeKey: string | null;
  /** The broker's own reason, which appears nowhere else. */
  reason: string | null;
  /** Delete it from the dead-letter queue. */
  complete(): Promise<void>;
}

/** The broker behind an interface, so the reconciler below needs no Service Bus namespace. */
export interface DeadLetterQueue {
  /** Take up to `max` messages, locked rather than deleted. */
  receive(max: number): Promise<DeadLetter[]>;
}

/**
 * The literal an operator greps for, and deliberately the name of the metric alert
 * `infra/azure/ingest.bicep` raises on dead-letter depth: the alert says a message was there, and
 * this line is the only place that says which job it named and what became of it.
 */
export const DEAD_LETTER_MARKER = 'switchback-ingest-deadletter';

/** Messages one tick evaluates. The queue is empty in the ordinary case; this bounds the bad one. */
export const DEAD_LETTER_BATCH = 32;

/** What one pass found, keyed by what it means for the work rather than by what the broker said. */
export interface DeadLetterReport {
  /** Rows still `queued` or `running`: the pump will republish them, so the message was spare. */
  runnable: string[];
  /** Rows finished, buried, or collected. Nothing is owed to these messages. */
  terminal: string[];
  /**
   * Messages carrying no readable `dedupeKey` in either the body or the broker's `messageId`, each
   * named by the broker's dead-letter reason — the only thing left to identify them by.
   */
  unreadable: string[];
}

/**
 * Evaluate every dead-lettered message against its durable row, say what was found, and empty the
 * queue.
 *
 * **Dropping the message loses nothing, and that is what makes this safe rather than lossy.** A
 * message is a wake-up signal holding no state; `ingest_jobs` holds the work, and `runPump`
 * re-derives the runnable head from it every two minutes. Republishing from here instead would put
 * a second publisher in front of the queue with none of the pump's ordering, and would hand a
 * poison message a way back in on every tick.
 *
 * **The alert is the other half.** `switchback-ingest-deadletter` reads depth over a fifteen-minute
 * window, so a message still fires it before this tick reaches it — what changes is that the alert
 * now clears by itself instead of staying open until somebody drains the queue by hand.
 *
 * A database that cannot be read settles nothing: the messages stay locked, the lock lapses, and
 * the next tick tries again. Deleting a message this could not evaluate would be the one way to
 * actually lose work here.
 */
export async function reconcileDeadLetters(
  db: PrismaClient,
  queue: DeadLetterQueue,
  log: WorkerLog,
  max: number = DEAD_LETTER_BATCH,
): Promise<DeadLetterReport> {
  const report: DeadLetterReport = { runnable: [], terminal: [], unreadable: [] };

  const messages = await queue.receive(max);
  if (messages.length === 0) return report;

  const keys = messages
    .map((message) => message.dedupeKey)
    .filter((key): key is string => key !== null);

  const rows =
    keys.length === 0
      ? []
      : await db.ingestJob.findMany({
          where: { dedupeKey: { in: keys } },
          select: { dedupeKey: true, status: true },
        });
  const status = new Map(rows.map((row) => [row.dedupeKey, row.status]));

  for (const message of messages) {
    if (message.dedupeKey === null) {
      report.unreadable.push(message.reason ?? 'no reason given');
      continue;
    }
    const found = status.get(message.dedupeKey);
    const runnable = found === JobStatus.queued || found === JobStatus.running;
    (runnable ? report.runnable : report.terminal).push(message.dedupeKey);
  }

  // Logged before anything is settled: a process that dies here leaves the messages locked and the
  // next tick reports them again, which costs a duplicate line rather than the record of a fault.
  // "found", not "drained", for the same reason — nothing has been completed yet when this runs.
  log.warn(`${DEAD_LETTER_MARKER} ${describe(report)}`);

  for (const message of messages) await message.complete();
  return report;
}

/** The counts, then the keys, so a reader sees the shape of the batch before its contents. */
function describe(report: DeadLetterReport): string {
  const named = [...report.runnable, ...report.terminal, ...report.unreadable];

  return (
    `found ${named.length} dead-lettered message(s): runnable=${report.runnable.length} ` +
    `terminal=${report.terminal.length} unreadable=${report.unreadable.length}` +
    (named.length === 0 ? '' : ` — ${namedKeys(named)}`)
  );
}
