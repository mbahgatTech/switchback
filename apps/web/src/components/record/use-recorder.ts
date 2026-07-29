'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  MAX_FIX_ACCURACY_M,
  SAMPLE_BATCH,
  type ActivityStats,
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

/**
 * The recording engine: a phone's geolocation stream turned into a hike.
 *
 * Split from the screen because it is a state machine with four things happening at once —
 * a position watch, an upload loop, an off-route watchdog and a crash-recovery journal —
 * and none of them are about layout. The screen reads this hook and draws what it says.
 *
 * **Three rules hold the whole design together.**
 *
 * 1. **The buffer in memory is the truth while hiking; the server is the truth after.**
 *    Fixes accumulate locally, are flushed in batches, and are never removed from the local
 *    buffer once sent — so a failed upload is a retry, not a hole. Every statistic on screen
 *    is computed from the local buffer with the same `summariseTrack` the server runs, so
 *    the number you watch tick over is the number you get at the end.
 * 2. **Nothing waits for the end.** A batch goes up roughly every minute. Close the tab on
 *    the summit and what is stored is a shorter hike, not a lost one.
 * 3. **The journal survives a refresh.** `localStorage` holds the activity id, the start
 *    time, and every fix. A reload mid-hike picks the recording back up rather than
 *    orphaning it — and the recording comes back *paused*, because the honest thing to say
 *    after an interruption is "you were recording; carry on?" rather than pretending the
 *    gap did not happen.
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

interface Journal {
  v: number;
  id: string;
  /** Epoch milliseconds. Every fix's `t` is seconds after this. */
  startedAt: number;
  trailId: string | null;
  fixes: TrackFix[];
  /** How many of `fixes`, from the front, the server has acknowledged. */
  sent: number;
}

function readJournal(): Journal | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(JOURNAL_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Journal;
    if (parsed.v !== JOURNAL_VERSION || typeof parsed.id !== 'string') return null;
    if (!Array.isArray(parsed.fixes)) return null;
    return parsed;
  } catch {
    // A corrupt journal is worse than none: it would put the recorder into a state whose
    // activity id may not exist. Drop it and start clean.
    return null;
  }
}

function clearJournal(): void {
  try {
    window.localStorage.removeItem(JOURNAL_KEY);
  } catch {
    /* Private mode, quota, a locked profile. None of them are worth failing a hike over. */
  }
}

export interface StartArgs {
  id: string;
  startedAt: Date;
  trailId: string | null;
  /** Fixes already on the server, when adopting a recording started elsewhere. */
  resumed?: boolean;
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
  pause: () => void;
  resume: () => void;
  /** Flush anything outstanding. Resolves when the server has it, or throws. */
  flush: () => Promise<void>;
  stop: () => void;
  /** Wipe the local journal without touching the server. */
  forget: () => void;
}

export interface RecorderOptions {
  /** Uploads a batch. Resolves with what the server kept. */
  onFlush: (id: string, fixes: TrackFix[]) => Promise<unknown>;
  /** The route being followed, if any. Enables the off-route watchdog. */
  route: readonly LngLat[] | null;
  /** Total route length, for the distance-to-finish readout. */
  routeLengthM: number | null;
}

export function useRecorder({ onFlush, route, routeLengthM }: RecorderOptions): RecorderApi {
  const [phase, setPhase] = useState<RecorderPhase>('idle');
  const [activityId, setActivityId] = useState<string | null>(null);
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [trailId, setTrailId] = useState<string | null>(null);
  const [position, setPosition] = useState<LngLat | null>(null);
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  const [weakSignal, setWeakSignal] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
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
  const onFlushRef = useRef(onFlush);
  onFlushRef.current = onFlush;
  const routeRef = useRef<readonly LngLat[] | null>(route);
  routeRef.current = route;
  const offRouteRef = useRef<OffRouteState>(initialOffRouteState());

  // -------------------------------------------------------------------------
  // Journal
  // -------------------------------------------------------------------------

  const persist = useCallback(() => {
    const id = activityIdRef.current;
    const start = startedAtRef.current;
    if (!id || !start) return;
    try {
      const journal: Journal = {
        v: JOURNAL_VERSION,
        id,
        startedAt: start.getTime(),
        trailId: trailIdRef.current,
        fixes: fixesRef.current,
        sent: sentRef.current,
      };
      window.localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
    } catch {
      // Quota, most likely, on a very long hike in a browser with a small budget. The
      // recording is unaffected — only its ability to survive a refresh is.
    }
  }, []);

  /** Adopt whatever the last session left behind. Runs once, before anything else can. */
  useEffect(() => {
    const journal = readJournal();
    if (!journal) return;
    fixesRef.current = journal.fixes;
    sentRef.current = Math.min(journal.sent, journal.fixes.length);
    setActivityId(journal.id);
    setStartedAt(new Date(journal.startedAt));
    setTrailId(journal.trailId);
    setVersion((n) => n + 1);
    // Paused, not recording: see the note at the top of the file.
    setPhase('paused');
    const last = journal.fixes[journal.fixes.length - 1];
    if (last) setPosition([last.lng, last.lat]);
  }, []);

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
      persist();

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
    [persist],
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
    if (outstanding <= 0) return;

    flushingRef.current = true;
    setSyncing(true);
    try {
      // One batch per call, largest first. Draining the whole backlog in a loop would turn
      // a reconnection after an hour of no signal into sixty simultaneous requests.
      while (fixesRef.current.length - sentRef.current > 0) {
        const from = sentRef.current;
        const batch = fixesRef.current.slice(from, from + SAMPLE_BATCH);
        await onFlushRef.current(id, batch);
        sentRef.current = from + batch.length;
        persist();
      }
      setLastSyncAt(new Date());
      setSyncError(null);
    } catch (err) {
      // Left in the buffer, so the next flush retries it. `sent` only ever advances past
      // fixes the server has acknowledged.
      setSyncError(err instanceof Error ? err.message : 'Could not save the last few minutes.');
      throw err;
    } finally {
      flushingRef.current = false;
      setSyncing(false);
    }
  }, [persist]);

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
  useEffect(() => {
    if (phase !== 'recording') return;
    const onOnline = (): void => {
      void flush().catch(() => undefined);
    };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [phase, flush]);

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
    ({ id, startedAt: at, trailId: trail, resumed }: StartArgs) => {
      if (!resumed) {
        fixesRef.current = [];
        sentRef.current = 0;
      }
      offRouteRef.current = initialOffRouteState();
      setActivityId(id);
      setStartedAt(at);
      setTrailId(trail);
      setSyncError(null);
      setGeoError(null);
      setAlert(null);
      setVersion((n) => n + 1);
      setPhase('locating');
      activityIdRef.current = id;
      startedAtRef.current = at;
      trailIdRef.current = trail;
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

  const forget = useCallback(() => {
    clearJournal();
    fixesRef.current = [];
    sentRef.current = 0;
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
    setLastSyncAt(null);
    setVersion((n) => n + 1);
    setPhase('idle');
  }, []);

  // -------------------------------------------------------------------------
  // Derived
  // -------------------------------------------------------------------------

  const stats = useMemo(
    () => summariseTrack(fixesRef.current),
    // `version` is the buffer's identity; the buffer itself is a stable ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

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
    offRoute,
    offRouteDistanceM,
    remainingM,
    alert,
    dismissAlert: useCallback(() => setAlert(null), []),
    activityId,
    startedAt,
    trailId,
    begin,
    pause,
    resume,
    flush,
    stop,
    forget,
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
