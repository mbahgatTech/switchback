'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_FIX_ACCURACY_M,
  SAMPLE_BATCH,
  type ActivityStats,
  type ActivityType,
  type LngLat,
  type TrackFix,
} from '@switchback/core';
import {
  DEFAULT_OFF_ROUTE_CONFIG,
  initialOffRouteState,
  remainingDistanceM,
  summariseTrack,
  updateOffRoute,
  type OffRouteState,
} from '@switchback/geo';
import { isUnreachable } from '@/offline/queue';
import {
  CHUNK_FIXES,
  chunkKey,
  claimLive,
  deleteActivity,
  isMissing,
  pendingActivity,
  putActivityHeader,
  readOpenActivity,
  releaseLive,
  writeChunk,
  type ActivityChunk,
  type PendingActivity,
} from '@/offline/activities';

/**
 * The recording engine: a phone's geolocation stream turned into a hike.
 *
 * Split from the screen because it is a state machine with four things happening at once —
 * a position watch, an upload loop, an off-route watchdog and a crash-recovery journal —
 * and none of them are about layout. The screen reads this hook and draws what it says.
 *
 * **Four rules hold the whole design together.**
 *
 * 1. **The buffer in memory is the truth while hiking; the server is the truth after.**
 *    Fixes accumulate locally, are flushed in batches, and are never removed from the local
 *    buffer once sent — so a failed upload is a retry, not a hole. Every statistic on screen
 *    is computed from the local buffer with the same `summariseTrack` the server runs, so
 *    the number you watch tick over is the number you get at the end.
 * 2. **Nothing waits for the end.** A batch goes up roughly every minute. Close the tab on
 *    the summit and what is stored is a shorter hike, not a lost one.
 * 3. **The journal survives a refresh.** IndexedDB holds the activity id, the start time, and
 *    every fix, five hundred to a chunk. A reload mid-hike picks the recording back up rather
 *    than orphaning it — and the recording comes back *paused*, because the honest thing to
 *    say after an interruption is "you were recording; carry on?" rather than pretending the
 *    gap did not happen.
 * 4. **The journal is also the queue row.** It is written through `offline/activities.ts`,
 *    which is the same store the background drain reads, so a hike that ends with no signal is
 *    already a debt the app owes rather than something that has to be handed over at the end.
 *    That is also why the id is minted on the device and passed to `activities.start`: there
 *    is one id from the first second, and nothing to reconcile when the connection returns.
 *
 * The journal was `localStorage` until this queue existed, and could not stay there. The cap
 * is about 5 MB of UTF-16, which is roughly six hours at 1 Hz — the middle of exactly the hike
 * this feature is for — and it fails silently, because a `QuotaExceededError` cannot be shown
 * to somebody who is walking. Worse, it re-serialised the whole buffer on every fix, which is
 * quadratic: about 22 GB of string building across an eighteen-thousand-fix day, ending at one
 * synchronous 2.5 MB write a second. Chunking is what makes the per-fix cost constant;
 * IndexedDB is what makes the budget hundreds of megabytes and the write asynchronous.
 */

export type RecorderPhase =
  /** Nothing recording. The start screen. */
  | 'idle'
  /** Waiting for the first fix good enough to start from. */
  | 'locating'
  | 'recording'
  | 'paused'
  /** `finish` in flight. */
  | 'saving';

const JOURNAL_KEY = 'switchback:recording:v1';
const JOURNAL_VERSION = 1;

/**
 * How often the buffer is flushed to the server.
 *
 * Sixty seconds, matched to `SAMPLE_BATCH` at the 1 Hz a phone actually delivers: whichever
 * arrives first triggers the upload, and at a normal fix rate they arrive together. Shorter
 * would mean a request every few seconds on a six-hour hike, which is a battery cost with
 * nothing to show for it; longer is a minute of hiking to lose, which is the most this
 * design is willing to risk.
 */
export const FLUSH_INTERVAL_MS = 60_000;

/**
 * The journal as it was before it moved to IndexedDB.
 *
 * Kept only to read one. A hiker who is mid-hike across the deploy that ships this has their
 * whole day in `localStorage` under the old key, and dropping it on upgrade would be losing a
 * hike to a release — which is the one thing this feature exists to stop happening.
 */
interface LegacyJournal {
  v: number;
  id: string;
  startedAt: number;
  trailId: string | null;
  fixes: TrackFix[];
  sent: number;
}

function readLegacyJournal(): LegacyJournal | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(JOURNAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LegacyJournal;
    if (parsed.v !== JOURNAL_VERSION || typeof parsed.id !== 'string') return null;
    if (!Array.isArray(parsed.fixes)) return null;
    return parsed;
  } catch {
    // A corrupt journal is worse than none: it would put the recorder into a state whose
    // activity id may not exist. Drop it and start clean.
    return null;
  }
}

function forgetLegacyJournal(): void {
  try {
    window.localStorage.removeItem(JOURNAL_KEY);
  } catch {
    /* Private mode, quota, a locked profile. None of them are worth failing a hike over. */
  }
}

/**
 * Move a pre-IndexedDB hike into the new store, once, before anything reads it.
 *
 * `serverStarted: true`, because the old flow could not mint an id — the only way that
 * journal exists is that `activities.start` already succeeded for it.
 */
async function importLegacyJournal(): Promise<void> {
  const journal = readLegacyJournal();
  if (!journal) return;
  try {
    const header: PendingActivity = {
      ...pendingActivity({
        activityId: journal.id,
        startedAt: journal.startedAt,
        trailId: journal.trailId,
        trailName: null,
        activityType: 'hiking',
        serverStarted: true,
      }),
      sent: Math.min(journal.sent, journal.fixes.length),
      count: journal.fixes.length,
    };
    for (let index = 0; index * CHUNK_FIXES < journal.fixes.length; index += 1) {
      await writeChunk({
        key: chunkKey(journal.id, index),
        activityId: journal.id,
        index,
        fixes: journal.fixes.slice(index * CHUNK_FIXES, (index + 1) * CHUNK_FIXES),
      });
    }
    await putActivityHeader(header);
  } catch {
    // The old copy is left in place if this fails, so the next load tries again.
    return;
  }
  forgetLegacyJournal();
}

export interface StartArgs {
  /** Minted on the device. This is also the id the server stores the hike under. */
  id: string;
  startedAt: Date;
  trailId: string | null;
  /** For naming the hike on the storage manager with no server to ask. */
  trailName?: string | null;
  activityType: ActivityType;
  /** Fixes already on the server, when adopting a recording started elsewhere. */
  resumed?: boolean;
  /**
   * Whether `activities.start` has already been acknowledged for this id.
   *
   * False for a hike begun with no signal — the first flush that reaches the server posts
   * `start` for it. True when adopting a recording the server already knows about.
   */
  serverStarted?: boolean;
}

export interface RecorderApi {
  phase: RecorderPhase;
  /** Every fix recorded on this device, oldest first. */
  fixes: readonly TrackFix[];
  stats: ActivityStats;
  /** Latest position, whether or not it was good enough to record. */
  position: LngLat | null;
  accuracyM: number | null;
  /** True when fixes are arriving but too vague to record. */
  weakSignal: boolean;
  /** Fixes waiting to go up. */
  pending: number;
  /** When the last batch was acknowledged. */
  lastSyncAt: Date | null;
  syncing: boolean;
  /** A geolocation problem, in the words the reader needs. */
  geoError: string | null;
  /** An upload problem. Recording continues; this is informational. */
  syncError: string | null;
  /** Whether the last upload failure was the connection rather than the server's answer. */
  syncOffline: boolean;
  offRoute: boolean;
  /** Metres from the route line, when a route is being followed. */
  offRouteDistanceM: number | null;
  /** Metres still to hike on the route, when a route is being followed. */
  remainingM: number | null;
  /** Set when an off-route crossing has just happened and has not been acknowledged. */
  alert: 'left' | 'returned' | null;
  dismissAlert: () => void;
  activityId: string | null;
  startedAt: Date | null;
  trailId: string | null;

  begin: (args: StartArgs) => void;
  /** Record that `activities.start` has been acknowledged for this id. */
  noteServerStarted: (id: string) => void;
  pause: () => void;
  resume: () => void;
  /** Flush anything outstanding. Resolves when the server has it, or throws. */
  flush: () => Promise<void>;
  stop: () => void;
  /**
   * Leave `saving` and go back to being a paused recording.
   *
   * The way out of a `finish` the server refused. Without it the phase is stuck at `saving`,
   * which is neither running nor paused, so the screen shows the start panel behind a finish
   * dialog whose buttons are permanently disabled — the day's hike locked behind a dead modal.
   */
  unstop: () => void;
  /** Wipe the local journal and the queued row. Nothing on the server is touched. */
  forget: () => void;
  /**
   * Clear the screen but leave the queued row where it is.
   *
   * What a hike finished with no signal does: it is no longer this screen's business, and it
   * is now the drain's. `forget` would delete the only copy of the day.
   */
  handOff: () => void;
}

export interface RecorderOptions {
  /** Uploads a batch. Resolves with what the server kept. */
  onFlush: (id: string, fixes: TrackFix[]) => Promise<unknown>;
  /**
   * Tells the server the recording exists. Called before the first upload of a hike it has
   * not acknowledged, and must be idempotent by `id` — it is replayed until it lands.
   *
   * Nothing can be appended to a recording the server has never heard of: `append` answers
   * "No such recording". A hike begun with no signal is exactly that, so the announcement is
   * carried by the upload path rather than by the button press, and the first flush after
   * signal returns makes it. Which is also why it must survive a reload: after one, the press
   * and everything it closed over are gone, and only the journal remembers.
   */
  onStart: (input: {
    id: string;
    activityType: ActivityType;
    trailId: string | null;
    startedAt: Date;
  }) => Promise<unknown>;
  /** The route being followed, if any. Enables the off-route watchdog. */
  route: readonly LngLat[] | null;
  /** Total route length, for the distance-to-finish readout. */
  routeLengthM: number | null;
}

export function useRecorder({
  onFlush,
  onStart,
  route,
  routeLengthM,
}: RecorderOptions): RecorderApi {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [activityId, setActivityId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [trailId, setTrailId] = useState<string | null>(null);
  const [position, setPosition] = useState<LngLat | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [weakSignal, setWeakSignal] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncOffline, setSyncOffline] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null);
  const [offRoute, setOffRoute] = useState(false);
  const [offRouteDistanceM, setOffRouteDistanceM] = useState<number | null>(null);
  const [alongM, setAlongM] = useState<number | null>(null);
  const [alert, setAlert] = useState<'left' | 'returned' | null>(null);

  // The buffer lives in a ref and its size is mirrored into state. Twenty thousand fixes
  // must not be copied into React state on every tick, and the screen only needs to know
  // that it changed.
  const fixesRef = useRef<TrackFix[]>([]);
  const sentRef = useRef(0);
  const [version, setVersion] = useState(0);

  const phaseRef = useRef<RecorderPhase>('idle');
  phaseRef.current = phase;
  const activityIdRef = useRef<string | null>(null);
  activityIdRef.current = activityId;
  const startedAtRef = useRef<Date | null>(null);
  startedAtRef.current = startedAt;
  const trailIdRef = useRef<string | null>(null);
  trailIdRef.current = trailId;
  const flushingRef = useRef(false);
  /**
   * `flush`, reachable from the hydrate effect above it.
   *
   * Assigned once `flush` exists, further down. A ref rather than a dependency because the
   * hydrate effect must run exactly once — putting `flush` in its deps would re-adopt the
   * journal every time the callback's identity changed.
   */
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;
  const routeRef = useRef<readonly LngLat[] | null>(route);
  routeRef.current = route;
  const offRouteRef = useRef<OffRouteState>(initialOffRouteState());

  // -------------------------------------------------------------------------
  // Journal
  // -------------------------------------------------------------------------

  /**
   * The queue row as it stands, and the chunk currently being filled.
   *
   * The header is held whole rather than rebuilt from the other refs so that fields the drain
   * owns — `attempts`, `blocked` — survive a hydrate and are not clobbered by a write from
   * here. Only one chunk is ever open, and it is the only one this hook rewrites.
   */
  const headerRef = useRef<PendingActivity | null>(null);
  const chunkRef = useRef<{ index: number; fixes: TrackFix[] } | null>(null);
  /** Metres so far, for the storage manager. Mirrored out of the stats memo below. */
  const distanceRef = useRef(0);

  /**
   * One write at a time, and never more than one queued.
   *
   * The store is asynchronous now, and the geolocation handler is not: a fix can land, be
   * buffered, and have its chunk write still in flight when the next one arrives. Two
   * overlapping `put`s of the same chunk key would interleave and lose fixes, which is
   * precisely the failure the journal exists to prevent — so writes are chained rather than
   * fired in parallel.
   *
   * `queued` collapses the run: a write already scheduled will read the refs when it executes
   * and therefore already covers every fix that arrived in the meantime, so a second one is
   * not worth scheduling. That turns a burst of fixes into one write rather than a queue of
   * them, and it is what keeps the per-fix cost constant.
   */
  const writeChainRef = useRef<Promise<void>>(Promise.resolve());
  const queuedRef = useRef(false);

  const writeJournal = useCallback(async (): Promise<void> => {
    const header = headerRef.current;
    const chunk = chunkRef.current;
    if (!header) return;
    if (chunk) {
      await writeChunk({
        key: chunkKey(header.activityId, chunk.index),
        activityId: header.activityId,
        index: chunk.index,
        // A copy, because the live array keeps growing and the write is asynchronous.
        fixes: chunk.fixes.slice(),
      });
    }
    const next: PendingActivity = {
      ...header,
      sent: sentRef.current,
      count: fixesRef.current.length,
      distanceM: distanceRef.current,
    };
    headerRef.current = next;
    await putActivityHeader(next);
  }, []);

  const persist = useCallback(() => {
    if (!headerRef.current || queuedRef.current) return;
    queuedRef.current = true;
    writeChainRef.current = writeChainRef.current
      .then(() => {
        // Cleared before the write, not after: a fix arriving while it runs schedules the
        // next one rather than being folded into a write that has already read the refs.
        queuedRef.current = false;
        return writeJournal();
      })
      .catch(() => {
        // Storage refused. The recording carries on — only its ability to survive a refresh
        // is affected, and the next fix schedules another attempt.
        queuedRef.current = false;
      });
  }, [writeJournal]);

  /**
   * Wait for the journal to catch up with the buffer.
   *
   * The write is asynchronous and the callers that end a hike are not: `onFinish` writes the
   * `finish` payload onto the same row this hook has been writing all day, and a write of ours
   * still in flight would land on top of it and silently un-finish the hike — caught up on the
   * server and never closed. So anything that hands the row over settles first.
   */
  const settle = useCallback((): Promise<void> => writeChainRef.current.catch(() => undefined), []);

  /** Add a fix to the open chunk, rolling over to a new one when it is full. */
  const journalFix = useCallback(
    (fix: TrackFix) => {
      const chunk = chunkRef.current;
      if (!chunk || chunk.fixes.length >= CHUNK_FIXES) {
        /*
         * The chunk that just filled is final, and it is written here rather than left to
         * `persist`.
         *
         * `persist` collapses a burst into one write on the reasoning that a write already
         * scheduled will read the refs when it runs and therefore covers everything that
         * arrived in the meantime. That holds only while `chunkRef` still points at the same
         * chunk. A write scheduled before this line and executed after it stores the *new*
         * chunk, and the completed one keeps whatever length it had when it was last
         * written — short by however many fixes arrived while that write was in flight.
         * Replayed against a synthetic store at four times the fix interval, 1,200 fixes
         * came back as 1,197, missing exactly the chunk-boundary tails.
         *
         * Pushed onto the same chain as every other write, so it lands in order, before the
         * next `writeJournal` opens the new chunk.
         */
        const header = headerRef.current;
        if (chunk && header) {
          const key = chunkKey(header.activityId, chunk.index);
          const closed: ActivityChunk = {
            key,
            activityId: header.activityId,
            index: chunk.index,
            fixes: chunk.fixes.slice(),
          };
          writeChainRef.current = writeChainRef.current
            .then(() => writeChunk(closed))
            .catch(() => undefined);
        }
        chunkRef.current = { index: chunk ? chunk.index + 1 : 0, fixes: [fix] };
      } else {
        chunk.fixes.push(fix);
      }
      persist();
    },
    [persist],
  );

  /**
   * Adopt whatever the last session left behind. Runs once, before anything else can.
   *
   * Asynchronous now, so it carries a cancelled flag: the store read can outlive the mount on
   * a fast navigation, and setting state after that is a warning at best and a resurrection of
   * a hike the reader has left at worst.
   */
  useEffect(() => {
    let cancelled = false;

    const hydrate = async (): Promise<void> => {
      await importLegacyJournal().catch(() => undefined);
      const restored = await readOpenActivity().catch(() => null);
      if (cancelled || !restored) return;

      const { header, fixes } = restored;
      fixesRef.current = fixes;
      sentRef.current = Math.min(header.sent, fixes.length);
      headerRef.current = header;
      // The open chunk is the tail: whatever is left after the full ones.
      const index = Math.max(0, Math.ceil(fixes.length / CHUNK_FIXES) - 1);
      chunkRef.current = { index, fixes: fixes.slice(index * CHUNK_FIXES) };
      distanceRef.current = header.distanceM;
      claimLive(header.activityId);
      // Set here as well as through state, because the flush below runs before React has
      // re-rendered and `flush` reads the ref rather than the value.
      activityIdRef.current = header.activityId;
      startedAtRef.current = new Date(header.startedAt);
      trailIdRef.current = header.trailId;

      setActivityId(header.activityId);
      setStartedAt(new Date(header.startedAt));
      setTrailId(header.trailId);
      setVersion((n) => n + 1);
      // Paused, not recording: see the note at the top of the file.
      setPhase('paused');
      const last = fixes[fixes.length - 1];
      if (last) setPosition([last.lng, last.lat]);

      /*
       * One upload, now, if there is a connection.
       *
       * Claiming the row tells the background drain to leave it alone, on the grounds that
       * the recorder is uploading it "on its own timer and its own online listener". For a
       * restored recording neither is true: the interval only runs while the phase is
       * `recording`, and this one comes back paused, and `online` fires on a transition that
       * has already happened. Measured as-shipped, a hike left unfinished offline and
       * reopened with the network back sat at "0 of 4 fixes sent" indefinitely with the
       * recorder on screen. This is the flush the listener would have made.
       */
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        await flushRef.current().catch(() => undefined);
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Hand the row back to the drain when this screen goes away.
   *
   * The claim exists so the recorder and the background drain do not both write `sent` on the
   * same header. It is module-level, so without this it would outlive the screen that took it:
   * a hiker who finishes at the car with no signal and navigates to `/downloads` would be
   * looking at a row nothing will ever send, because the drain is still being told the
   * recorder owns it. Unmounting is the moment that stops being true.
   */
  useEffect(
    () => () => {
      const id = activityIdRef.current;
      if (id) releaseLive(id);
    },
    [],
  );

  // -------------------------------------------------------------------------
  // The position watch
  // -------------------------------------------------------------------------

  const handleFix = useCallback(
    (reading: GeolocationPosition) => {
      const start = startedAtRef.current;
      if (!start) return;
      const { longitude, latitude, altitude, accuracy, speed } = reading.coords;
      setPosition([longitude, latitude]);
      setAccuracyM(accuracy ?? null);
      setGeoError(null);

      // The first fix good enough to trust is what turns "locating" into "recording".
      const usable = accuracy == null || accuracy <= MAX_FIX_ACCURACY_M;
      setWeakSignal(!usable);
      if (phaseRef.current === 'locating' && usable) setPhase('recording');
      if (phaseRef.current !== 'recording' && phaseRef.current !== 'locating') return;
      if (!usable) return;

      const t = Math.max(0, Math.round((Date.now() - start.getTime()) / 1000));
      const buffer = fixesRef.current;
      const previous = buffer[buffer.length - 1];
      // One fix a second, at most. A browser that fires the watch at 5 Hz would otherwise
      // fill the buffer with five copies of the same second, four of which the server's
      // `(activityId, t)` constraint would silently reject anyway.
      if (previous && t <= previous.t) return;

      const fix: TrackFix = {
        t,
        lng: longitude,
        lat: latitude,
        eleM: altitude != null && Number.isFinite(altitude) ? altitude : null,
        accuracyM: accuracy ?? null,
        speedMps: speed != null && speed >= 0 ? speed : null,
      };
      buffer.push(fix);
      setVersion((n) => n + 1);
      journalFix(fix);

      const line = routeRef.current;
      if (line && line.length >= 2) {
        // `updateOffRoute` measures its own timings in milliseconds — unlike `TrackFix.t`,
        // which is seconds since the start. Passing the wrong one here makes the watchdog
        // fire after 45 ms or after 45,000 seconds, and both look like it is broken.
        const update = updateOffRoute(
          offRouteRef.current,
          { t: Date.now(), lng: longitude, lat: latitude, accuracyM: accuracy ?? null },
          line,
          DEFAULT_OFF_ROUTE_CONFIG,
        );
        offRouteRef.current = update.state;
        setOffRoute(update.state.isOffRoute);
        setOffRouteDistanceM(update.distanceM);
        setAlongM(update.alongM);
        if (update.shouldAlert) {
          setAlert('left');
          buzz([200, 100, 200, 100, 400]);
        } else if (update.didReturn) {
          setAlert('returned');
          buzz([120]);
        }
      }
    },
    [journalFix],
  );

  useEffect(() => {
    if (phase !== 'recording' && phase !== 'locating') return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGeoError('This browser cannot report your position.');
      return;
    }
    const id = navigator.geolocation.watchPosition(
      handleFix,
      (err) => setGeoError(geoMessage(err)),
      {
        enableHighAccuracy: true,
        // Never hand back a cached position: on a hike, a fix from five minutes ago is a
        // wrong answer dressed as a right one.
        maximumAge: 0,
        timeout: 30_000,
      },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [phase, handleFix]);

  // -------------------------------------------------------------------------
  // Keeping the screen on
  // -------------------------------------------------------------------------

  useEffect(() => {
    if (phase !== 'recording' && phase !== 'locating') return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      try {
        sentinel = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        // Denied, unsupported, or the tab is not visible. The recording is unaffected —
        // the screen simply sleeps, which is what it would have done anyway.
      }
    };
    void acquire();

    // A wake lock is released whenever the tab is hidden and is not restored on return,
    // so it has to be taken again every time the hiker looks at their phone.
    const onVisible = (): void => {
      if (!cancelled && document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
    };
  }, [phase]);

  // -------------------------------------------------------------------------
  // Uploading
  // -------------------------------------------------------------------------

  const flush = useCallback(async (): Promise<void> => {
    const id = activityIdRef.current;
    if (!id || flushingRef.current) return;
    const outstanding = fixesRef.current.length - sentRef.current;
    const announced = headerRef.current?.serverStarted !== false;
    // Nothing to upload and the server already knows about the recording — but a caller that
    // awaits this is entitled to a settled journal when it returns, and `onFinish` is one.
    if (outstanding <= 0 && announced) {
      await settle();
      return;
    }

    flushingRef.current = true;
    setSyncing(true);
    try {
      /*
       * Tell the server the recording exists, if it does not know yet.
       *
       * A hike begun with no signal was never announced: `activities.start` failed at the
       * press and nothing since has been able to retry it. Every `append` for it would be
       * refused with "No such recording", so this has to come first, and it has to come from
       * here rather than from the screen — after a reload the press is gone and the journal
       * is all that remembers. Safe to replay: the id is the server's idempotency key.
       */
      const before = headerRef.current;
      if (before && !before.serverStarted) {
        await onStartRef.current({
          id,
          activityType: before.activityType,
          trailId: before.trailId,
          startedAt: new Date(before.startedAt),
        });
        // Re-read: the await above is long enough for the hike to have been discarded.
        const after = headerRef.current;
        if (after && after.activityId === id) {
          headerRef.current = { ...after, serverStarted: true };
          persist();
        }
      }

      // One batch per call, largest first. Draining the whole backlog in a loop would turn
      // a reconnection after an hour of no signal into sixty simultaneous requests.
      let reannounced = false;
      while (fixesRef.current.length - sentRef.current > 0) {
        const from = sentRef.current;
        const batch = fixesRef.current.slice(from, from + SAMPLE_BATCH);
        try {
          await onFlushRef.current(id, batch);
        } catch (error) {
          /*
           * The server has no row under this id any more.
           *
           * `serverStarted` is a one-way latch, and the thing it latches can be undone: the
           * router's stale sweep *deletes* rather than closes a recording that never received
           * a sample, which is exactly the shape of a hike begun with one bar and no first
           * upload. Without this, every append for the rest of the day answers "No such
           * recording" and the hike can only be discarded. Re-announcing is free and correct
           * — the id is the idempotency key — and it is tried once, so a NOT_FOUND arriving
           * for some other reason cannot spin.
           */
          const header = headerRef.current;
          if (!isMissing(error) || reannounced || !header) throw error;
          reannounced = true;
          headerRef.current = { ...header, serverStarted: false };
          await onStartRef.current({
            id,
            activityType: header.activityType,
            trailId: header.trailId,
            startedAt: new Date(header.startedAt),
          });
          const after = headerRef.current;
          if (after && after.activityId === id) {
            headerRef.current = { ...after, serverStarted: true };
          }
          persist();
          continue;
        }
        sentRef.current = from + batch.length;
        persist();
      }
      setLastSyncAt(new Date());
      setSyncError(null);
      setSyncOffline(false);
    } catch (err) {
      // Left in the buffer, so the next flush retries it. `sent` only ever advances past
      // fixes the server has acknowledged.
      const offline = isUnreachable(err);
      setSyncOffline(offline);
      setSyncError(
        offline
          ? 'No connection.'
          : err instanceof Error
            ? err.message
            : 'Could not save the last few minutes.',
      );
      throw err;
    } finally {
      flushingRef.current = false;
      setSyncing(false);
      await settle();
    }
  }, [persist, settle]);
  flushRef.current = flush;

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = window.setInterval(() => {
      void flush().catch(() => undefined);
    }, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [phase, flush]);

  // Coming back into signal is the one moment a flush is both possible and overdue, and it
  // is not something the timer can know about: a hiker who dropped into a valley at minute
  // 3 and climbed out at minute 55 would otherwise sit on an hour of unsent fixes for up to
  // another minute, on the one part of the hike where the phone is most likely to be put
  // away again. `online` fires on the transition, so this only ever runs when there is
  // something new to try.
  //
  // Mounted whenever there is a recording at all, not only while `phase === 'recording'`.
  // That guard was here and was wrong: a journal restored after a reload comes back *paused*,
  // so neither the timer nor this listener ever ran for the hike the comment above describes.
  // `flush` no-ops when there is nothing outstanding, so mounting it wider costs nothing. The
  // guard stays on the interval, where polling a paused recorder would buy nothing.
  useEffect(() => {
    if (!activityId) return;
    const onOnline = (): void => {
      void flush().catch(() => undefined);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [activityId, flush]);

  // A full batch does not wait for the timer. At 1 Hz the two coincide; on a device
  // reporting faster, this is what keeps the backlog from growing without bound.
  useEffect(() => {
    if (phase !== 'recording') return;
    if (fixesRef.current.length - sentRef.current < SAMPLE_BATCH) return;
    void flush().catch(() => undefined);
  }, [version, phase, flush]);

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  const begin = useCallback(
    ({
      id,
      startedAt: at,
      trailId: trail,
      trailName,
      activityType,
      resumed,
      serverStarted,
    }: StartArgs) => {
      if (!resumed) {
        fixesRef.current = [];
        sentRef.current = 0;
      }
      offRouteRef.current = initialOffRouteState();
      setActivityId(id);
      setStartedAt(at);
      setTrailId(trail);
      setSyncError(null);
      setSyncOffline(false);
      setGeoError(null);
      setAlert(null);
      setVersion((n) => n + 1);
      setPhase('locating');
      activityIdRef.current = id;
      startedAtRef.current = at;
      trailIdRef.current = trail;

      // The row exists from the press, not from the server's answer. That is the whole of
      // what makes a hike startable with no signal: there is nothing left to wait for.
      distanceRef.current = 0;
      const carried = fixesRef.current;
      const chunkIndex = Math.max(0, Math.ceil(carried.length / CHUNK_FIXES) - 1);
      chunkRef.current = { index: chunkIndex, fixes: carried.slice(chunkIndex * CHUNK_FIXES) };
      headerRef.current = pendingActivity({
        activityId: id,
        startedAt: at.getTime(),
        trailId: trail,
        trailName: trailName ?? null,
        activityType,
        serverStarted: serverStarted ?? false,
      });
      claimLive(id);
      persist();
    },
    [persist],
  );

  /**
   * The server has acknowledged this recording; the journal should say so.
   *
   * Written here rather than straight into the store because the header is rewritten from
   * this hook on every fix, and a write from anywhere else would be clobbered by the next
   * one. Getting it wrong is not fatal — a replayed `start` is adopted rather than duplicated
   * — but it is a wasted request on every hike and a journal that says something untrue.
   */
  const noteServerStarted = useCallback(
    (id: string) => {
      const header = headerRef.current;
      if (!header || header.serverStarted || header.activityId !== id) return;
      headerRef.current = { ...header, serverStarted: true };
      persist();
    },
    [persist],
  );

  const pause = useCallback(() => {
    setPhase((current) => (current === 'recording' || current === 'locating' ? 'paused' : current));
    void flush().catch(() => undefined);
  }, [flush]);

  const resume = useCallback(() => {
    setPhase((current) => (current === 'paused' ? 'locating' : current));
  }, []);

  const stop = useCallback(() => setPhase('saving'), []);

  const unstop = useCallback(() => {
    setPhase((current) => (current === 'saving' ? 'paused' : current));
  }, []);

  /** Everything both endings have in common: the screen goes back to the start panel. */
  const clear = useCallback(() => {
    fixesRef.current = [];
    sentRef.current = 0;
    headerRef.current = null;
    chunkRef.current = null;
    distanceRef.current = 0;
    offRouteRef.current = initialOffRouteState();
    setActivityId(null);
    setStartedAt(null);
    setTrailId(null);
    setPosition(null);
    setAccuracyM(null);
    setOffRoute(false);
    setOffRouteDistanceM(null);
    setAlongM(null);
    setAlert(null);
    setSyncError(null);
    setSyncOffline(false);
    setLastSyncAt(null);
    setVersion((n) => n + 1);
    setPhase('idle');
  }, []);

  const forget = useCallback(() => {
    const id = activityIdRef.current;
    releaseLive(id ?? undefined);
    // Before the delete is queued, so a write already scheduled finds no header and does
    // nothing rather than putting the row back after it has gone.
    headerRef.current = null;
    if (id) {
      writeChainRef.current = writeChainRef.current
        .then(() => deleteActivity(id))
        .catch(() => undefined);
    }
    clear();
  }, [clear]);

  const handOff = useCallback(() => {
    releaseLive(activityIdRef.current ?? undefined);
    headerRef.current = null;
    clear();
  }, [clear]);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const stats = useMemo(
    () => summariseTrack(fixesRef.current),
    // `version` is the buffer's identity; the buffer itself is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  // Mirrored into a ref so the journal can carry it without recomputing it. The storage
  // manager needs a distance for a hike it can no longer ask the server about.
  distanceRef.current = stats.distanceM;

  const remainingM = useMemo(() => {
    if (routeLengthM == null || alongM == null) return null;
    return remainingDistanceM(routeLengthM, alongM);
  }, [routeLengthM, alongM]);

  return {
    phase,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    fixes: useMemo(() => fixesRef.current.slice(), [version]),
    stats,
    position,
    accuracyM,
    weakSignal,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    pending: useMemo(() => fixesRef.current.length - sentRef.current, [version, syncing]),
    lastSyncAt,
    syncing,
    geoError,
    syncError,
    syncOffline,
    offRoute,
    offRouteDistanceM,
    remainingM,
    alert,
    dismissAlert: useCallback(() => setAlert(null), []),
    activityId,
    startedAt,
    trailId,
    begin,
    noteServerStarted,
    pause,
    resume,
    flush,
    stop,
    unstop,
    forget,
    handOff,
  };
}

/** Haptics where the platform has them, silence where it does not. */
function buzz(pattern: number[]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* Safari, and any browser that has removed it. */
  }
}

function geoMessage(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'Location access is blocked. Allow it in your browser settings to record a hike.';
    case err.POSITION_UNAVAILABLE:
      return 'No position yet. This usually means no clear view of the sky.';
    case err.TIMEOUT:
      return 'Still looking for a position.';
    default:
      return 'Could not read your position.';
  }
}
