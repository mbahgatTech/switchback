import { useCallback, useSyncExternalStore } from 'react';
import * as FileSystem from 'expo-file-system';
import * as Haptics from 'expo-haptics';
import * as KeepAwake from 'expo-keep-awake';
import * as Location from 'expo-location';
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
 * The recording engine, at module scope rather than in a hook: a recorder living in the Record
 * screen's state would end the hike the first time somebody switched tabs. React subscribes.
 *
 * The rules are the web recorder's, and deliberately identical — both call `summariseTrack` and
 * the same off-route watchdog out of `@switchback/geo`, so the two clients compute the same
 * numbers from the same fixes. See `apps/web/src/components/record/use-recorder.ts`.
 *
 * 1. The buffer on the device is the truth while hiking; fixes are never removed once sent, so
 *    a failed upload is a retry and not a hole.
 * 2. Nothing waits for the end — a batch goes up about every minute.
 * 3. The journal survives a crash (a file, not `localStorage`) and the recording comes back
 *    **paused**, because the honest thing after an interruption is to ask.
 *
 * Expo Go carries no background-location task registration, so recording only runs in the
 * foreground and the screen is held awake for the duration. A development build lifts that
 * without changing anything here: `expo-task-manager` would feed the same `pushFix`.
 */

export type RecorderPhase = 'idle' | 'locating' | 'recording' | 'paused' | 'saving';

export interface RecorderSnapshot {
  phase: RecorderPhase;
  activityId: string | null;
  startedAt: Date | null;
  trailId: string | null;
  /**
   * The planned route being hiked, if the hike was started from one. Never set alongside
   * `trailId`, and unknown to the server — `activities.start` takes no route, so this is the
   * device's own note about what the wrong-turn watchdog is watching.
   */
  routeId: string | null;
  /** Seconds of wall clock since the hike began, ticking while it runs. */
  elapsedS: number;
  fixes: readonly TrackFix[];
  stats: ActivityStats;
  position: LngLat | null;
  accuracyM: number | null;
  weakSignal: boolean;
  /** Fixes recorded but not yet acknowledged by the server. */
  pending: number;
  lastSyncAt: Date | null;
  syncing: boolean;
  geoError: string | null;
  syncError: string | null;
  offRoute: boolean;
  offRouteDistanceM: number | null;
  remainingM: number | null;
  alert: 'left' | 'returned' | null;
}

/** Uploads one batch. Set once at the app root, where the tRPC client lives. */
export type Uploader = (activityId: string, fixes: TrackFix[]) => Promise<unknown>;

/** One reading, with the moment it arrived. See `latestFix`. */
export interface RecordedFix {
  /** `Date.now()` when the watch reported it, not seconds-since-start like `TrackFix.t`. */
  at: number;
  lng: number;
  lat: number;
  eleM: number | null;
}

export const FLUSH_INTERVAL_MS = 60_000;

const JOURNAL_NAME = 'recording-v1.json';
const JOURNAL_VERSION = 1;
const KEEP_AWAKE_TAG = 'switchback-recording';

interface Journal {
  v: number;
  id: string;
  startedAt: number;
  trailId: string | null;
  /**
   * Optional on read, always written. A journal from before planned routes existed restores as
   * `null`, so no version bump is needed — and a bump would throw that hike away, which is the
   * one thing a crash journal exists to prevent.
   */
  routeId: string | null;
  fixes: TrackFix[];
  sent: number;
}

const listeners = new Set<() => void>();

let phase: RecorderPhase = 'idle';
let activityId: string | null = null;
let startedAt: Date | null = null;
let trailId: string | null = null;
let routeId: string | null = null;
let fixes: TrackFix[] = [];
let sent = 0;
let position: LngLat | null = null;
/** When `position` arrived, and the elevation that came with it. Only `latestFix` reads them. */
let positionAt: number | null = null;
let positionEleM: number | null = null;
let accuracyM: number | null = null;
let weakSignal = false;
let lastSyncAt: Date | null = null;
let syncing = false;
let geoError: string | null = null;
let syncError: string | null = null;
let offRouteState: OffRouteState = initialOffRouteState();
let offRoute = false;
let offRouteDistanceM: number | null = null;
let alongM: number | null = null;
let alert: 'left' | 'returned' | null = null;
let elapsedS = 0;

/** The route being followed, if any. Drives the watchdog and the distance-to-finish. */
let route: readonly LngLat[] | null = null;
let routeLengthM: number | null = null;

let uploader: Uploader | null = null;
let watch: Location.LocationSubscription | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let hydrated = false;

/**
 * `summariseTrack` walks the whole buffer, so it is computed once per emit rather than once per
 * reader — on a six-hour hike that is ~20,000 fixes times four subscribers, every second.
 */
let statsCache: ActivityStats = summariseTrack([]);
let snapshot: RecorderSnapshot = build();

function build(): RecorderSnapshot {
  return {
    phase,
    activityId,
    startedAt,
    trailId,
    routeId,
    elapsedS,
    fixes,
    stats: statsCache,
    position,
    accuracyM,
    weakSignal,
    pending: fixes.length - sent,
    lastSyncAt,
    syncing,
    geoError,
    syncError,
    offRoute,
    offRouteDistanceM,
    remainingM:
      routeLengthM == null || alongM == null ? null : remainingDistanceM(routeLengthM, alongM),
    alert,
  };
}

function emit(): void {
  snapshot = build();
  refreshHike();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): RecorderSnapshot {
  return snapshot;
}

/** The whole recorder. Re-renders once a second while a hike runs. */
export function useRecording(): RecorderSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export interface ActiveHike {
  /** Elapsed, formatted for a label: `12:04`, or `1:12:04` past the hour. */
  clock: string;
  paused: boolean;
}

/**
 * A separate, narrower snapshot so the tab bar re-renders when the clock changes and not
 * when a fix lands. `useSyncExternalStore` compares with `Object.is`, so this has to be one
 * cached object that is only replaced when something in it actually differs.
 */
let hike: ActiveHike | null = null;

function refreshHike(): void {
  const running = phase === 'locating' || phase === 'recording' || phase === 'paused';
  if (!running) {
    hike = null;
    return;
  }
  const clock = formatClock(elapsedS);
  const paused = phase === 'paused';
  if (hike && hike.clock === clock && hike.paused === paused) return;
  hike = { clock, paused };
}

function getHike(): ActiveHike | null {
  return hike;
}

export function useActiveHike(): ActiveHike | null {
  return useSyncExternalStore(subscribe, getHike, getHike);
}

export function formatClock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = whole % 60;
  const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function journalFile(): FileSystem.File {
  return new FileSystem.File(FileSystem.Paths.document, JOURNAL_NAME);
}

function persist(): void {
  if (!activityId || !startedAt) return;
  try {
    const journal: Journal = {
      v: JOURNAL_VERSION,
      id: activityId,
      startedAt: startedAt.getTime(),
      trailId,
      routeId,
      fixes,
      sent,
    };
    const file = journalFile();
    if (!file.exists) file.create({ intermediates: true });
    file.write(JSON.stringify(journal));
  } catch {
    // A full disk, most likely. Only the ability to survive a crash is affected, and saying so
    // mid-hike is worse than carrying on.
  }
}

function clearJournal(): void {
  try {
    const file = journalFile();
    if (file.exists) file.delete();
  } catch {
    /* Nothing to do about it, and nothing depends on it. */
  }
}

function parseJournal(raw: string): Journal | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (record.v !== JOURNAL_VERSION) return null;
    if (typeof record.id !== 'string' || typeof record.startedAt !== 'number') return null;
    if (!Array.isArray(record.fixes)) return null;
    return {
      v: JOURNAL_VERSION,
      id: record.id,
      startedAt: record.startedAt,
      trailId: typeof record.trailId === 'string' ? record.trailId : null,
      routeId: typeof record.routeId === 'string' ? record.routeId : null,
      fixes: record.fixes as TrackFix[],
      sent: typeof record.sent === 'number' ? record.sent : 0,
    };
  } catch {
    // A corrupt journal is worse than none — its activity id may not exist on the server.
    return null;
  }
}

/**
 * Adopt whatever the last run left behind. Safe to call repeatedly — the app root calls it
 * on mount, and a remount after a fast refresh must not wipe a hike in progress.
 */
export function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  let raw: string;
  try {
    const file = journalFile();
    if (!file.exists) return;
    raw = file.textSync();
  } catch {
    return;
  }
  const journal = parseJournal(raw);
  if (!journal) {
    clearJournal();
    return;
  }
  fixes = journal.fixes;
  sent = Math.min(journal.sent, journal.fixes.length);
  activityId = journal.id;
  startedAt = new Date(journal.startedAt);
  trailId = journal.trailId;
  routeId = journal.routeId;
  statsCache = summariseTrack(fixes);
  const last = fixes[fixes.length - 1];
  if (last) position = [last.lng, last.lat];
  elapsedS = Math.max(0, Math.round((Date.now() - journal.startedAt) / 1000));
  // Paused, not recording. See the note at the top of the file.
  phase = 'paused';
  emit();
}

function pushFix(reading: Location.LocationObject): void {
  if (!startedAt) return;
  const { longitude, latitude, altitude, accuracy, speed } = reading.coords;
  position = [longitude, latitude];
  positionAt = Date.now();
  positionEleM = altitude != null && Number.isFinite(altitude) ? altitude : null;
  accuracyM = accuracy ?? null;
  geoError = null;

  const usable = accuracy == null || accuracy <= MAX_FIX_ACCURACY_M;
  weakSignal = !usable;
  // The first fix good enough to trust is what turns "locating" into "recording".
  if (phase === 'locating' && usable) {
    phase = 'recording';
    startFlushLoop();
  }
  if (phase !== 'recording') {
    emit();
    return;
  }
  if (!usable) {
    emit();
    return;
  }

  const t = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));
  const previous = fixes[fixes.length - 1];
  // One fix a second, at most. The server's `(activityId, t)` constraint would reject the
  // duplicates anyway; not sending them is cheaper than being rejected.
  if (previous && t <= previous.t) {
    emit();
    return;
  }

  fixes.push({
    t,
    lng: longitude,
    lat: latitude,
    eleM: altitude != null && Number.isFinite(altitude) ? altitude : null,
    accuracyM: accuracy ?? null,
    speedMps: speed != null && speed >= 0 ? speed : null,
  });
  statsCache = summariseTrack(fixes);
  elapsedS = t;
  persist();

  if (route && route.length >= 2) {
    // `updateOffRoute` measures its own timings in milliseconds, unlike `TrackFix.t` which is
    // seconds since the start. The wrong one fires the watchdog after 45 ms or 45,000 seconds.
    const update = updateOffRoute(
      offRouteState,
      { t: Date.now(), lng: longitude, lat: latitude, accuracyM: accuracy ?? null },
      route,
      DEFAULT_OFF_ROUTE_CONFIG,
    );
    offRouteState = update.state;
    offRoute = update.state.isOffRoute;
    offRouteDistanceM = update.distanceM;
    alongM = update.alongM;
    if (update.shouldAlert) {
      alert = 'left';
      void buzz('left');
    } else if (update.didReturn) {
      alert = 'returned';
      void buzz('returned');
    }
  }

  emit();
  // A full batch does not wait for the timer. At 1 Hz the two coincide; on a device
  // reporting faster, this is what keeps the backlog from growing without bound.
  if (fixes.length - sent >= SAMPLE_BATCH) void flush().catch(() => undefined);
}

async function startWatch(): Promise<void> {
  if (watch) return;
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      geoError = permission.canAskAgain
        ? 'Location access is needed to record a hike.'
        : 'Location access is blocked. Allow it for Switchback in Settings.';
      phase = 'paused';
      emit();
      return;
    }
  } catch {
    geoError = 'Could not ask for location access.';
    phase = 'paused';
    emit();
    return;
  }

  // The screen stays on for the duration. Without background location this is the only thing
  // keeping the hike being recorded, and the Record screen says so.
  void KeepAwake.activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => undefined);

  try {
    watch = await Location.watchPositionAsync(
      {
        accuracy: Location.Accuracy.BestForNavigation,
        // One a second, and never a cached one: on a hike a fix from five minutes ago is a
        // wrong answer dressed as a right one.
        timeInterval: 1000,
        distanceInterval: 0,
        mayShowUserSettingsDialog: true,
      },
      pushFix,
    );
  } catch {
    geoError = 'No position yet. This usually means no clear view of the sky.';
    emit();
  }
}

function stopWatch(): void {
  watch?.remove();
  watch = null;
  void KeepAwake.deactivateKeepAwake(KEEP_AWAKE_TAG);
}

/**
 * The recorder's latest reading, stamped, or nothing. Exported for the Lifeline, which reuses a
 * fix the warm radio has already paid for; the stamp is what makes that safe, since a Lifeline
 * must never send an old fix and only the caller can judge how old is too old.
 *
 * Null between hikes and immediately after a crash is recovered: the journal restores the last
 * position but not a claim about when it was true. See `freshFix` in `@/record/lifeline`.
 */
export function latestFix(): RecordedFix | null {
  if (!position || positionAt == null) return null;
  return { at: positionAt, lng: position[0], lat: position[1], eleM: positionEleM };
}

async function buzz(kind: 'left' | 'returned'): Promise<void> {
  try {
    await Haptics.notificationAsync(
      kind === 'left'
        ? Haptics.NotificationFeedbackType.Warning
        : Haptics.NotificationFeedbackType.Success,
    );
  } catch {
    /* A simulator, or a device with haptics off. */
  }
}

/** Set once, at the app root, where the tRPC client already exists. */
export function setUploader(next: Uploader | null): void {
  uploader = next;
}

export async function flush(): Promise<void> {
  if (!activityId || !uploader || flushing) return;
  if (fixes.length - sent <= 0) return;

  flushing = true;
  syncing = true;
  emit();
  try {
    // One batch per call, oldest first: draining the whole backlog in a loop would turn a
    // reconnection after an hour of no signal into sixty simultaneous requests.
    while (fixes.length - sent > 0) {
      const from = sent;
      const batch = fixes.slice(from, from + SAMPLE_BATCH);
      await uploader(activityId, batch);
      sent = from + batch.length;
      persist();
    }
    lastSyncAt = new Date();
    syncError = null;
  } catch (cause) {
    // Left in the buffer for the next flush. `sent` only ever advances past acknowledged fixes.
    syncError = cause instanceof Error ? cause.message : 'Could not save the last few minutes.';
    throw cause;
  } finally {
    flushing = false;
    syncing = false;
    emit();
  }
}

function startFlushLoop(): void {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    void flush().catch(() => undefined);
  }, FLUSH_INTERVAL_MS);
}

function stopFlushLoop(): void {
  if (!flushTimer) return;
  clearInterval(flushTimer);
  flushTimer = null;
}

function startClock(): void {
  if (clockTimer) return;
  clockTimer = setInterval(() => {
    if (!startedAt) return;
    elapsedS = Math.max(0, Math.round((Date.now() - startedAt.getTime()) / 1000));
    emit();
  }, 1000);
}

function stopClock(): void {
  if (!clockTimer) return;
  clearInterval(clockTimer);
  clockTimer = null;
}

export interface BeginArgs {
  id: string;
  startedAt: Date;
  trailId: string | null;
  /** A planned route, when the hike was started from one. Never set alongside `trailId`. */
  routeId?: string | null;
}

export function begin({
  id,
  startedAt: at,
  trailId: trail,
  routeId: plan = null,
}: BeginArgs): void {
  fixes = [];
  sent = 0;
  statsCache = summariseTrack(fixes);
  offRouteState = initialOffRouteState();
  offRoute = false;
  offRouteDistanceM = null;
  alongM = null;
  activityId = id;
  startedAt = at;
  trailId = trail;
  routeId = plan;
  syncError = null;
  geoError = null;
  alert = null;
  elapsedS = 0;
  phase = 'locating';
  persist();
  emit();
  startClock();
  void startWatch();
}

export function pause(): void {
  if (phase !== 'recording' && phase !== 'locating') return;
  phase = 'paused';
  stopWatch();
  stopFlushLoop();
  stopClock();
  emit();
  void flush().catch(() => undefined);
}

export function resume(): void {
  if (phase !== 'paused') return;
  phase = 'locating';
  geoError = null;
  emit();
  startClock();
  void startWatch();
}

/** Moves to `saving`. The screen calls `activities.finish` and then `forget`. */
export function stop(): void {
  phase = 'saving';
  stopWatch();
  stopFlushLoop();
  stopClock();
  emit();
}

/** Wipe the local journal without touching the server. */
export function forget(): void {
  clearJournal();
  stopWatch();
  stopFlushLoop();
  stopClock();
  fixes = [];
  sent = 0;
  statsCache = summariseTrack(fixes);
  offRouteState = initialOffRouteState();
  activityId = null;
  startedAt = null;
  trailId = null;
  routeId = null;
  position = null;
  positionAt = null;
  positionEleM = null;
  accuracyM = null;
  weakSignal = false;
  offRoute = false;
  offRouteDistanceM = null;
  alongM = null;
  alert = null;
  syncError = null;
  lastSyncAt = null;
  elapsedS = 0;
  route = null;
  routeLengthM = null;
  phase = 'idle';
  emit();
}

export function dismissAlert(): void {
  if (alert === null) return;
  alert = null;
  emit();
}

/** The route to follow, for the off-route watchdog and the distance-to-finish readout. */
export function setFollowing(line: readonly LngLat[] | null, lengthM: number | null): void {
  route = line;
  routeLengthM = lengthM;
  if (!line) {
    offRouteState = initialOffRouteState();
    offRoute = false;
    offRouteDistanceM = null;
    alongM = null;
  }
  emit();
}

/** Stable action handles, so a screen can depend on them without re-subscribing. */
export function useRecorderActions() {
  return {
    begin: useCallback(begin, []),
    pause: useCallback(pause, []),
    resume: useCallback(resume, []),
    stop: useCallback(stop, []),
    forget: useCallback(forget, []),
    flush: useCallback(flush, []),
    dismissAlert: useCallback(dismissAlert, []),
    setFollowing: useCallback(setFollowing, []),
  };
}
