/**
 * Offline hike recording: the recorder's journal and the upload queue are the same IndexedDB rows.
 * The device mints the activity id the server stores under, so start/append/finish all replay safely.
 */

import { SAMPLE_BATCH, type ActivityType, type TrackFix, type Visibility } from '@switchback/core';
import { ownedBy, stillActingAs } from './identity';
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
  /**
   * Whose hike this is, stamped when start was pressed rather than when the drain runs. Null is
   * "unattributed": never sent automatically, never adopted silently — see `identity.ts`.
   */
  userId: string | null;
  /**
   * Epoch ms when the reader who recorded this left the browser, or null. Set by `handover.ts`
   * and decides nothing: `ownedBy` alone says what may be sent, this is for the storage manager.
   */
  heldAt: number | null;
  /** Epoch ms. Every fix's `t` is seconds after this. */
  startedAt: number;
  trailId: string | null;
  /** Enough to name the hike on the storage manager with no server to ask. */
  trailName: string | null;
  activityType: ActivityType;
  /**
   * Whether `activities.start` has been acknowledged. False for a hike begun with no signal;
   * whoever uploads next posts `start` first, which is safe because `start` is idempotent by id.
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
   * Set when the server refused the hike rather than failing to receive it. Automatic flushes
   * skip these; only a person pressing the button retries one.
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

/** Watchers of the queue, so a drain redraws the storage manager. Deliberately separate from `queue.ts`'s. */
const listeners = new Set<() => void>();

export function subscribeToPendingActivities(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function announce(): void {
  for (const listener of listeners) listener();
}

/**
 * Applies defaults on read for rows written before the queue recorded authorship: a missing
 * `userId` becomes null, which means unattributed, never "mine".
 */
function normalise(row: PendingActivity): PendingActivity {
  return { ...row, userId: row.userId ?? null, heldAt: row.heldAt ?? null };
}

export function listPendingActivities(): Promise<PendingActivity[]> {
  return run<PendingActivity[]>(
    PENDING_ACTIVITIES_STORE,
    'readonly',
    (store) => store.getAll() as IDBRequest<PendingActivity[]>,
  ).then((rows) => rows.map(normalise).sort((a, b) => a.queuedAt - b.queuedAt));
}

export function getPendingActivity(activityId: string): Promise<PendingActivity | null> {
  return run<PendingActivity | undefined>(
    PENDING_ACTIVITIES_STORE,
    'readonly',
    (store) => store.get(activityId) as IDBRequest<PendingActivity | undefined>,
  ).then((row) => (row ? normalise(row) : null));
}

export function putActivityHeader(row: PendingActivity): Promise<void> {
  return run(PENDING_ACTIVITIES_STORE, 'readwrite', (store) => store.put(row)).then(() => {
    announce();
  });
}

export function writeChunk(chunk: ActivityChunk): Promise<void> {
  // Deliberately silent: chunk writes land once a second and would redraw the manager at 1 Hz.
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

/** Every fix of one hike, in order. */
export function readFixes(activityId: string): Promise<TrackFix[]> {
  return listChunks(activityId).then((chunks) => chunks.flatMap((chunk) => chunk.fixes));
}

/**
 * The hike this device is part-way through, if there is one. A row carrying a `finish` payload is
 * finished rather than open, and neither another reader's row nor an unattributed one is resumed.
 */
export async function readOpenActivity(readerId: string | null): Promise<{
  header: PendingActivity;
  fixes: TrackFix[];
} | null> {
  const rows = await listPendingActivities();
  const open = rows.filter((row) => row.finish === null && ownedBy(row, readerId));
  // Newest wins: if a delete failed, the current hike is the one worth resuming.
  const header = open[open.length - 1];
  if (!header) return null;
  return { header, fixes: await readFixes(header.activityId) };
}

/**
 * Turns a finished hike into a debt the device owes. Throws when the row is missing rather than
 * returning quietly: the one caller reads silence as success and would print a false receipt.
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
  /** Who pressed start. Null is honest and has consequences; see `identity.ts`. */
  userId: string | null;
}): PendingActivity {
  return {
    activityId: fields.activityId,
    userId: fields.userId,
    heldAt: null,
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

/**
 * Sets aside every hike belonging to a reader who has left. Rows already held keep their original
 * `heldAt` rather than having it move forward on every subsequent sign-in.
 */
export async function holdActivitiesFor(userId: string, at: number): Promise<void> {
  const rows = await listPendingActivities();
  for (const row of rows) {
    if (row.userId === userId && row.heldAt === null) {
      await putActivityHeader({ ...row, heldAt: at });
    }
  }
}

/** The reader is back. Their hikes are ordinary queued rows again. */
export async function releaseActivitiesFor(userId: string): Promise<void> {
  const rows = await listPendingActivities();
  for (const row of rows) {
    if (row.userId === userId && row.heldAt !== null) {
      await putActivityHeader({ ...row, heldAt: null });
    }
  }
}

/**
 * Claims an unattributed hike, from a button somebody presses on `/downloads`. The only path that
 * writes a hike's owner after the fact, and it refuses a row that already has one.
 */
export async function adoptPendingActivity(activityId: string, userId: string): Promise<void> {
  const row = await getPendingActivity(activityId);
  if (!row || row.userId !== null) return;
  await putActivityHeader({ ...row, userId, heldAt: null, blocked: false, lastError: null });
}

/**
 * The id the recorder currently holds; the drain skips it, because both write `sent` on the same
 * header and would otherwise race. Module-level, so this covers one document only.
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

/**
 * A v4 UUID, which becomes this hike's id everywhere. Falls back to `getRandomValues` because
 * `randomUUID` needs a secure context, which a bare `http://` LAN address in development is not.
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

/** The three server calls, injected so the ordering and retry policy are testable without tRPC. */
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
   * Deletes the server's copy, so Discard means the same thing whether or not the server has
   * been told. Optional: only the storage manager needs it, never the background drain.
   */
  remove?: (input: { id: string }) => Promise<unknown>;
}

export interface FlushActivitiesResult {
  /** Hikes that reached the account and were removed from here. */
  sent: number;
  /** Still queued afterwards, for whatever reason. */
  kept: number;
  /**
   * Hikes that landed with fixes missing from the end — an `append` the server will take no
   * more for. Named rather than swallowed: it is the one outcome here that loses something.
   */
  truncated: number;
}

export interface FlushActivitiesOptions {
  /**
   * Who the browser is acting as; the only thing deciding whether a hike may leave this device.
   * Required and undefaulted, so a new caller decides. A drain running as `null` sends nothing.
   */
  readerId: string | null;
  /**
   * Who the browser is acting as *now*, asked again before each of the three calls: a hike is
   * tens of seconds of requests, and a sign-in mid-flush would post the day to the new account.
   */
  stillReader: () => string | null;
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
 * An `append` the server will take no more for: the 20,000-sample cap, or a recording already
 * closed. Inside the append loop this always means a lost tail, never a harmless replay — a
 * replay after `finish` landed has `sent` caught up with the chunks and never enters the loop.
 */
function isFull(error: unknown): boolean {
  return error instanceof Error && error.message.includes('reached its maximum length');
}

function isAlreadyFinished(error: unknown): boolean {
  return error instanceof Error && error.message.includes('already finished');
}

/**
 * The server has no row under this id. `closeStale` deletes a recording with no samples, so a hike
 * that started with one bar can lose its server row; recoverable by re-announcing and retrying.
 */
export function isMissing(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as { data?: { code?: string } | null }).data?.code === 'NOT_FOUND';
}

/**
 * A sentence the last drain owes somebody. Module-level because the layout's background drain
 * throws its result away, and shared with `use-queue.ts` so `/downloads` has one live region.
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
 * Sends what is queued, one hike and one batch at a time. Progress is written to the header after
 * every acknowledged batch, so an interrupted drain resumes without re-sending.
 */
export async function flushPendingActivities(
  post: ActivityPosters,
  options: FlushActivitiesOptions,
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
      // First and unconditionally: `force` overrides a refusal, nothing overrides ownership.
      ownedBy(row, options.readerId) &&
      (options.activityId === undefined || row.activityId === options.activityId) &&
      (options.force === true || !row.blocked) &&
      // The recorder is uploading this one itself. See `claimLive`.
      !isLive(row.activityId),
  );

  let sent = 0;
  let truncated = 0;
  for (const row of queue) {
    // The browser can change hands mid-drain. Break rather than mark: the hike is not at fault.
    if (!stillActingAs(options.readerId, options.stillReader)) break;
    try {
      const outcome = await sendOne(post, row, options);
      if (outcome.truncated) truncated += 1;
      // Only a finished *and* acknowledged hike leaves the queue; one merely caught up stays.
      if (outcome.done) sent += 1;
    } catch (error) {
      // Neither no signal nor no session is a fault with the hike. See `isUnauthorized`.
      const wait = isUnreachable(error) || isUnauthorized(error);
      // Re-read: a row discarded while this ran must not be resurrected by the snapshot.
      const current = await getPendingActivity(row.activityId);
      if (current) {
        await putActivityHeader({
          ...current,
          attempts: current.attempts + 1,
          lastError: wait ? null : reason(error),
          blocked: !wait,
        });
      }
      // Still no signal, or still nobody signed in — each further failure costs battery.
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
 * Writes the row's progress back unless it has gone, returning whether it is still wanted. A plain
 * `put` after a Discard does not fail — it re-creates the row, resurrecting a thrown-away hike.
 */
async function saveProgress(next: PendingActivity): Promise<boolean> {
  if (!(await getPendingActivity(next.activityId))) return false;
  await putActivityHeader(next);
  return true;
}

/**
 * One hike: start if it was never started, append what is outstanding, finish if it ended. Every
 * server call asks two questions first — is the row still wanted, and is this still the same reader.
 */
async function sendOne(
  post: ActivityPosters,
  row: PendingActivity,
  options: FlushActivitiesOptions,
): Promise<{ done: boolean; truncated: boolean }> {
  let state = row;
  const abandoned = { done: false, truncated: false };
  const stillMine = (): boolean => stillActingAs(options.readerId, options.stillReader);

  // The queue was listed before this ran, so the row may already have been discarded.
  if (!(await getPendingActivity(state.activityId))) return abandoned;

  const announceToServer = async (): Promise<boolean> => {
    if (!stillMine()) return false;
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
    // What is left stays with `sent` already written, so the next drain resumes at this batch.
    if (!stillMine()) return { done: false, truncated };
    const batch = fixes.slice(state.sent, state.sent + SAMPLE_BATCH);
    try {
      await post.append({ id: state.activityId, fixes: batch });
    } catch (error) {
      // Swept out from under us: re-announce and retry once, bounded so a server answering
      // NOT_FOUND for some other reason cannot spin. See `isMissing`.
      if (isMissing(error) && !reannounced) {
        reannounced = true;
        state = { ...state, serverStarted: false };
        if (!(await saveProgress(state))) return abandoned;
        if (!(await announceToServer())) return abandoned;
        continue;
      }
      // Nothing more will be taken and fixes are outstanding: land what fits, count the rest lost.
      if (isAlreadyFinished(error) || (isFull(error) && state.finish)) {
        truncated = true;
        state = { ...state, lastError: reason(error) };
        if (!(await saveProgress(state))) return abandoned;
        break;
      }
      // A full but still-open recording can still be finished from `/record`, so it blocks instead.
      throw error;
    }
    state = { ...state, sent: state.sent + batch.length };
    if (!(await saveProgress(state))) return { done: false, truncated };
  }

  if (!state.finish) {
    // Unfinishable and unappendable: keeping the row leaves an entry whose only control is Discard.
    if (truncated) {
      await deleteActivity(state.activityId);
      return { done: true, truncated };
    }
    return { done: false, truncated };
  }

  // Discarded mid-upload: a `finish` would publish it and log a completion on the trail anyway.
  if (!(await getPendingActivity(state.activityId))) return { done: false, truncated };

  // `finish` is what publishes the hike, and the request furthest in time from where `readerId`
  // was pinned. A hike left here is whole on the device and finishes on the next drain.
  if (!stillMine()) return { done: false, truncated };

  await post.finish(state.finish);
  // Only after `finish` is acknowledged. Chunks go too even when a tail was refused: nothing can
  // ever be appended to a closed recording, so keeping them buys an unusable row. `truncated` says so.
  await deleteActivity(state.activityId);
  return { done: true, truncated };
}
