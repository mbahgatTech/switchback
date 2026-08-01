/**
 * The queue of trail reports written with no connection. Nothing is silently dropped, and nothing
 * is sent under the wrong name: every row carries its author, and only that reader's rows drain.
 */

import type { ReviewWrite } from '@switchback/core';
import { ownedBy, stillActingAs } from './identity';
import { PENDING_REVIEWS_STORE, reviewKey, run } from './idb';

export { reviewKey };

export interface PendingReview {
  /** The key: `reviewKey(userId, trailId)`. One report per person per trail, as in Postgres. */
  key: string;
  /**
   * Whose report this is, stamped when the row is written rather than when it is sent — those
   * can be days and a change of hands apart. Null is unattributed and never resolved by guessing.
   */
  userId: string | null;
  /**
   * Epoch ms when the reader who wrote this left the browser, or null. Set by `handover.ts` and
   * decides nothing: `ownedBy` alone says what may be sent, this is for the storage manager.
   */
  heldAt: number | null;
  /** Which trail the report is about. */
  trailId: string;
  /** Enough to name the trail and link back to it with no server to ask. */
  trailName: string;
  trailPath: string;
  /** The mutation's own input, kept whole, so sending it is a replay rather than a rebuild. */
  write: ReviewWrite;
  /** When it was written, not when it will be sent. Epoch ms, so the row clones cleanly. */
  queuedAt: number;
  /** How many times sending has been attempted. Drives what the queue says, not what it keeps. */
  attempts: number;
  /** What went wrong last time, in the server's own words, or null if nothing has yet. */
  lastError: string | null;
  /**
   * Set when the server refused the report rather than failing to receive it. Automatic flushes
   * skip these; only a person pressing the button retries one.
   */
  blocked: boolean;
}

/**
 * Watchers of the queue, so a flush in one component redraws another. Module-level rather than a
 * context: the form, the layout's drain and the storage manager would all have to be threaded.
 */
const listeners = new Set<() => void>();

export function subscribeToQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Applies defaults on read: a row can predate the v4 upgrade, or have been written seconds before
 * one that has not run yet. A missing `userId` becomes null, which is unattributed, never "mine".
 */
function normalise(row: PendingReview): PendingReview {
  return {
    ...row,
    userId: row.userId ?? null,
    heldAt: row.heldAt ?? null,
    key: row.key ?? reviewKey(row.userId ?? null, row.trailId),
  };
}

export function listPendingReviews(): Promise<PendingReview[]> {
  return run<PendingReview[]>(
    PENDING_REVIEWS_STORE,
    'readonly',
    (store) => store.getAll() as IDBRequest<PendingReview[]>,
    // Oldest first: it is the order they were written in, and the order they should leave in.
  ).then((rows) => rows.map(normalise).sort((a, b) => a.queuedAt - b.queuedAt));
}

/**
 * One reader's draft for one trail. Takes the reader as well as the trail because the key does —
 * "the draft for this trail, whoever wrote it" is the question that prefilled the next person's form.
 */
export function getPendingReview(
  userId: string | null,
  trailId: string,
): Promise<PendingReview | null> {
  return run<PendingReview | undefined>(
    PENDING_REVIEWS_STORE,
    'readonly',
    (store) => store.get(reviewKey(userId, trailId)) as IDBRequest<PendingReview | undefined>,
  ).then((row) => (row ? normalise(row) : null));
}

export function putPendingReview(row: PendingReview): Promise<void> {
  // Derived rather than taken on trust, so a caller cannot file a row under one person's key
  // with another person's id on it.
  const keyed: PendingReview = { ...row, key: reviewKey(row.userId, row.trailId) };
  return run(PENDING_REVIEWS_STORE, 'readwrite', (store) => store.put(keyed)).then(() => {
    announce();
  });
}

export function deletePendingReview(userId: string | null, trailId: string): Promise<void> {
  return run(PENDING_REVIEWS_STORE, 'readwrite', (store) =>
    store.delete(reviewKey(userId, trailId)),
  ).then(() => {
    announce();
  });
}

/**
 * Sets aside every report belonging to a reader who has left. Rows already held keep their original
 * `heldAt` rather than having it creep forward every time somebody else signs in and out.
 */
export async function holdReviewsFor(userId: string, at: number): Promise<void> {
  const rows = await listPendingReviews();
  for (const row of rows) {
    if (row.userId === userId && row.heldAt === null) {
      await putPendingReview({ ...row, heldAt: at });
    }
  }
}

/** The reader is back. Their reports are ordinary queued rows again. */
export async function releaseReviewsFor(userId: string): Promise<void> {
  const rows = await listPendingReviews();
  for (const row of rows) {
    if (row.userId === userId && row.heldAt !== null) {
      await putPendingReview({ ...row, heldAt: null });
    }
  }
}

/** What claiming an unattributed report did. One of the three needs a sentence on screen. */
export type AdoptOutcome =
  /** The row now belongs to the claimer and will go out as theirs. */
  | 'adopted'
  /** There was no unattributed row for that trail — already claimed, or already discarded. */
  | 'nothing-to-claim'
  /**
   * The claimer already has a queued report for the same trail, and taking this one would
   * destroy it. Nothing was written; the caller asks the reader which of the two to keep.
   */
  | 'would-replace-your-own';

/**
 * Claims an unattributed report, from a button somebody presses on `/downloads`. The owner is half
 * the key, so this re-keys: written first and deleted second, because an interruption between the
 * two leaves the report on the device twice rather than not at all. Refuses to overwrite the
 * claimer's own queued report for the same trail — `replace` is their answer, never a default.
 */
export async function adoptPendingReview(
  trailId: string,
  userId: string,
  options: { replace?: boolean } = {},
): Promise<AdoptOutcome> {
  const row = await getPendingReview(null, trailId);
  if (!row) return 'nothing-to-claim';
  if (options.replace !== true && (await getPendingReview(userId, trailId))) {
    return 'would-replace-your-own';
  }
  await putPendingReview({ ...row, userId, heldAt: null, blocked: false, lastError: null });
  await deletePendingReview(null, trailId);
  return 'adopted';
}

/** A fresh row, for the moment a report is written and cannot be sent. */
export function pendingReview(fields: {
  trailId: string;
  trailName: string;
  trailPath: string;
  write: ReviewWrite;
  at: number;
  /** Who is writing. Null is honest and has consequences; see `identity.ts`. */
  userId: string | null;
}): PendingReview {
  return {
    key: reviewKey(fields.userId, fields.trailId),
    userId: fields.userId,
    heldAt: null,
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

/**
 * Did the request fail to arrive, or did the server refuse it? Only the first is worth retrying:
 * tRPC fills `data` from the server's own envelope, so a client error without it never got there.
 * A shape test rather than `instanceof TRPCClientError` — class identity is unreliable across
 * module boundaries in a workspace that can hold more than one copy of a package.
 */
export function isUnreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (typeof error !== 'object' || error === null) return false;
  return 'data' in error && error.data == null;
}

/**
 * Did the server refuse this because nobody is signed in? Told apart from other refusals because
 * those become `blocked`, and a session that expired in a valley would then need a manual retry.
 */
export function isUnauthorized(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const data = (error as { data?: { code?: string; httpStatus?: number } | null }).data;
  return data?.code === 'UNAUTHORIZED' || data?.httpStatus === 401;
}

/**
 * Runs drains one at a time, however many callers ask at once — mount, `online` and
 * `visibilitychange` can all fire in the same tick and would otherwise send everything twice.
 * Serialised rather than coalesced: the second caller re-reads the store and finds nothing to do,
 * which is the same answer without having to decide whether the two asked for the same thing.
 */
export function serialise<T>(tail: { current: Promise<void> }, work: () => Promise<T>): Promise<T> {
  const result = tail.current.then(work);
  // Never rejects, so one failed drain cannot poison every drain after it.
  tail.current = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
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
  /**
   * Who the browser is acting as; the only thing deciding what may be sent. Required and
   * undefaulted, so a new caller decides. A drain running as `null` sends nothing at all.
   */
  readerId: string | null;
  /**
   * Who the browser is acting as *now*, asked again before every request: a flush is one
   * sequential request per row, and the account the browser holds can change part-way through.
   */
  stillReader: () => string | null;
  /** Limit the run to one trail's report — what the "Post it now" button does. */
  trailId?: string;
  /** Include rows the server has already refused. Only ever set by a person retrying. */
  force?: boolean;
}

/**
 * Sends what is queued, one at a time — a connection that has just come back is usually one bar.
 * `post` is injected so what to keep and what to drop can be tested without a tRPC client.
 */
export async function flushPendingReviews(
  post: (write: ReviewWrite) => Promise<unknown>,
  options: FlushOptions,
): Promise<FlushResult> {
  return serialise(reviewDrain, () => drainReviews(post, options));
}

/** The tail of the review drain. See `serialise`. */
const reviewDrain = { current: Promise.resolve() };

async function drainReviews(
  post: (write: ReviewWrite) => Promise<unknown>,
  options: FlushOptions,
): Promise<FlushResult> {
  const all = await listPendingReviews();
  const queue = all.filter(
    (row) =>
      // First and unconditionally: `force` overrides a refusal, nothing overrides ownership.
      ownedBy(row, options.readerId) &&
      (options.trailId === undefined || row.trailId === options.trailId) &&
      (options.force === true || !row.blocked),
  );

  let sent = 0;
  for (const row of queue) {
    // Asked again immediately before the request that would send this row: the browser can
    // change hands mid-drain. Break rather than mark — the report is not at fault.
    if (!stillActingAs(options.readerId, options.stillReader)) break;
    try {
      await post(row.write);
      await deletePendingReview(row.userId, row.trailId);
      sent += 1;
    } catch (error) {
      // Neither is a fault with the report, and neither is permanent. See `isUnauthorized`.
      const wait = isUnreachable(error) || isUnauthorized(error);
      await putPendingReview({
        ...row,
        attempts: row.attempts + 1,
        lastError: wait ? null : reason(error),
        blocked: !wait,
      });
      // Still no signal, or still nobody signed in — each further failure costs battery.
      if (wait) break;
    }
  }

  return { sent, kept: (await listPendingReviews()).length };
}
