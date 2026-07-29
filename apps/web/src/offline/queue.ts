/**
 * Reports written where there was nothing to send them to.
 *
 * This is the case the whole offline feature exists for. Somebody is on a ridge with a
 * downloaded page open and no bars, they have just hiked the thing, and they know the ford
 * is out. Without a queue the form posts, fails, shows an error, and the single piece of
 * information on that page which no map and no model could have produced is gone by the time
 * they reach the car.
 *
 * Kept in its own store rather than folded into the downloads ledger, because the two have
 * opposite lifetimes. A download is a possession — it stays until the hiker removes it. A
 * queued report is a debt: it should leave at the first opportunity, and a row still sitting
 * here tomorrow is something to tell them about rather than something they own.
 *
 * **Nothing is ever silently dropped.** A report the server refuses is kept and marked, not
 * discarded and not retried forever; a report that could not be sent is retried on the next
 * reconnection. The one outcome this module will not produce is a hiker's words vanishing
 * with nobody told.
 */

import type { ReviewWrite } from '@switchback/core';
import { PENDING_REVIEWS_STORE, run } from './idb';

export interface PendingReview {
  /** The key. One report per trail, matching the constraint the server enforces. */
  trailId: string;
  /** Enough to name the trail and link back to it with no server to ask. */
  trailName: string;
  trailPath: string;
  /**
   * The mutation's own input, kept whole.
   *
   * Stored as the payload rather than as fields to reassemble later, so that sending it is a
   * replay of exactly what the form sent and not a second implementation of the form that can
   * drift away from the first.
   */
  write: ReviewWrite;
  /** When it was written, not when it will be sent. Epoch ms, so the row clones cleanly. */
  queuedAt: number;
  /** How many times sending has been attempted. Drives what the queue says, not what it keeps. */
  attempts: number;
  /** What went wrong last time, in the server's own words, or null if nothing has yet. */
  lastError: string | null;
  /**
   * Set when the server refused the report rather than failing to receive it.
   *
   * Automatic flushes skip these. A report the server has already rejected — an expired
   * session, a trail since merged away — will be rejected identically on every reconnection,
   * and a row that retries forever is not resilience, it is a promise that renews itself
   * without ever being kept. Only a person pressing the button retries a blocked row.
   */
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Everyone watching the queue, so a flush in one component redraws another.
 *
 * A module-level set rather than a React context: the queue is written from a form, drained
 * by a component mounted in the layout, and read by the storage manager, and threading a
 * provider between those three would be more wiring than the two lines it replaces.
 */
const listeners = new Set<() => void>();

export function subscribeToQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

export function listPendingReviews(): Promise<PendingReview[]> {
  return run<PendingReview[]>(
    PENDING_REVIEWS_STORE,
    'readonly',
    (store) => store.getAll() as IDBRequest<PendingReview[]>,
    // Oldest first: it is the order they were written in, and the order they should leave in.
  ).then((rows) => rows.sort((a, b) => a.queuedAt - b.queuedAt));
}

export function getPendingReview(trailId: string): Promise<PendingReview | null> {
  return run<PendingReview | undefined>(
    PENDING_REVIEWS_STORE,
    'readonly',
    (store) => store.get(trailId) as IDBRequest<PendingReview | undefined>,
  ).then((row) => row ?? null);
}

export function putPendingReview(row: PendingReview): Promise<void> {
  return run(PENDING_REVIEWS_STORE, 'readwrite', (store) => store.put(row)).then(() => {
    announce();
  });
}

export function deletePendingReview(trailId: string): Promise<void> {
  return run(PENDING_REVIEWS_STORE, 'readwrite', (store) => store.delete(trailId)).then(() => {
    announce();
  });
}

/** A fresh row, for the moment a report is written and cannot be sent. */
export function pendingReview(fields: {
  trailId: string;
  trailName: string;
  trailPath: string;
  write: ReviewWrite;
  at: number;
}): PendingReview {
  return {
    trailId: fields.trailId,
    trailName: fields.trailName,
    trailPath: fields.trailPath,
    write: fields.write,
    queuedAt: fields.at,
    attempts: 0,
    lastError: null,
    blocked: false,
  };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Did the request fail to arrive, or did the server refuse it?
 *
 * Only the first is worth queueing and only the first is worth retrying. tRPC fills `data`
 * from the server's own error envelope, so a client error carrying no `data` is one where
 * nothing came back at all: airplane mode, a dead cell, a captive portal that never finished
 * its handshake. A bare `TypeError` is the same thing one layer down — that is what `fetch`
 * itself throws when the connection cannot be made.
 *
 * Written as a shape test rather than `instanceof TRPCClientError` on purpose. This has to
 * hold for an error that crossed a module boundary, and class identity in a workspace with
 * more than one copy of a package on disk is not something to bet a hiker's report on.
 */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return 'data' in error && error.data == null;
}

/** What a message says when the error has none worth showing. */
const UNSAID = 'The server would not take it.';

function reason(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return UNSAID;
}

export interface FlushResult {
  sent: number;
  /** Still queued afterwards, for whatever reason. */
  kept: number;
}

export interface FlushOptions {
  /** Limit the run to one trail's report — what the "Post it now" button does. */
  trailId?: string;
  /** Include rows the server has already refused. Only ever set by a person retrying. */
  force?: boolean;
}

/**
 * Send what is queued, one at a time.
 *
 * Sequential rather than concurrent, for the same reason the recorder uploads its fixes in
 * batches: coming back into signal after a long day is exactly the moment when firing every
 * outstanding write at once is most likely to fail, and the connection that just returned is
 * usually one bar rather than five.
 *
 * `post` is injected rather than imported so this stays a plain function over a queue — the
 * caller supplies the tRPC client, and the logic that decides what to keep can be tested
 * without one.
 */
export async function flushPendingReviews(
  post: (write: ReviewWrite) => Promise<unknown>,
  options: FlushOptions = {},
): Promise<FlushResult> {
  const all = await listPendingReviews();
  const queue = all.filter(
    (row) =>
      (options.trailId === undefined || row.trailId === options.trailId) &&
      (options.force === true || !row.blocked),
  );

  let sent = 0;
  for (const row of queue) {
    try {
      await post(row.write);
      await deletePendingReview(row.trailId);
      sent += 1;
    } catch (error) {
      const unreachable = isUnreachable(error);
      await putPendingReview({
        ...row,
        attempts: row.attempts + 1,
        // An unreachable server is not something to report as a fault with the report.
        lastError: unreachable ? null : reason(error),
        blocked: !unreachable,
      });
      // Still no signal. Everything after this would fail the same way, and each failure is
      // a request the hiker's battery pays for.
      if (unreachable) break;
    }
  }

  return { sent, kept: (await listPendingReviews()).length };
}
