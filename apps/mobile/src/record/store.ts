import { useCallback, useSyncExternalStore } from 'react';
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
  accumulatedStats,
  advanceTrackStats,
  initialOffRouteState,
  initialTrackStats,
  remainingDistanceM,
  updateOffRoute,
  type OffRouteState,
  type TrackStatsState,
} from '@switchback/geo';
import {
  hasAlwaysAuthorization,
  isTrackingInBackground,
  setBackgroundHandlers,
  startBackgroundUpdates,
  stopBackgroundUpdates,
} from './background';
import { fileJournalStore } from './journal-files';
import {
  JOURNAL_VERSION,
  decodeFixes,
  decodeHead,
  encodeFixes,
  encodeHead,
  ownerVerdict,
  restoredPhase,
  type JournalHead,
  type JournalStore,
} from './journal';

/**
 * The recording engine, at module scope rather than in a hook: a recorder living in the Record
 * screen's state would end the hike the first time somebody switched tabs. React subscribes.
 *
 * The rules are the web recorder's, and deliberately identical — both compute their numbers with
 * `@switchback/geo` and the same off-route watchdog, so the two clients and the server agree.
 * See `apps/web/src/components/record/use-recorder.ts`.
 *
 * 1. The buffer on the device is the truth while hiking; fixes are never removed once sent, so
 *    a failed upload is a retry and not a hole.
 * 2. Nothing waits for the end — a batch goes up about every minute.
 * 3. Every fix reaches the journal as it arrives and the head is renamed into place, so a kill
 *    costs the last second rather than the hike.
 * 4. A journal is readable only by the identity that made it, and erased for any other.
 *
 * Fixes come from `@/record/background` where the host allows it, which is what keeps a hike
 * running with the screen off. Where it does not — Expo Go has no `location` background mode —
 * the foreground watcher below is the fallback, the screen is held awake, and the Record screen
 * says which of the two is in force.
 *
 * Three things follow from fixes arriving from the OS rather than from a live screen, and each
 * was a defect before it was a rule: readings arrive in **batches** and every one carries its own
 * timestamp; `n` is bounded by the length of the hike rather than by screen-on time, so nothing
 * per-fix may be O(n); and the process outlives the session, so the identity is checked rather
 * than assumed.
 */

export type RecorderPhase = 'idle' | 'locating' | 'recording' | 'paused' | 'saving';

/** How fixes are arriving. `null` between hikes, and while a start is still being negotiated. */
export type TrackingSource = 'background' | 'foreground' | null;

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
  tracking: TrackingSource;
  /**
   * Recording without the "Always" authorization iOS needs to relaunch a terminated app. The
   * track keeps being written either way — this only means the OS reclaiming memory ends the hike.
   */
  mayNotSurviveTermination: boolean;
}

/**
 * What the recorder is actually doing, as a tag rather than as prose.
 *
 * A tag, and computed here, because the screen once told a paused hike it was recording: the
 * mapping had three arms for a four-state domain and the missing one fell through to the most
 * reassuring sentence. A closed union computed from the store's own state is what makes the
 * fourth case impossible to leave out.
 */
export type TrackingNote =
  'background-durable' | 'background-fragile' | 'foreground' | 'not-tracking';

export function trackingNote(snapshot: RecorderSnapshot): TrackingNote {
  if (snapshot.tracking === null) return 'not-tracking';
  if (snapshot.tracking === 'foreground') return 'foreground';
  return snapshot.mayNotSurviveTermination ? 'background-fragile' : 'background-durable';
}

/** Uploads one batch. Set once at the app root, where the tRPC client lives. */
export type Uploader = (activityId: string, fixes: TrackFix[]) => Promise<unknown>;

/** One reading, with the moment the phone was there. See `latestFix`. */
export interface RecordedFix {
  /** The reading's own timestamp, not seconds-since-start like `TrackFix.t`. */
  at: number;
  lng: number;
  lat: number;
  eleM: number | null;
}

export const FLUSH_INTERVAL_MS = 60_000;

const KEEP_AWAKE_TAG = 'switchback-recording';

/** A reading stamped this far ahead of now is a clock the device cannot be trusted about. */
const MAX_CLOCK_SKEW_MS = 60_000;

const listeners = new Set<() => void>();

let phase: RecorderPhase = 'idle';
let activityId: string | null = null;
let startedAt: Date | null = null;
let trailId: string | null = null;
let routeId: string | null = null;
let ownerId: string | null = null;
let fixes: TrackFix[] = [];
let sent = 0;
let position: LngLat | null = null;
/** When `position` was true, and the elevation that came with it. Only `latestFix` reads them. */
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
let tracking: TrackingSource = null;
let survivesTermination = true;
/**
 * Whether the hike is meant to be running. Written into the journal head, and the only thing that
 * lets a relaunch tell a hike somebody paused from one the OS interrupted.
 */
let live = false;
let flushTimer: ReturnType<typeof setInterval> | null = null;
let clockTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;
let hydrated = false;
/** Who the app currently believes is at the phone. `null` until sign-in resolves. */
let signedInUser: string | null = null;

let journal: JournalStore = fileJournalStore();

/** Swaps the files for something a test can inspect. The seam `store.ts` had no way to offer. */
export function setJournalStore(next: JournalStore): void {
  journal = next;
}

/**
 * Running totals, folded one leg at a time. `summariseTrack` walks the whole buffer, which is
 * fine for a finished hike and quadratic for a live one — at 1 Hz for eight hours it was ~575×
 * the work of the same call on a foreground-only recording, on a battery, in a pocket.
 */
let statsState: TrackStatsState = initialTrackStats();
let statsCache: ActivityStats = accumulatedStats(statsState);
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
    pending: Math.max(0, fixes.length - sent),
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

/**
 * The store's external-store contract, of which `useRecording` is only the React binding. Exported
 * because anything that needs the recorder outside a render — the Lifeline, a test — should read
 * the same snapshot the screen does rather than a second view assembled from module internals.
 */
export const recordingSnapshot = getSnapshot;
export const subscribeToRecording = subscribe;

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

function writeHead(): void {
  if (!activityId || !startedAt) return;
  const head: JournalHead = {
    v: JOURNAL_VERSION,
    id: activityId,
    ownerId,
    startedAt: startedAt.getTime(),
    trailId,
    routeId,
    sent,
    live,
  };
  journal.writeHead(encodeHead(head));
}

/**
 * Adopt whatever the last run left behind. Safe to call repeatedly — the app root calls it on
 * mount, and a remount after a fast refresh must not wipe a hike in progress.
 *
 * Restores paused, then reconciles with the OS: promoted to recording if the location task is
 * still registered, and the task stopped if it is registered for a hike that is no longer live.
 * That order matters — the reconciliation is asynchronous, and a launch that claimed to be
 * recording before it had asked would be claiming a fix it does not have.
 */
export function hydrate(): void {
  if (hydrated) return;
  // Journals written in a format this build cannot read are erased rather than left behind: an
  // unreadable per-second location trace is still a location trace.
  journal.clearLegacy();

  const raw = journal.readHead();
  if (raw === null) {
    // No journal at all, which is the ordinary case. Only now is hydration settled, so a store
    // that threw does not latch and leave `onReadings` treating a live hike as an orphan.
    hydrated = true;
    return;
  }
  const head = decodeHead(raw);
  if (!head) {
    // The head is staged and renamed, so it is never observed half-written. Undecodable therefore
    // means real corruption of a track that can no longer be attributed to a server activity —
    // and leaving that on disk is the same disclosure as never deleting it.
    journal.clear();
    hydrated = true;
    return;
  }
  if (ownerVerdict(head, signedInUser) === 'erase') {
    journal.clear();
    hydrated = true;
    void stopBackgroundUpdates();
    return;
  }

  const stored = decodeFixes(journal.readFixes() ?? '');
  // A tail cut off mid-append has no newline, so the next append would concatenate onto it and
  // cost a second fix. Rewritten once here rather than guarded at every append.
  if (stored.torn) journal.rewriteFixes(encodeFixes(stored.fixes));

  fixes = stored.fixes;
  sent = Math.min(head.sent, stored.fixes.length);
  activityId = head.id;
  ownerId = head.ownerId;
  startedAt = new Date(head.startedAt);
  trailId = head.trailId;
  routeId = head.routeId;
  live = head.live;
  statsState = foldAll(stored.fixes);
  statsCache = accumulatedStats(statsState);
  const last = fixes[fixes.length - 1];
  if (last) position = [last.lng, last.lat];
  elapsedS = Math.max(0, Math.round((Date.now() - head.startedAt) / 1000));
  phase = 'paused';
  hydrated = true;
  emit();
  void reconcileWithOs(head);
}

function foldAll(stored: readonly TrackFix[]): TrackStatsState {
  let state = initialTrackStats();
  for (const fix of stored) state = advanceTrackStats(state, fix);
  return state;
}

/**
 * Settle the difference between what the journal says and what the OS is doing.
 *
 * A hike iOS kept alive through a relaunch resumes without asking; `restoredPhase` is what
 * separates that from a crash or a force-quit, after which the track has a hole in it and only
 * the user can say whether to carry on. The other direction matters just as much and was missed:
 * a task still registered for a hike nobody is recording is `BestForNavigation` GPS running
 * indefinitely for readings that will be computed and thrown away.
 */
async function reconcileWithOs(head: JournalHead): Promise<void> {
  const still = await isTrackingInBackground();
  if (activityId !== head.id) return;
  if (restoredPhase(head, still) === 'recording') {
    survivesTermination = await hasAlwaysAuthorization();
    if (phase === 'paused' && activityId === head.id) adoptBackgroundRecording();
    return;
  }
  if (still) void stopBackgroundUpdates();
}

/**
 * Take up a recording the OS is already feeding. Shared by the two ways that happens — a restore
 * that finds the task registered, and a reading arriving before the restore has finished asking —
 * because they had drifted apart while doing the same four things.
 */
function adoptBackgroundRecording(): void {
  tracking = 'background';
  // `locating`, not `recording`: the first fix good enough to trust is what promotes it, exactly
  // as at the start of a hike, so a restored recording is not claimed before it has a position.
  phase = 'locating';
  startClock();
  emit();
}

/**
 * Readings from the OS. They arrive in the foreground, with the screen off, and in an app iOS
 * relaunched headless with no screen mounted at all.
 *
 * Handlers are registered only once an identity is known, so anything arriving before that waits
 * in `@/record/background`'s buffer rather than being adopted by whoever happens to be signed in.
 */
function onReadings(readings: readonly Location.LocationObject[]): void {
  if (!activityId) {
    // An orphaned task: the OS is tracking for a hike this device no longer holds. Stop it rather
    // than keep taking positions nothing will ever use. `hydrated` is only ever set after the
    // journal has actually been read, so a failed read cannot reach this.
    if (hydrated) void stopBackgroundUpdates();
    return;
  }
  if (live && phase === 'paused') adoptBackgroundRecording();
  // A reading carries the moment the phone was somewhere, and CoreLocation hands over everything
  // it accumulated while the runtime slept. Ordered rather than assumed ordered: `pushFix` keeps
  // the newest position and drops anything not newer than the last fix, so an out-of-order batch
  // would silently discard most of itself.
  const ordered = [...readings].sort((a, b) => a.timestamp - b.timestamp);
  for (const reading of ordered) pushFix(reading);
}

function onFailure(reason: string): void {
  geoError = reason;
  emit();
}

function pushFix(reading: Location.LocationObject): void {
  if (!startedAt) return;
  const { longitude, latitude, altitude, accuracy, speed } = reading.coords;
  const at = stampOf(reading);
  const eleM = altitude != null && Number.isFinite(altitude) ? altitude : null;

  // Newest wins. Every reading in a batch used to overwrite this, so the live readout showed the
  // last reading of the batch while the single fix that survived was the first.
  if (positionAt == null || at >= positionAt) {
    position = [longitude, latitude];
    positionAt = at;
    positionEleM = eleM;
    accuracyM = accuracy ?? null;
  }
  geoError = null;

  const usable = accuracy == null || accuracy <= MAX_FIX_ACCURACY_M;
  weakSignal = !usable;
  // The first fix good enough to trust is what turns "locating" into "recording".
  if (phase === 'locating' && usable) {
    phase = 'recording';
    startFlushLoop();
  }
  if (phase !== 'recording' || !usable) {
    emit();
    return;
  }

  // `t` is the moment the phone was *there*, not the moment JavaScript woke up to hear about it.
  // A batch of eight accumulated readings all stamped at delivery computes one `t`, and the guard
  // below then rejects seven of them — eight seconds of track collapsing to a single point.
  const t = Math.max(0, Math.round((at - startedAt.getTime()) / 1000));
  const previous = fixes[fixes.length - 1];
  if (previous && t <= previous.t) {
    emit();
    return;
  }

  const fix: TrackFix = {
    t,
    lng: longitude,
    lat: latitude,
    eleM,
    accuracyM: accuracy ?? null,
    speedMps: speed != null && speed >= 0 ? speed : null,
  };
  fixes.push(fix);
  statsState = advanceTrackStats(statsState, fix);
  statsCache = accumulatedStats(statsState);
  elapsedS = Math.max(elapsedS, t);
  journal.appendFixes(encodeFixes([fix]));

  if (route && route.length >= 2) {
    // `updateOffRoute` measures its own timings in milliseconds, unlike `TrackFix.t` which is
    // seconds since the start. The wrong one fires the watchdog after 45 ms or 45,000 seconds.
    const update = updateOffRoute(
      offRouteState,
      { t: at, lng: longitude, lat: latitude, accuracyM: accuracy ?? null },
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

/** A reading's own moment, or now where the device's clock is not worth believing. */
function stampOf(reading: Location.LocationObject): number {
  const now = Date.now();
  const stamp = reading.timestamp;
  if (!Number.isFinite(stamp) || stamp <= 0) return now;
  return stamp > now + MAX_CLOCK_SKEW_MS ? now : stamp;
}

async function startTracking(): Promise<void> {
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
  if (start.reason === 'failed') {
    // Not a host without the capability — services switched off, or authorization withdrawn
    // between the prompt and the start. Reported rather than mislabelled as a build limitation.
    geoError = start.message;
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

function stopTracking(): void {
  watch?.remove();
  watch = null;
  void stopBackgroundUpdates();
  tracking = null;
  survivesTermination = true;
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

  // The hike this flush belongs to. A batch can be in flight when the user finishes and starts
  // another, and `sent` written back into the new hike's head sends its first fixes nowhere.
  const forActivity = activityId;
  flushing = true;
  syncing = true;
  emit();
  try {
    // One batch per call, oldest first: draining the whole backlog in a loop would turn a
    // reconnection after an hour of no signal into sixty simultaneous requests.
    while (activityId === forActivity && fixes.length - sent > 0) {
      const from = sent;
      const batch = fixes.slice(from, from + SAMPLE_BATCH);
      await uploader(forActivity, batch);
      if (activityId !== forActivity) return;
      sent = from + batch.length;
      writeHead();
    }
    if (activityId !== forActivity) return;
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
  statsState = initialTrackStats();
  statsCache = accumulatedStats(statsState);
  offRouteState = initialOffRouteState();
  offRoute = false;
  offRouteDistanceM = null;
  alongM = null;
  activityId = id;
  startedAt = at;
  trailId = trail;
  routeId = plan;
  // Taken from the store rather than from the caller: four screens start hikes, and an owner
  // threaded through four call sites is an owner one of them will forget.
  ownerId = signedInUser;
  syncError = null;
  geoError = null;
  alert = null;
  elapsedS = 0;
  phase = 'locating';
  live = true;
  journal.open();
  writeHead();
  emit();
  startClock();
  void startTracking();
}

export function pause(): void {
  if (phase !== 'recording' && phase !== 'locating') return;
  phase = 'paused';
  // Before the OS subscription goes, so a launch after this one restores paused rather than
  // resuming a hike the user had stopped.
  live = false;
  writeHead();
  stopTracking();
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
  void startTracking();
}

/** Moves to `saving`. The screen calls `activities.finish` and then `forget`. */
export function stop(): void {
  phase = 'saving';
  live = false;
  writeHead();
  stopTracking();
  stopFlushLoop();
  stopClock();
  emit();
}

/** Wipe the local journal without touching the server. */
export function forget(): void {
  live = false;
  journal.clear();
  stopTracking();
  stopFlushLoop();
  stopClock();
  reset();
  emit();
}

/** Everything about a hike, out of memory. Does not touch the disk — callers decide that. */
function reset(): void {
  fixes = [];
  sent = 0;
  statsState = initialTrackStats();
  statsCache = accumulatedStats(statsState);
  offRouteState = initialOffRouteState();
  activityId = null;
  startedAt = null;
  trailId = null;
  routeId = null;
  ownerId = null;
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
}

/**
 * Who is at the phone, as the app currently understands it. Driven from `@/record/bridge`, off
 * the same sign-in seam every other consumer uses.
 *
 * A recording is a per-second location history and the device it was made on can be handed to
 * somebody else, so the journal is keyed to its owner rather than cleared on every sign-out —
 * a token expiring mid-hike is an ordinary event on a mountain, and destroying a hike for it
 * would teach people not to sign out, which is worse for privacy than the thing it fixed.
 *
 * Signing out seals the recording rather than erasing it: nothing of it is presented, the OS
 * subscription stops, and it comes back if the same person signs in again. A *different*
 * identity is the only moment the disclosure exists, and that erases.
 */
export function setSignedInUser(next: string | null): void {
  if (next === signedInUser) return;
  signedInUser = next;

  // Only where there is something to take down. On a cold launch this runs before anything has
  // been restored, and stopping the OS subscription there would end a hike iOS had kept alive.
  if (activityId !== null) {
    setBackgroundHandlers(null);
    stopTracking();
    stopFlushLoop();
    stopClock();
    reset();
  }
  // The journal is re-read against the new identity rather than trusted from a restore performed
  // for somebody else. Clearing the state is not enough on its own: subscribers are told the
  // recorder changed only if something announces it, and the tab bar would otherwise keep drawing
  // the previous person's clock until an unrelated render happened to come along.
  hydrated = false;
  emit();
  if (next === null) return;

  hydrate();
  setBackgroundHandlers({ onReadings, onFailure });
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
