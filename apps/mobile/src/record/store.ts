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
import {
  isTrackingInBackground,
  setFixSink,
  startBackgroundUpdates,
  stopBackgroundUpdates,
} from '@/record/background';
import {
  JOURNAL_VERSION,
  decodeFixes,
  decodeHead,
  encodeFixes,
  encodeHead,
  restoredPhase,
  type JournalHead,
} from '@/record/journal';

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
 * 3. The journal survives a crash (files, not `localStorage`) and every fix reaches it as it
 *    arrives, so a kill costs the last second rather than the hike.
 *
 * Fixes come from `@/record/background` where the host allows it, which is what keeps a hike
 * running with the screen off and the phone in a pocket. Where it does not — Expo Go has no
 * `location` background mode — the foreground watcher below is the fallback, the screen is held
 * awake, and the Record screen says which of the two is in force.
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
  /**
   * Where fixes are coming from. `background` survives the screen going off; `foreground` is the
   * fallback for a host with no background location capability and stops when the app does.
   */
  tracking: 'background' | 'foreground' | null;
  /**
   * Recording without the "Always" authorization iOS needs to relaunch a terminated app. The
   * screen keeps running either way — this only means the OS reclaiming memory ends the hike.
   */
  mayNotSurviveTermination: boolean;
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

const JOURNAL_DIR = 'recording-v2';
const HEAD_NAME = 'head.json';
const FIXES_NAME = 'fixes.ndjson';
const KEEP_AWAKE_TAG = 'switchback-recording';

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
let tracking: 'background' | 'foreground' | null = null;
/** Whether iOS may relaunch this app to keep feeding the recording. See `BackgroundStart`. */
let survivesTermination = false;
/**
 * Whether the hike is meant to be running. Written into the journal head, and the only thing that
 * lets a relaunch tell a hike somebody paused from one the OS interrupted.
 */
let live = false;
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
    tracking,
    mayNotSurviveTermination: tracking === 'background' && !survivesTermination,
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

function journalDir(): FileSystem.Directory {
  return new FileSystem.Directory(FileSystem.Paths.document, JOURNAL_DIR);
}

function headFile(): FileSystem.File {
  return new FileSystem.File(journalDir(), HEAD_NAME);
}

function fixesFile(): FileSystem.File {
  return new FileSystem.File(journalDir(), FIXES_NAME);
}

/**
 * Everything about the recording except its fixes. Rewritten whenever one of those things
 * changes, which is a few times a hike rather than once a second.
 */
function writeHead(): void {
  if (!activityId || !startedAt) return;
  const head: JournalHead = {
    v: JOURNAL_VERSION,
    id: activityId,
    startedAt: startedAt.getTime(),
    trailId,
    routeId,
    sent,
    live,
  };
  try {
    headFile().write(encodeHead(head));
  } catch {
    // A full disk, most likely. Only the ability to survive a crash is affected, and saying so
    // mid-hike is worse than carrying on.
  }
}

/** One line on the end of the track. Costs the same on the last fix of a hike as on the first. */
function appendFix(fix: TrackFix): void {
  try {
    fixesFile().write(encodeFixes([fix]), { append: true });
  } catch {
    /* As above: durability degrades, the hike does not stop. */
  }
}

/** A directory with an empty track in it, replacing whatever the last hike left. */
function openJournal(): void {
  try {
    clearJournal();
    journalDir().create({ intermediates: true });
    fixesFile().create();
  } catch {
    /* As above. */
  }
  writeHead();
}

function clearJournal(): void {
  try {
    const dir = journalDir();
    if (dir.exists) dir.delete();
  } catch {
    /* Nothing to do about it, and nothing depends on it. */
  }
}

/**
 * Adopt whatever the last run left behind. Safe to call repeatedly — the app root calls it
 * on mount, and a remount after a fast refresh must not wipe a hike in progress.
 *
 * Restores paused, then promotes to recording if the OS turns out to still hold the location
 * task. That order matters: the promotion is asynchronous, and a launch that claimed to be
 * recording before it had asked would be claiming a fix it does not have.
 */
export function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  let head: JournalHead | null = null;
  let stored: TrackFix[] = [];
  try {
    const file = headFile();
    if (!file.exists) return;
    head = decodeHead(file.textSync());
    const trackFile = fixesFile();
    if (head && trackFile.exists) stored = decodeFixes(trackFile.textSync());
  } catch {
    return;
  }
  if (!head) {
    // A corrupt head is worse than none — its activity id may not exist on the server.
    clearJournal();
    return;
  }
  fixes = stored;
  sent = Math.min(head.sent, stored.length);
  activityId = head.id;
  startedAt = new Date(head.startedAt);
  trailId = head.trailId;
  routeId = head.routeId;
  live = head.live;
  statsCache = summariseTrack(fixes);
  const last = fixes[fixes.length - 1];
  if (last) position = [last.lng, last.lat];
  elapsedS = Math.max(0, Math.round((Date.now() - head.startedAt) / 1000));
  phase = 'paused';
  emit();
  void promoteIfStillTracking(head);
}

/**
 * A hike iOS kept alive through a relaunch, resumed without asking. `restoredPhase` is what
 * separates that from a crash or a force-quit, after which the honest thing is to come back
 * paused — the track has a hole in it either way, and only the user can say whether to carry on.
 */
async function promoteIfStillTracking(head: JournalHead): Promise<void> {
  const still = await isTrackingInBackground();
  if (restoredPhase(head, still) !== 'recording') return;
  if (phase !== 'paused' || activityId !== head.id) return;
  tracking = 'background';
  phase = 'locating';
  startClock();
  emit();
}

/**
 * Readings from the OS. They arrive in the foreground, with the screen off, and in an app iOS
 * relaunched headless with no screen mounted at all — so the journal is adopted here rather than
 * assumed, and a reading is taken as proof the task is alive, which is what makes the promotion
 * above a nicety rather than something correctness depends on.
 */
function onReadings(readings: readonly Location.LocationObject[]): void {
  hydrate();
  if (!activityId) {
    // An orphaned task: the OS is tracking for a hike this device no longer holds. Stop it
    // rather than keep taking positions nothing will ever use.
    void stopBackgroundUpdates();
    return;
  }
  if (live && phase === 'paused') {
    tracking = 'background';
    phase = 'locating';
    startClock();
  }
  for (const reading of readings) pushFix(reading);
}

setFixSink(onReadings);

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
  const written = fixes[fixes.length - 1];
  if (written) appendFix(written);

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
  if (tracking) return;
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      geoError = permission.canAskAgain
        ? 'Location access is needed to record a hike.'
        : 'Location access is blocked. Allow it for Switchback in Settings.';
      phase = 'paused';
      live = false;
      writeHead();
      emit();
      return;
    }
  } catch {
    geoError = 'Could not ask for location access.';
    phase = 'paused';
    live = false;
    writeHead();
    emit();
    return;
  }

  // The OS first. This is the only source that keeps delivering once iOS suspends the runtime,
  // and it makes the screen's own state irrelevant to whether a hike is being recorded.
  const start = await startBackgroundUpdates();
  if (start.started) {
    tracking = 'background';
    survivesTermination = start.survivesTermination;
    emit();
    return;
  }

  tracking = 'foreground';
  survivesTermination = false;
  // Nothing else is keeping this hike alive now, so the screen cannot be allowed to sleep. Held
  // only in the fallback: in background mode the point is that the phone may do as it likes.
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
  }
  emit();
}

function stopWatch(): void {
  watch?.remove();
  watch = null;
  void stopBackgroundUpdates();
  tracking = null;
  survivesTermination = false;
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
      writeHead();
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
  live = true;
  openJournal();
  emit();
  startClock();
  void startWatch();
}

export function pause(): void {
  if (phase !== 'recording' && phase !== 'locating') return;
  phase = 'paused';
  // Before the OS subscription goes, so a launch after this one restores paused rather than
  // resuming a hike the user had stopped.
  live = false;
  writeHead();
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
  live = true;
  writeHead();
  emit();
  startClock();
  void startWatch();
}

/** Moves to `saving`. The screen calls `activities.finish` and then `forget`. */
export function stop(): void {
  phase = 'saving';
  live = false;
  writeHead();
  stopWatch();
  stopFlushLoop();
  stopClock();
  emit();
}

/** Wipe the local journal without touching the server. */
export function forget(): void {
  live = false;
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
