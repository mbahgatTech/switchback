import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

/**
 * The recorder's relationship with the operating system.
 *
 * `Location.watchPositionAsync` is a foreground subscription: iOS suspends the JavaScript runtime
 * when the screen locks or the app goes behind another, and the subscription stops delivering
 * with it. A hike recorded that way is a straight line between the two moments somebody looked at
 * their phone. A `TaskManager` task registered with CoreLocation survives instead — and, given
 * "Always" authorization, will have the app relaunched to be fed.
 *
 * The task is defined at module load rather than inside a component. iOS may relaunch a
 * terminated app *headless* just to hand it a position, and a task defined in a `useEffect` does
 * not exist yet at that moment. `app/_layout.tsx` imports this module for that side effect
 * explicitly, so the registration does not depend on which components a refactor happens to keep.
 *
 * This module knows nothing about recording. It hands readings, and failures, to whatever sink is
 * registered — which keeps the dependency one-way: `@/record/store` imports this, never the
 * reverse.
 */

/** The task name CoreLocation holds. Changing it orphans a task already registered on a device. */
export const LOCATION_TASK = 'switchback-recording-location';

/** Where readings go. Called with a batch, because CoreLocation delivers them in batches. */
export type FixSink = (readings: readonly Location.LocationObject[]) => void;

/** Where CoreLocation's own failures go. Never swallowed: see `startBackgroundUpdates`. */
export type FailureSink = (reason: string) => void;

export interface BackgroundHandlers {
  onReadings: FixSink;
  onFailure: FailureSink;
}

/** Why a start did not happen, when it did not. */
export type StartOutcome =
  | { started: true; survivesTermination: boolean }
  /** The host has no background location capability at all. Fall back to the foreground watcher. */
  | { started: false; reason: 'unsupported' }
  /** Something else refused — services off, permission withdrawn. The user needs telling. */
  | { started: false; reason: 'failed'; message: string };

/**
 * Readings held until a sink registers. iOS can relaunch this app headless and hand it a position
 * before React has mounted anything at all, so `@/record/store` cannot yet have registered — this
 * buffer is what stops those first seconds of a relaunched hike being dropped on the floor. It is
 * not an identity gate: registration happens on every launch, before anybody is signed in, and
 * `@/record/store` is what withholds a journal whose owner is unsettled. Ten minutes at 1 Hz; a
 * buffer this full means nothing is coming to drain it, so the excess is dropped rather than the
 * oldest, which are the ones bridging the gap.
 */
const MAX_BUFFERED = 600;

let handlers: BackgroundHandlers | null = null;
let buffered: Location.LocationObject[] = [];

type LocationTaskBody = { locations: Location.LocationObject[] };

/**
 * `expo-location`'s iOS module raises this from `startLocationUpdatesAsync` when the host's
 * `Info.plist` carries no `location` in `UIBackgroundModes`. Matching the text rather than
 * catching everything is what keeps "location services are off system-wide" out of the fall-back
 * path.
 *
 * It cannot be narrowed further: `LocationModule.swift` throws the same exception with the same
 * message when significant-change monitoring is unavailable — an MDM-restricted device, say. So
 * the prose the user sees says what will happen, never why, and never blames the build.
 */
const UNSUPPORTED_SIGNATURE = /UIBackgroundModes|Background location has not been configured/i;

// `defineTask` requires a promise-returning executor; there is nothing here to await.
TaskManager.defineTask<LocationTaskBody>(LOCATION_TASK, ({ data, error }) => {
  if (error) {
    // A CoreLocation failure mid-hike — authorization withdrawn from Settings, services turned
    // off. Dropping it leaves the clock ticking over a track that stopped growing.
    handlers?.onFailure(errorText(error));
  } else if (data?.locations?.length) {
    deliver(data.locations);
  }
  return Promise.resolve();
});

function deliver(readings: readonly Location.LocationObject[]): void {
  if (handlers) {
    handlers.onReadings(readings);
    return;
  }
  if (buffered.length >= MAX_BUFFERED) return;
  buffered = buffered.concat(readings.slice(0, MAX_BUFFERED - buffered.length));
}

/** Register the handlers and hand them anything that arrived before they existed. */
export function setBackgroundHandlers(next: BackgroundHandlers | null): void {
  handlers = next;
  if (!next || buffered.length === 0) return;
  const held = buffered;
  buffered = [];
  next.onReadings(held);
}

/**
 * Ask the OS to track this device until told otherwise.
 *
 * The capability probe is the attempt itself: nothing else distinguishes Expo Go from a
 * development build, which report the same execution environment and differ only in a plist. So
 * the start is tried first and "Always" is asked for only if it succeeds — prompting for iOS's
 * most invasive location permission and then discovering the app cannot use it is a dialog spent
 * for nothing.
 */
export async function startBackgroundUpdates(): Promise<StartOutcome> {
  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      // `timeInterval` is Android-only; iOS delivers at whatever rate the accuracy class gives.
      // A zero distance filter is what stops CoreLocation withholding a fix because the hiker
      // has not moved far enough — the pauses on a slow ascent are the hike.
      distanceInterval: 0,
      deferredUpdatesInterval: 0,
      deferredUpdatesDistance: 0,
      // CoreLocation's own pause, which `expo-location` leaves **on** by default. It stops
      // updates when it decides the user has stopped moving, and with no activity type to judge
      // by it may not start them again — the reported symptom, arriving a second way.
      pausesUpdatesAutomatically: false,
      activityType: Location.LocationActivityType.Fitness,
      // The status bar says so while this runs. Following somebody with the screen off should be
      // visible to them.
      showsBackgroundLocationIndicator: true,
    });
  } catch (cause) {
    const message = errorText(cause);
    if (UNSUPPORTED_SIGNATURE.test(message)) return { started: false, reason: 'unsupported' };
    return { started: false, reason: 'failed', message };
  }
  return { started: true, survivesTermination: await askForAlwaysAuthorization() };
}

export async function stopBackgroundUpdates(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) {
      await Location.stopLocationUpdatesAsync(LOCATION_TASK);
    }
  } catch {
    /* Never registered, or already gone. Either way there is nothing left to stop. */
  }
}

/** Whether the OS still holds the task. What tells a relaunch apart from a crash on restore. */
export async function isTrackingInBackground(): Promise<boolean> {
  try {
    return await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    return false;
  }
}

/**
 * Whether iOS may relaunch this app to keep feeding a recording. Read from the OS every time the
 * question is asked rather than remembered from the last start: a restored hike has no start to
 * remember, and telling somebody who granted "Always" to go and grant "Always" is worse than
 * saying nothing.
 */
export async function hasAlwaysAuthorization(): Promise<boolean> {
  try {
    return (await Location.getBackgroundPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

/**
 * "Always", asked for once. Recording works with only "When In Use" — the background mode is what
 * keeps it alive with the screen off — so a refusal is reported, never treated as a failure.
 */
async function askForAlwaysAuthorization(): Promise<boolean> {
  try {
    const held = await Location.getBackgroundPermissionsAsync();
    if (held.granted) return true;
    if (!held.canAskAgain) return false;
    return (await Location.requestBackgroundPermissionsAsync()).granted;
  } catch {
    return false;
  }
}

function errorText(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'string') return cause;
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    return String(cause.message);
  }
  return 'Location updates stopped.';
}
