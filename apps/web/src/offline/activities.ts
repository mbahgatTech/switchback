/**
 * A hike recorded where there was nothing to send it to.
 *
 * The recorder's journal and the queue of hikes the device owes the server are **the same
 * rows**. There is no copy-at-finish and no hand-over step: from the moment the start button
 * is pressed there is a header in `pending-activities` and chunks in `activity-fixes`, and
 * finishing writes a `finish` payload onto the header rather than moving anything. So a hike
 * that ends on a ridge with no bars is already a debt the app owes, not something that has to
 * be noticed and rescued afterwards.
 *
 * **The device mints the id, and that id is the server's id.** `crypto.randomUUID()` before
 * the first fix, passed to `activities.start` as `input.id`. There is no client id / server id
 * pair and therefore nothing to reconcile — the journal, the queue row, every `append` and the
 * `finish` all name the same activity from the first second.
 *
 * ---
 *
 * **Idempotency — how a hike reaches the account exactly once, however many times the drain
 * runs.** Three layers, one per call:
 *
 * 1. `start` — the id *is* the idempotency key. The server looks it up before creating; an
 *    existing row belonging to the same person is returned unchanged rather than duplicated,
 *    and a `P2002` on the create is caught and resolved the same way. So a drain that posted
 *    `start` successfully and then lost the response replays it and gets the same hike back.
 * 2. `append` — idempotent by second. `ActivitySample` is `@@unique([activityId, t])` and the
 *    insert is `skipDuplicates`, so a batch that lands twice stores once. `sent` on the header
 *    only ever advances past a batch the server acknowledged, so a failure mid-drain is a
 *    retry rather than a hole, and a retry re-sends at most one already-stored batch.
 * 3. `finish` — replayable. It does not reject an already-ended recording, the completion is
 *    guarded by a unique on `activityId`, the statistics recompute from the stored samples to
 *    the same answer, and the one genuinely counting step (the busyness observation) is gated
 *    on the row not already having ended.
 *
 * The row is deleted only after `finish` returns. A delete that fails leaves a row whose
 * replay is harmless by all three rules above, which is the right direction to be wrong in.
 *
 * ---
 *
 * Kept beside `queue.ts` rather than folded into it. A report is keyed by trail, is one small
 * payload, and replace-on-amend is the whole of its semantics; a hike is keyed by itself,
 * carries thousands of fixes uploaded in batches with resumable partial progress, and has
 * three server calls in a fixed order. What the two share is lifted rather than copied:
 * `isUnreachable` is imported, and the row-state grammar — `attempts` / `lastError` /
 * `blocked`, automatic flushes skip blocked rows, only a person retries them — and the
 * sequential drain that breaks on the first unreachable error are followed identically, so the
 * two queues behave the same way on the storage manager.
 */

import { SAMPLE_BATCH, type ActivityType, type TrackFix, type Visibility } from '@switchback/core';
import { ACTIVITY_FIXES_STORE, PENDING_ACTIVITIES_STORE, run } from './idb';
import { isUnauthorized, isUnreachable, serialise } from './queue';

/** One chunk is one upload batch, so the drain never re-slices what the recorder wrote. */
export const CHUNK_FIXES = SAMPLE_BATCH;

/** Exactly what `activities.finish` takes, kept whole so sending it is a replay and not a rebuild. */
export interface FinishWrite {
  id: string;
  name: string | null;
  notes: string | null;
  visibility: Visibility;
  trailId: string | null;
  logCompletion: boolean;
}

export interface PendingActivity {
  /** The key: the id the device minted, which is also the id the server stores under. */
  activityId: string;
  /** Epoch ms. Every fix's `t` is seconds after this. */
  startedAt: number;
  trailId: string | null;
  /** Enough to name the hike on the storage manager with no server to ask. */
  trailName: string | null;
  activityType: ActivityType;
  /**
   * Whether `activities.start` has been acknowledged for this id.
   *
   * False for a hike begun with no signal. Whoever uploads next posts `start` first when it
   * is false — the recorder's own flush while the hike is live, this drain once it is not —
   * and because `start` is idempotent by id, a replay after a lost response is harmless.
   */
  serverStarted: boolean;
  /** How many fixes, from the front, the server has acknowledged. Never rewound. */
  sent: number;
  /** How many fixes are stored across the chunks. Display only; the chunks are the truth. */
  count: number;
  /** Metres so far, for the storage manager. Recomputed by the recorder, not by this module. */
  distanceM: number;
  /** Set when the hiker pressed Finish. Until then this row is a live recording. */
  finish: FinishWrite | null;
  /** When the recording began, epoch ms — the same as `startedAt`, kept for queue ordering. */
  queuedAt: number;
  attempts: number;
  lastError: string | null;
  /**
   * Set when the server refused the hike rather than failing to receive it.
   *
   * Automatic flushes skip these, for the reason spelled out in `queue.ts`: a row that
   * retries forever is not resilience. Only a person pressing the button retries one.
   */
  blocked: boolean;
}

export interface ActivityChunk {
  /** `${activityId}:${index}`, index zero-padded so a lexical sort is a numeric one. */
  key: string;
  activityId: string;
  index: number;
  fixes: TrackFix[];
}

export function chunkKey(activityId: string, index: number): string {
  return `${activityId}:${String(index).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Everyone watching the queue, so a drain in the layout redraws the storage manager.
 *
 * Its own set rather than reaching into `queue.ts` for that module's `announce`: eight
 * duplicated lines is less coupling than exporting a private of a file two others import,
 * and a hike going out has no business redrawing a page that is watching for a report.
 */
const listeners = new Set<() => void>();

export function subscribeToPendingActivities(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

export function listPendingActivities(): Promise<PendingActivity[]> {
  return run<PendingActivity[]>(
    PENDING_ACTIVITIES_STORE,
    'readonly',
    (store) => store.getAll() as IDBRequest<PendingActivity[]>,
  ).then((rows) => rows.sort((a, b) => a.queuedAt - b.queuedAt));
}

export function getPendingActivity(activityId: string): Promise<PendingActivity | null> {
  return run<PendingActivity | undefined>(
    PENDING_ACTIVITIES_STORE,
    'readonly',
    (store) => store.get(activityId) as IDBRequest<PendingActivity | undefined>,
  ).then((row) => row ?? null);
}

export function putActivityHeader(row: PendingActivity): Promise<void> {
  return run(PENDING_ACTIVITIES_STORE, 'readwrite', (store) => store.put(row)).then(() => {
    announce();
  });
}

export function writeChunk(chunk: ActivityChunk): Promise<void> {
  // Deliberately silent: a chunk write is on the per-fix path and happens once a second.
  // Announcing it would redraw the storage manager at 1 Hz for a number that is not on it.
  return run(ACTIVITY_FIXES_STORE, 'readwrite', (store) => store.put(chunk)).then(() => undefined);
}

function listChunks(activityId: string): Promise<ActivityChunk[]> {
  return run<ActivityChunk[]>(
    ACTIVITY_FIXES_STORE,
    'readonly',
    (store) => store.getAll() as IDBRequest<ActivityChunk[]>,
  ).then((rows) =>
    rows.filter((row) => row.activityId === activityId).sort((a, b) => a.index - b.index),
  );
}

/**
 * Every fix of one hike, in order.
 *
 * `getAll` and a filter rather than a key range: the server allows one open recording, so
 * there is at most one hike in here at a time and a range query would be a new surface on
 * `run()` bought for nothing.
 */
export function readFixes(activityId: string): Promise<TrackFix[]> {
  return listChunks(activityId).then((chunks) => chunks.flatMap((chunk) => chunk.fixes));
}

/**
 * The hike this device is part-way through, if there is one.
 *
 * A row that already carries a `finish` payload is not one of these. It is a finished hike
 * waiting on a connection, and restoring it into the recorder would put a hiker back inside a
 * day they have already ended.
 */
export async function readOpenActivity(): Promise<{
  header: PendingActivity;
  fixes: TrackFix[];
} | null> {
  const rows = await listPendingActivities();
  const open = rows.filter((row) => row.finish === null);
  // Newest wins. There should only ever be one; if a delete failed, the current hike is the
  // one worth resuming and the older row still drains on its own.
  const header = open[open.length - 1];
  if (!header) return null;
  return { header, fixes: await readFixes(header.activityId) };
}

/**
 * The hiker pressed Finish and the server could not be told. This is what turns it into a debt.
 *
 * Throws rather than shrugging when the row is not there. It used to return quietly, and the
 * one caller — the offline branch of `onFinish` — read that silence as success: it swallowed
 * the failure, cleared the in-memory buffer, and printed "Saved on this device" over a hike
 * that had just been thrown away. A device whose IndexedDB writes have been failing all day
 * (quota, a locked profile, private mode) has no header for this id, which is precisely when
 * that receipt is least true. Loud is the only honest option; the caller decides what to say.
 */
export async function markFinished(activityId: string, finish: FinishWrite): Promise<void> {
  const row = await getPendingActivity(activityId);
  if (!row) throw new Error('This hike is not stored on this device.');
  await putActivityHeader({ ...row, finish, blocked: false, lastError: null });
}

export async function deleteActivity(activityId: string): Promise<void> {
  const chunks = await listChunks(activityId).catch(() => []);
  for (const chunk of chunks) {
    await run(ACTIVITY_FIXES_STORE, 'readwrite', (store) => store.delete(chunk.key));
  }
  await run(PENDING_ACTIVITIES_STORE, 'readwrite', (store) => store.delete(activityId));
  announce();
}

/** A fresh header, for the moment the start button is pressed. */
export function pendingActivity(fields: {
  activityId: string;
  startedAt: number;
  trailId: string | null;
  trailName: string | null;
  activityType: ActivityType;
  serverStarted: boolean;
}): PendingActivity {
  return {
    activityId: fields.activityId,
    startedAt: fields.startedAt,
    trailId: fields.trailId,
    trailName: fields.trailName,
    activityType: fields.activityType,
    serverStarted: fields.serverStarted,
    sent: 0,
    count: 0,
    distanceM: 0,
    finish: null,
    queuedAt: fields.startedAt,
    attempts: 0,
    lastError: null,
    blocked: false,
  };
}

// ---------------------------------------------------------------------------
// Who owns the row
// ---------------------------------------------------------------------------

/**
 * The id the recorder is currently holding, if any.
 *
 * The recorder and the background drain are both mounted in the same document and both write
 * `sent` on the same header. Without this they would race: the drain would re-send a batch the
 * recorder had just acknowledged, and whichever wrote last would win. So the recorder claims
 * its own hike for as long as it is recording it, and the drain skips a claimed row — the
 * recorder is already uploading it, on its own timer and its own `online` listener.
 *
 * Module-level and therefore same-tab only, which is the case that matters: both parties live
 * in one document. Two tabs open on `/record` are not covered, and were already broken before
 * this existed — one localStorage journal, two recorders.
 */
let claimed: string | null = null;

export function claimLive(activityId: string): void {
  claimed = activityId;
}

export function releaseLive(activityId?: string): void {
  if (activityId === undefined || claimed === activityId) claimed = null;
}

export function isLive(activityId: string): boolean {
  return claimed === activityId;
}

// ---------------------------------------------------------------------------
// Minting an id
// ---------------------------------------------------------------------------

/**
 * A v4 UUID, which becomes this hike's id everywhere.
 *
 * `crypto.randomUUID` needs a secure context: production is https and every browser this
 * product supports has had it for years, but a phone testing against a bare `http://` LAN
 * address in development does not get it, and a start button that throws there would look
 * exactly like a start button that is broken. `getRandomValues` has no such restriction, so
 * the fallback is a real v4 rather than a weaker id.
 */
export function newActivityId(): string {
  const source = globalThis.crypto;
  if (typeof source?.randomUUID === 'function') return source.randomUUID();

  const bytes = new Uint8Array(16);
  source.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * The three server calls, injected rather than imported.
 *
 * Same design as `flushPendingReviews`' single poster and for the same reason: the ordering
 * and the retry policy are the part worth testing, and neither needs a tRPC client to be
 * exercised.
 */
export interface ActivityPosters {
  start: (input: {
    id: string;
    activityType: ActivityType;
    trailId: string | null;
    startedAt: Date;
  }) => Promise<unknown>;
  append: (input: { id: string; fixes: TrackFix[] }) => Promise<unknown>;
  finish: (input: FinishWrite) => Promise<unknown>;
  /**
   * Deletes the server's copy. Optional: only the storage manager needs it, so that Discard
   * means the same thing for a hike the server has already been told about as for one it has
   * not. The background drain never discards anything.
   */
  remove?: (input: { id: string }) => Promise<unknown>;
}

export interface FlushActivitiesResult {
  /** Hikes that reached the account and were removed from here. */
  sent: number;
  /** Still queued afterwards, for whatever reason. */
  kept: number;
  /**
   * Hikes that landed with fixes missing from the end.
   *
   * Named rather than swallowed: it is the one outcome here that loses something, and a
   * hiker is owed the sentence rather than left to notice a short track later. Two causes,
   * both an `append` the server will take no more fixes for — see `isFull` and
   * `isAlreadyFinished`.
   */
  truncated: number;
}

export interface FlushActivitiesOptions {
  /** Limit the run to one hike — what a Send button on the storage manager does. */
  activityId?: string;
  /** Include rows the server has already refused. Only ever set by a person retrying. */
  force?: boolean;
}

const UNSAID = 'The server would not take it.';

function reason(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return UNSAID;
}

/**
 * An `append` the server refused because there is nothing more it will take for this hike.
 *
 * Two messages, both `BAD_REQUEST`, both meaning "stop appending":
 * - *reached its maximum length* — the 20,000-sample cap, which a very long offline hike can
 *   genuinely reach.
 * - *already finished* — the recording has an `endedAt`. Set by this device's own `finish`,
 *   or by another device's, or by the router's stale sweep, which closes every earlier open
 *   recording the moment a new one starts (`routers/activities.ts`, `start`).
 *
 * **Neither is loss-free where it is caught.** The append loop only runs while there are fixes
 * this device has not had acknowledged, so a refusal inside it is by construction a tail that
 * will never land: nothing can be appended to a closed or full recording, ever. The genuinely
 * harmless case — a drain replayed after `finish` landed but the delete did not — never
 * reaches the loop at all, because `sent` has already caught up with the chunks and there is
 * nothing to append. That distinction is what `truncated` counts, and it used to be drawn the
 * wrong way: *already finished* was assumed to mean "every fix is on the server", which is
 * only true when this device's own successful `finish` was the thing that closed it.
 */
function isFull(error: unknown): boolean {
  return error instanceof Error && error.message.includes('reached its maximum length');
}

function isAlreadyFinished(error: unknown): boolean {
  return error instanceof Error && error.message.includes('already finished');
}

/**
 * The server has no row under this id.
 *
 * Not always a fault, and recoverable. `closeStale` *deletes* rather than closes a recording
 * with no samples in it, so a hike begun with one bar — `start` acknowledged, signal gone
 * before the first upload — can have its server row swept out from under a header that still
 * says `serverStarted: true`. Every `append` after that answers "No such recording", which is
 * neither full nor finished, and blocked the whole hike for good. Re-announcing costs one
 * request and is exactly what the id being the idempotency key is for.
 */
export function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { data?: { code?: string } | null }).data?.code === 'NOT_FOUND';
}

// ---------------------------------------------------------------------------
// What the last drain needs a person to know
// ---------------------------------------------------------------------------

/**
 * A sentence the last drain owes somebody, or null.
 *
 * Module-level rather than returned, because the drain that most needs to say something is
 * the one nobody asked for: `SyncQueuedWrites` runs in the layout, throws its result away, and
 * deletes the row the outcome belonged to on the way. Kept here so the storage manager can
 * show it whenever the reader next opens `/downloads`, rather than only when they happened to
 * be looking at the page while it ran.
 */
let drainNoticeText: string | null = null;

export function drainNotice(): string | null {
  return drainNoticeText;
}

export function setDrainNotice(text: string | null): void {
  drainNoticeText = text;
  announce();
}

/**
 * Send what is queued, one hike at a time and one batch at a time within it.
 *
 * Sequential, like the review drain and for the same reason: a connection that has just come
 * back is one bar, and a six-hour hike is forty-odd requests. Progress is written to the
 * header after every acknowledged batch, so a drain interrupted half-way — a closed tab, a
 * tunnel — resumes exactly where it stopped and re-sends nothing the server already has.
 *
 * Serialised against itself as well: see `serialise` in `queue.ts` for why two drains at once
 * is the normal case rather than an exotic one, and what it costs.
 */
export async function flushPendingActivities(
  post: ActivityPosters,
  options: FlushActivitiesOptions = {},
): Promise<FlushActivitiesResult> {
  return serialise(activityDrain, () => drainActivities(post, options));
}

/** The tail of the hike drain. See `serialise`. */
const activityDrain = { current: Promise.resolve() };

async function drainActivities(
  post: ActivityPosters,
  options: FlushActivitiesOptions,
): Promise<FlushActivitiesResult> {
  const all = await listPendingActivities();
  const queue = all.filter(
    (row) =>
      (options.activityId === undefined || row.activityId === options.activityId) &&
      (options.force === true || !row.blocked) &&
      // The recorder is uploading this one itself. See `claimLive`.
      !isLive(row.activityId),
  );

  let sent = 0;
  let truncated = 0;
  for (const row of queue) {
    try {
      const outcome = await sendOne(post, row);
      if (outcome.truncated) truncated += 1;
      // Only a hike that is finished *and* acknowledged leaves the queue. One that is merely
      // caught up — the tab was closed mid-hike, so nothing ever pressed Finish — stays, and
      // is picked back up by the recorder or ended from the server's own open recording.
      if (outcome.done) sent += 1;
    } catch (error) {
      // Neither no signal nor no session is a fault with the hike, and neither is permanent.
      // See `isUnauthorized` in `queue.ts`.
      const wait = isUnreachable(error) || isUnauthorized(error);
      // Re-read: `sendOne` writes its progress as it goes, and that progress must survive
      // the failure that stopped it. A row that is *gone* was discarded while this ran, and
      // writing the snapshot back would resurrect a hike the reader threw away.
      const current = await getPendingActivity(row.activityId);
      if (current) {
        await putActivityHeader({
          ...current,
          attempts: current.attempts + 1,
          lastError: wait ? null : reason(error),
          blocked: !wait,
        });
      }
      // Still no signal, or still nobody signed in. Everything after this fails the same way,
      // and each failure is a request the hiker's battery pays for.
      if (wait) break;
    }
  }

  if (truncated > 0) {
    setDrainNotice(
      truncated === 1
        ? 'One hike was closed before all of it had been sent. What reached the server was kept; the rest could not be added.'
        : `${truncated} hikes were closed before all of them had been sent. What reached the server was kept; the rest could not be added.`,
    );
  }

  return { sent, kept: (await listPendingActivities()).length, truncated };
}

/**
 * Write the row's progress back, unless the row has gone.
 *
 * Discard is one press, and a six-hour hike is tens of seconds of sequential appends: the two
 * overlap. Every write in `sendOne` goes through here because a plain `put` after a delete
 * does not fail — it *re-creates* the row, so a hike the reader threw away came back, kept
 * uploading, and was published at the end with a completion logged against the trail.
 *
 * Returns whether the row is still wanted, which is also the drain's signal to stop.
 */
async function saveProgress(next: PendingActivity): Promise<boolean> {
  if (!(await getPendingActivity(next.activityId))) return false;
  await putActivityHeader(next);
  return true;
}

/** One hike: start if it was never started, append what is outstanding, finish if it ended. */
async function sendOne(
  post: ActivityPosters,
  row: PendingActivity,
): Promise<{ done: boolean; truncated: boolean }> {
  let state = row;
  const abandoned = { done: false, truncated: false };

  // The queue was listed before this ran, so the row may already have been discarded.
  if (!(await getPendingActivity(state.activityId))) return abandoned;

  const announceToServer = async (): Promise<boolean> => {
    await post.start({
      id: state.activityId,
      activityType: state.activityType,
      trailId: state.trailId,
      startedAt: new Date(state.startedAt),
    });
    state = { ...state, serverStarted: true };
    return saveProgress(state);
  };

  if (!state.serverStarted && !(await announceToServer())) return abandoned;

  // The chunks are the truth about what was recorded; `count` on the header is for display.
  const fixes = await readFixes(state.activityId);
  let truncated = false;
  let reannounced = false;

  while (state.sent < fixes.length) {
    const batch = fixes.slice(state.sent, state.sent + SAMPLE_BATCH);
    try {
      await post.append({ id: state.activityId, fixes: batch });
    } catch (error) {
      // The row was swept out from under us. Say it exists again and retry the same batch —
      // once, so a server that answers NOT_FOUND for some other reason cannot spin. See
      // `isMissing`.
      if (isMissing(error) && !reannounced) {
        reannounced = true;
        state = { ...state, serverStarted: false };
        if (!(await saveProgress(state))) return abandoned;
        if (!(await announceToServer())) return abandoned;
        continue;
      }
      // Nothing more will be taken for this recording, and there are fixes outstanding — see
      // `isFull` / `isAlreadyFinished`. Landing what fits is better than blocking the whole
      // hike over its tail, but the tail is gone and somebody has to be told.
      if (isAlreadyFinished(error) || (isFull(error) && state.finish)) {
        truncated = true;
        state = { ...state, lastError: reason(error) };
        if (!(await saveProgress(state))) return abandoned;
        break;
      }
      // A full recording that is still open is a different case: it can still be finished
      // from `/record`, which is a recovery worth keeping, so it blocks like any other
      // refusal and says so on the storage manager.
      throw error;
    }
    state = { ...state, sent: state.sent + batch.length };
    if (!(await saveProgress(state))) return { done: false, truncated };
  }

  if (!state.finish) {
    // A recording nobody finished, that the server will take no more of. It cannot be
    // appended to again — not by this drain, not by "Add it now", not ever — so keeping the
    // row would leave a permanent "Not added" entry whose only working control is Discard.
    // The fixes that landed are already a hike in the account, closed by the sweep with its
    // statistics recomputed; the ones that did not are counted above and said out loud.
    if (truncated) {
      await deleteActivity(state.activityId);
      return { done: true, truncated };
    }
    return { done: false, truncated };
  }

  // Discarded while the appends were going up. Nothing here is worth publishing on behalf of
  // somebody who threw it away — a `finish` would also log a completion and a point of
  // popularity against the trail — and `usePendingActivities.discard` has told the server to
  // delete its own copy.
  if (!(await getPendingActivity(state.activityId))) return { done: false, truncated };

  await post.finish(state.finish);
  // Only now. A delete before the finish is acknowledged would lose a hike to a dropped
  // response; a delete that itself fails leaves a row whose replay is harmless.
  //
  // The chunks go with it even when a tail was refused, which is deliberate rather than an
  // oversight. Nothing can ever be appended to a recording the server has closed or filled,
  // so those fixes have no path to an account and no reader-facing export; keeping them would
  // buy a permanent "Not added" row whose every control fails, in exchange for bytes nobody
  // can spend. The honest trade is to say what was lost — which `truncated` does, out loud,
  // on the storage manager — rather than to keep an unusable copy of it quietly.
  await deleteActivity(state.activityId);
  return { done: true, truncated };
}
