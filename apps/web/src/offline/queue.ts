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
 *
 * **And nothing is ever sent under the wrong name.** Every row carries the account it was
 * written under, and the drain sends only rows belonging to the reader the browser is
 * currently acting as — see `ownedBy` in `identity.ts`. That is the second promise, and it is
 * as strong as the first: on a shared computer a report written by the person who left is
 * kept, marked, and shown to them when they come back, rather than published under the name
 * of the person who arrived. "Currently" is meant literally: who the browser is acting as is
 * asked again before every single request, not once when the drain starts. See `stillReader`
 * on `FlushOptions`.
 */

import type { ReviewWrite } from '@switchback/core';
import { ownedBy, stillActingAs } from './identity';
import { PENDING_REVIEWS_STORE, reviewKey, run } from './idb';

export { reviewKey };

export interface PendingReview {
  /** The key: `reviewKey(userId, trailId)`. One report per person per trail, as in Postgres. */
  key: string;
  /**
   * Whose report this is, or null when the device cannot say.
   *
   * Stamped from `writingReader()` at the moment the row is written, which is the moment the
   * post failed and not the moment it is finally sent — deliberately, because those can be
   * days and a change of hands apart. Null on a row carried across from the trail-keyed store,
   * and on one written by a browser that had never been told who was signed in. A null here is
   * never resolved by guessing: see `identity.ts`.
   */
  userId: string | null;
  /**
   * Epoch ms when the reader who wrote this left the browser, or null.
   *
   * Set by `handover.ts` when the account changes, cleared when that reader comes back. It
   * changes nothing about whether the row may be sent — `ownedBy` decides that on its own —
   * and exists so the storage manager can say *when* a report was set aside rather than only
   * that it was. Marking rather than deleting is the whole policy: the alternative throws
   * away the one copy of something a hiker wrote, on the strength of somebody else signing in.
   */
  heldAt: number | null;
  /** Which trail the report is about. */
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

/**
 * A row as it comes back off the disk.
 *
 * Rows written by version 3 and earlier have no `userId` and no `heldAt`, and the version 4
 * upgrade rewrites the ones it carries across — but a browser can also be reading a row it
 * wrote seconds before an upgrade that has not run yet, so the defaults are applied on every
 * read rather than trusted to have happened once. `undefined` becomes `null`, which is
 * "unattributed", which is the only safe reading of a row that never said.
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
 * One reader's draft for one trail.
 *
 * Takes the reader as well as the trail, because the key does. A caller that wants "the draft
 * on this device for this trail, whoever wrote it" is asking the question this module refuses
 * to answer — the report form used to ask it, and that is how a queued draft's full text came
 * to be prefilled into the next person's form.
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
  // The key is derived rather than taken on trust, so a caller cannot file a row under one
  // person's key with another person's id on it.
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
 * Set aside every report belonging to a reader who has left, without losing one of them.
 *
 * Called from `handover.ts` on a change of account. Rows already held are left alone so the
 * date stays the date they were first set aside, rather than creeping forward every time
 * somebody else signs in and out.
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

/**
 * What claiming an unattributed report did.
 *
 * A result rather than `void`, because one of the three outcomes needs a sentence on screen.
 * See `adoptPendingReview`.
 */
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
 * Claim an unattributed report as your own, on purpose.
 *
 * The only path by which a row's owner is ever written after the fact, and it exists only to
 * be reachable from a button somebody presses on `/downloads` having read the sentence next to
 * it. Refuses anything that already has an owner: a row belonging to a named account is that
 * account's, and no press by anybody else changes that.
 *
 * Re-keyed rather than updated in place, because the owner is half the key — so the old row is
 * removed and a new one written. Written first, deleted second: an interruption between the
 * two leaves the report on the device twice, which is recoverable, rather than not at all.
 *
 * **And it refuses to write over a report of the claimer's own.** The owner is half the key, so
 * the destination `reviewKey(userId, trailId)` is exactly where this reader's own queued report
 * for the same trail already sits — and IndexedDB `put` replaces on a key collision. That state
 * is not exotic: after the v4 upgrade a migrated draft is unattributed, so the trail page's form
 * (which asks `getPendingReview(readerId, trailId)`) cannot see it, and the ordinary thing for a
 * hiker to do is write the report again. Both rows are then on `/downloads` at once — theirs
 * under "Waiting to post", the migrated one under "We cannot tell whose these are" — and one
 * press used to delete the newer text and publish the older one in its place, silently. That is
 * the single outcome this module says at the top it will not produce.
 *
 * So the destination is read first and an occupied one is reported back rather than overwritten.
 * `replace` is the reader's own answer to the question that raises, taken on a second press with
 * both reports named — never a default, and never inferred.
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

/**
 * Did the server refuse this because nobody is signed in?
 *
 * A refusal, so `isUnreachable` says no — but not a fault with the write and not a permanent
 * one either. The reader signs back in and the identical payload goes up untouched.
 *
 * It has to be told apart, because the row grammar below turns any refusal into `blocked`, and
 * blocked rows are only ever retried by a person pressing a button on `/downloads`. A session
 * that expired in a valley, or a signed-out visit on a shared browser, would otherwise refuse
 * a hike for good on the one drain that ran before the reader signed in — and say so only on a
 * page they have no reason to open. So an auth refusal is treated the way no signal is: the
 * row is left alone, the drain stops, and the next one after a sign-in sends it.
 */
export function isUnauthorized(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const data = (error as { data?: { code?: string; httpStatus?: number } | null }).data;
  return data?.code === 'UNAUTHORIZED' || data?.httpStatus === 401;
}

/**
 * Run drains one at a time, however many callers ask at once.
 *
 * `SyncQueuedWrites` fires on mount, on `online`, and on every `visibilitychange` to visible,
 * and the storage manager's buttons are a fourth caller. A phone unlocked as its radio
 * reattaches hits two of those in the same tick, and without this both take the same snapshot
 * of the queue and send every `start`, `append` and `finish` in it twice. The server absorbs
 * the duplication — that is what the idempotency rules are for — but a six-hour hike is forty
 * requests over one bar, and doubling exactly those is the opposite of what the sequential
 * drain is for. Two concurrent `finish` calls also both read `endedAt === null`, which is the
 * one server-side step that counts rather than sets.
 *
 * Serialised rather than coalesced: the second caller waits and then runs, and because a drain
 * re-reads the store when it starts, it finds the work already done and returns immediately.
 * That is the same answer coalescing would give, without having to reason about whether two
 * callers asked for the same thing — one may have passed `force` and the other not.
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
   * Who the browser is acting as. Required, and there is no default.
   *
   * Nothing else in this module decides what may be sent. A drain running as `null` — a
   * signed-out browser, or one that has never been told — sends nothing at all, which is the
   * correct behaviour on a shared computer between one person leaving and the next arriving:
   * that gap is exactly when `SyncQueuedWrites` used to post the last person's report under
   * whatever session the browser happened to be holding.
   *
   * Not optional, so that adding a caller is a decision about identity rather than an
   * omission that compiles.
   */
  readerId: string | null;
  /**
   * Who the browser is acting as *now*, asked again before every request.
   *
   * `readerId` above is pinned when the flush starts. A flush is not an instant — it is one
   * request per queued row, sequential, over the single bar a hiker has just come back into —
   * and the account the browser holds can change part-way through it. Then every remaining
   * `post` carries the new person's cookie while `ownedBy(row, readerId)` is still true of the
   * old person's report, which is the original defect with a shorter fuse rather than a fixed
   * one. See `stillActingAs` in `identity.ts` for the sequence in full.
   *
   * Required, and required separately from `readerId`, on the same reasoning as `readerId`
   * itself: a caller that has to supply it has to think about it. Production passes
   * `writingReader`; a test passes a function returning whatever it is asserting on.
   */
  stillReader: () => string | null;
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
      // First and unconditionally. `force` overrides a refusal by the server; nothing
      // overrides this, because it is not about the report — it is about whose it is.
      ownedBy(row, options.readerId) &&
      (options.trailId === undefined || row.trailId === options.trailId) &&
      (options.force === true || !row.blocked),
  );

  let sent = 0;
  for (const row of queue) {
    // Asked again for every row, immediately before the request that would send it. The
    // browser can change hands part-way through a drain, and after that this row's owner and
    // the cookie the origin will attach are two different people. Break rather than mark: the
    // report is not at fault, nothing is owed a `blocked`, and it goes out untouched on the
    // next drain that runs as whoever wrote it. See `stillActingAs` in `identity.ts`.
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
        // An unreachable server is not something to report as a fault with the report.
        lastError: wait ? null : reason(error),
        blocked: !wait,
      });
      // Still no signal, or still nobody signed in. Everything after this would fail the same
      // way, and each failure is a request the hiker's battery pays for.
      if (wait) break;
    }
  }

  return { sent, kept: (await listPendingReviews()).length };
}
