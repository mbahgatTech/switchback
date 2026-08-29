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
  advanceProgress,
  initialOffRouteState,
  summariseTrack,
  updateOffRoute,
  type HikePlan,
  type OffRouteState,
  type RouteProgress,
} from '@switchback/geo';
import { isUnreachable } from '@/offline/queue';
import { stillActingAs, writingReader } from '@/offline/identity';
import { readerSettled, subscribeToReader } from '@/offline/reader';
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
 * The recording engine: a geolocation watch, a batched uploader, an off-route watchdog and a
 * crash-recovery journal, kept out of the screen that draws them.
 *
 * The in-memory buffer is the truth while hiking and the server after. Fixes are never removed
 * from the buffer once sent, so a failed upload is a retry rather than a hole, and the journal
 * is written through `offline/activities.ts` — the same store the background drain reads.
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
 * How often the buffer is flushed to the server. Matched to `SAMPLE_BATCH` at the 1 Hz a phone
 * delivers, so whichever arrives first triggers the upload; a minute is the most this risks.
 */
export const FLUSH_INTERVAL_MS = 60_000;

/**
 * The journal as it was before it moved to IndexedDB. Kept only to read one, so a hiker
 * mid-hike across the deploy that ships this does not lose a day to a release.
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
    // A corrupt journal would put the recorder into a state whose activity id may not exist.
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
 * `serverStarted: true` because the old flow could not mint an id — `activities.start` must
 * already have succeeded. `userId: null` because that journal never recorded whose hike it
 * was; it surfaces on `/downloads` to be claimed rather than being stamped with whoever is
 * signed in now.
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
        userId: null,
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
   * Whether `activities.start` has already been acknowledged for this id. False for a hike
   * begun with no signal — the first flush that reaches the server posts `start` for it.
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
  /**
   * An upload problem. Recording continues; this is informational. Also carries the one
   * non-problem written here: the browser is now acting as somebody else, so the uploader has
   * stopped — nothing failed, which is why it is a sync state rather than an error.
   */
  syncError: string | null;
  /** Whether the last upload failure was the connection rather than the server's answer. */
  syncOffline: boolean;
  offRoute: boolean;
  /** Metres from the route line, when a route is being followed. */
  offRouteDistanceM: number | null;
  /**
   * Where on the trail the last usable fix put the hiker, and what is left of the hike from
   * there. The one value everything that draws progress reads — see `@switchback/geo`.
   */
  progress: RouteProgress | null;
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
  /**
   * Fixes the server has not acknowledged, read live. Ask this *after* an await — `pending` is
   * the number off the last render, which is what to draw but not what a flush left behind.
   */
  outstanding: () => number;
  /**
   * Is the browser still acting as the account that pressed start? Read live.
   *
   * For the one call this hook does not make itself: `finish` is posted by the screen, and it
   * is the request that publishes a day under a name. The uploader asks the same question
   * before every batch.
   */
  stillMine: () => boolean;
  stop: () => void;
  /**
   * Leave `saving` and go back to being a paused recording — the way out of a `finish` the
   * server refused. Without it the phase sticks at `saving` and the dialog's buttons stay dead.
   */
  unstop: () => void;
  /** Wipe the local journal and the queued row. Nothing on the server is touched. */
  forget: () => void;
  /**
   * Clear the screen but leave the queued row for the drain — what a hike finished with no
   * signal does. `forget` would delete the only copy of the day.
   *
   * The header reference is dropped *first*: `writeJournal` returns when it is null, so writes
   * still queued become no-ops rather than landing on top of `onFinish`'s payload and silently
   * un-finishing the hike. Settling here instead would run those writes rather than neuter them.
   */
  handOff: () => void;
}

export interface RecorderOptions {
  /** Uploads a batch. Resolves with what the server kept. */
  onFlush: (id: string, fixes: TrackFix[]) => Promise<unknown>;
  /**
   * Tells the server the recording exists. Must be idempotent by `id` — it is replayed until
   * it lands. `append` answers "No such recording" otherwise, so a hike begun with no signal
   * is announced by the upload path rather than by the button press, and must survive a reload.
   */
  onStart: (input: {
    id: string;
    activityType: ActivityType;
    trailId: string | null;
    startedAt: Date;
  }) => Promise<unknown>;
  /** The route being followed, if any. Enables the off-route watchdog. */
  route: readonly LngLat[] | null;
  /** The hike that route describes, for the progress readings. Null when there is no trail. */
  plan: HikePlan | null;
}

export function useRecorder({ onFlush, onStart, route, plan }: RecorderOptions): RecorderApi {
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
  const [progress, setProgress] = useState<RouteProgress | null>(null);
  const [alert, setAlert] = useState<'left' | 'returned' | null>(null);

  // The buffer lives in a ref and its size is mirrored into state: twenty thousand fixes must
  // not be copied into React state on every tick.
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
  // Held as a promise rather than a boolean so a second caller can await the drain that is
  // running instead of returning without draining. See the note on `flush`.
  const inFlightRef = useRef<Promise<void> | null>(null);
  // `flush`, assigned once it exists below. A ref rather than a dependency because the hydrate
  // effect must run exactly once.
  const flushRef = useRef<() => Promise<void>>(() => Promise.resolve());
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;
  const onStartRef = useRef(onStart);
  onStartRef.current = onStart;
  const routeRef = useRef<readonly LngLat[] | null>(route);
  routeRef.current = route;
  const planRef = useRef<HikePlan | null>(plan);
  planRef.current = plan;
  const offRouteRef = useRef<OffRouteState>(initialOffRouteState());
  // Read inside the fix handler, which is memoised on nothing that changes per fix.
  const progressRef = useRef<RouteProgress | null>(null);
  progressRef.current = progress;

  /**
   * The queue row as it stands, and the chunk currently being filled. The header is held whole
   * rather than rebuilt, so fields the drain owns (`attempts`, `blocked`) survive a hydrate.
   */
  const headerRef = useRef<PendingActivity | null>(null);
  const chunkRef = useRef<{ index: number; fixes: TrackFix[] } | null>(null);
  /** Metres so far, for the storage manager. Mirrored out of the stats memo below. */
  const distanceRef = useRef(0);

  /**
   * One write at a time, and never more than one queued. Two overlapping `put`s of the same
   * chunk key would interleave and lose fixes, so writes are chained rather than parallel;
   * `queued` collapses a burst, since a scheduled write reads the refs when it executes.
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
        // Storage refused. Only the ability to survive a refresh is affected, and the next fix
        // schedules another attempt.
        queuedRef.current = false;
      });
  }, [writeJournal]);

  /**
   * Wait for the journal to catch up with the buffer. Anything that hands the row over must
   * settle first, or a write still in flight lands on top of `onFinish`'s payload and silently
   * un-finishes the hike.
   */
  const settle = useCallback((): Promise<void> => writeChainRef.current.catch(() => undefined), []);

  /** Add a fix to the open chunk, rolling over to a new one when it is full. */
  const journalFix = useCallback(
    (fix: TrackFix) => {
      const chunk = chunkRef.current;
      if (!chunk || chunk.fixes.length >= CHUNK_FIXES) {
        // The chunk that just filled is written here rather than left to `persist`. `persist`
        // collapses a burst on the reasoning that a scheduled write covers everything that
        // arrived since — which holds only while `chunkRef` points at the same chunk. Pushed
        // onto the same chain so it lands before the next `writeJournal` opens the new one.
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
   * Gated on the browser having decided who is here (`readerSettled` / `subscribeToReader`),
   * because `rememberReader` is the last statement of an async `reconcileReader` and this
   * effect otherwise wins the race: `writingReader()` would still name the departing reader,
   * so a purely-offline hike would be left permanently unfinishable — or, worse, the departing
   * reader's live hike would be resumed into the arriving reader's recorder and claimed.
   */
  useEffect(() => {
    let cancelled = false;
    let stopWatchingReader: (() => void) | null = null;

    const hydrate = async (): Promise<void> => {
      await importLegacyJournal().catch(() => undefined);
      // Only this reader's own unfinished hike is picked back up: resuming somebody else's
      // would append this person's afternoon to that person's morning under one name.
      const restored = await readOpenActivity(writingReader()).catch(() => null);
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
      // Paused, not recording: after an interruption the honest thing is to ask the hiker to
      // carry on rather than pretend the gap did not happen.
      setPhase('paused');
      const last = fixes[fixes.length - 1];
      if (last) setPosition([last.lng, last.lat]);

      // One upload now, if there is a connection. `claimLive` tells the drain to leave the row
      // alone on the grounds that the recorder is uploading it — but a restored recording comes
      // back paused, so neither the interval nor the `online` listener would ever fire for it.
      if (typeof navigator !== 'undefined' && navigator.onLine) {
        await flushRef.current().catch(() => undefined);
      }
    };

    if (readerSettled()) {
      void hydrate();
    } else {
      stopWatchingReader = subscribeToReader(() => {
        if (cancelled) return;
        stopWatchingReader?.();
        stopWatchingReader = null;
        void hydrate();
      });
    }

    return () => {
      cancelled = true;
      stopWatchingReader?.();
    };
  }, []);

  // Hand the row back to the drain when this screen goes away. The claim is module-level, so
  // without this it outlives the screen and the row is never sent by anything.
  useEffect(
    () => () => {
      const id = activityIdRef.current;
      if (id) releaseLive(id);
    },
    [],
  );

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
      // One fix a second, at most. A browser firing the watch at 5 Hz would otherwise fill the
      // buffer with duplicates the server's `(activityId, t)` constraint rejects anyway.
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
        // `updateOffRoute` times in milliseconds, unlike `TrackFix.t`, which is seconds since
        // the start. The wrong one makes the watchdog fire after 45 ms or 45,000 seconds.
        const update = updateOffRoute(
          offRouteRef.current,
          { t: Date.now(), lng: longitude, lat: latitude, accuracyM: accuracy ?? null },
          line,
          DEFAULT_OFF_ROUTE_CONFIG,
        );
        offRouteRef.current = update.state;
        setOffRoute(update.state.isOffRoute);
        setOffRouteDistanceM(update.distanceM);
        // No projection means the fix was too vague to trust, so progress holds where it was
        // rather than jumping to a reading the off-route watchdog has already refused.
        const hike = planRef.current;
        if (hike && update.nearest) {
          setProgress(advanceProgress(hike, progressRef.current, update.nearest));
        }
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

  useEffect(() => {
    if (phase !== 'recording' && phase !== 'locating') return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      try {
        sentinel = (await navigator.wakeLock?.request('screen')) ?? null;
      } catch {
        // Denied, unsupported, or the tab is not visible. The recording is unaffected.
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

  /** Fixes the server has not acknowledged, read live rather than off the last render. */
  const outstanding = useCallback((): number => fixesRef.current.length - sentRef.current, []);

  /** Whether the server has been told this recording exists. */
  const announced = useCallback((): boolean => headerRef.current?.serverStarted !== false, []);

  /**
   * Is the browser still acting as the account that pressed start? The recorder is the one
   * uploader that does not go through `flushPendingActivities`, so it has to ask for itself.
   *
   * Read live, never off a render — a recording screen can go a long time without painting.
   * Both `null`s match deliberately, unlike the drain's `ownedBy`: a browser that could not
   * name a session records under `userId: null`, and refusing that pair would stop it
   * recording at all. The moment anybody signs in the two disagree and the hike stops.
   */
  const stillMine = useCallback(
    (): boolean => stillActingAs(headerRef.current?.userId ?? null, writingReader),
    [],
  );

  const drain = useCallback(async (): Promise<void> => {
    const id = activityIdRef.current;
    if (!id) return;
    // Nothing to upload and the server already knows about the recording — but a caller that
    // awaits this is entitled to a settled journal when it returns, and `onFinish` is one.
    if (outstanding() <= 0 && announced()) {
      await settle();
      return;
    }

    // Pinned for the length of this flush so a `begin()` landing mid-drain cannot re-point the
    // question at another hike's owner, and asked again before every request the flush makes:
    // one call empties the whole backlog, which on one bar is tens of seconds to minutes.
    const owner = headerRef.current?.userId ?? null;
    const stillTheirs = (): boolean => stillActingAs(owner, writingReader);

    /**
     * Somebody else is here. A sync state rather than a thrown error, matching `syncOffline`:
     * thrown, it would reach `onFinish`'s catch and be read as a refusal that did not happen.
     */
    const noteHeldForAnother = (): void => {
      setSyncOffline(false);
      setSyncError(
        'Somebody else is signed in. This hike waits on this device until the hiker who ' +
          'recorded it signs back in.',
      );
    };

    setSyncing(true);
    try {
      // Announce the recording first if the server has not heard of it: every `append` would
      // be refused with "No such recording". Safe to replay — the id is the idempotency key —
      // and gated on ownership because `start` *creates* a hike in whoever's account is here.
      const before = headerRef.current;
      if (before && !before.serverStarted) {
        if (!stillTheirs()) {
          noteHeldForAnother();
          return;
        }
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

      // The whole backlog, one batch at a time and strictly in order. Sequential because a
      // connection that has just come back is one bar. The loop re-reads the live buffer, so
      // fixes arriving while it runs are carried by this same call.
      let reannounced = false;
      while (outstanding() > 0) {
        // Before each batch, not once before the loop. `sent` is already written for
        // everything the server acknowledged, so stopping here re-sends nothing.
        if (!stillTheirs()) {
          noteHeldForAnother();
          return;
        }
        const from = sentRef.current;
        const batch = fixesRef.current.slice(from, from + SAMPLE_BATCH);
        try {
          await onFlushRef.current(id, batch);
        } catch (error) {
          // The server has no row under this id: the router's stale sweep *deletes* rather
          // than closes a recording that never received a sample, so `serverStarted` can be
          // true for a row that is gone. Re-announced once, so an unrelated NOT_FOUND cannot spin.
          const header = headerRef.current;
          if (!isMissing(error) || reannounced || !header) throw error;
          // A re-announcement creates a hike like any other, so it gets the same gate.
          if (!stillTheirs()) {
            noteHeldForAnother();
            return;
          }
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
      setSyncing(false);
      await settle();
    }
  }, [announced, outstanding, persist, settle]);

  /**
   * Upload everything outstanding, and do not return until it is up or has failed.
   *
   * A second caller joins the drain that is running rather than skipping past it: resolving
   * immediately let `onFinish` post `finish` while a loop was still uploading, so the
   * still-outstanding batches were refused and then deleted by `forget()` unannounced. A
   * joiner inherits that drain's failure rather than starting a second attempt, then re-checks
   * the buffer, because a fix landing after the loop's last look is still outstanding.
   */
  const flush = useCallback(async (): Promise<void> => {
    for (let joined = inFlightRef.current; joined; joined = inFlightRef.current) {
      await joined;
      if (outstanding() <= 0 && announced()) {
        await settle();
        return;
      }
    }

    const run: Promise<void> = drain().finally(() => {
      if (inFlightRef.current === run) inFlightRef.current = null;
    });
    inFlightRef.current = run;
    return run;
  }, [announced, drain, outstanding, settle]);
  flushRef.current = flush;

  useEffect(() => {
    if (phase !== 'recording') return;
    const timer = window.setInterval(() => {
      void flush().catch(() => undefined);
    }, FLUSH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [phase, flush]);

  // Coming back into signal is the one moment a flush is both possible and overdue, and the
  // timer cannot know about it. Mounted whenever there is a recording at all, not only while
  // `phase === 'recording'`: a journal restored after a reload comes back paused, so guarding
  // on the phase meant neither this nor the interval ever ran for it.
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
      setProgress(null);
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

      // The row exists from the press, not from the server's answer — that is what makes a
      // hike startable with no signal.
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
        // Whose day this is, decided at the press and not at the upload. A hike begun on a
        // ridge can sit on the device for a week, by which time the browser may hold somebody
        // else's session.
        userId: writingReader(),
      });
      claimLive(id);
      persist();
    },
    [persist],
  );

  /**
   * The server has acknowledged this recording; the journal should say so. Written through
   * this hook because the header is rewritten here on every fix, and a write from anywhere
   * else would be clobbered by the next one.
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
    setProgress(null);
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

  const stats = useMemo(
    () => summariseTrack(fixesRef.current),
    // `version` is the buffer's identity; the buffer itself is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );
  // Mirrored into a ref so the journal can carry it without recomputing it: the storage
  // manager needs a distance for a hike it can no longer ask the server about.
  distanceRef.current = stats.distanceM;

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
    progress,
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
    outstanding,
    stillMine,
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
