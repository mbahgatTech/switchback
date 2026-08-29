import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';

/**
 * The recorder's relationship with the operating system.
 *
 * `Location.watchPositionAsync` is a foreground subscription: iOS suspends the JavaScript runtime
 * when the screen locks or the app goes behind another, and the subscription stops delivering
 * with it. A hike recorded that way is a straight line between the two moments somebody looked at
 * their phone. What survives instead is a `TaskManager` task registered with CoreLocation, which
 * the OS keeps fed — and, given "Always" authorization, will relaunch the app to feed.
 *
 * The task is defined at module load rather than inside a component on purpose. iOS may relaunch
 * a terminated app *headless* just to hand it a position, and a task defined in a `useEffect`
 * does not exist yet at that moment.
 *
 * This module knows nothing about recording. It hands readings to whatever sink is registered,
 * which keeps the dependency one-way — `@/record/store` imports this, never the reverse.
 */

/** The task name CoreLocation holds. Changing it orphans a task already registered on a device. */
export const LOCATION_TASK = 'switchback-recording-location';

/** Where readings go. Called with a batch, because CoreLocation delivers them in batches. */
export type FixSink = (readings: readonly Location.LocationObject[]) => void;

/** What the OS agreed to when a recording started. */
export interface BackgroundStart {
  /** False when the host cannot run the task at all, and the caller must fall back. */
  started: boolean;
  /**
   * Whether iOS may relaunch the app after terminating it, which needs "Always" authorization.
   * False still records with the screen off — it only means a termination ends the hike.
   */
  survivesTermination: boolean;
}

/**
 * Readings held for a sink that has not registered yet. Ten minutes at 1 Hz, which is far longer
 * than the milliseconds a launch takes; a buffer this full means nothing is coming to drain it,
 * so the excess is dropped rather than the oldest, which are the ones bridging the gap.
 */
const MAX_BUFFERED = 600;

let sink: FixSink | null = null;
let buffered: Location.LocationObject[] = [];

type LocationTaskBody = { locations: Location.LocationObject[] };

// `defineTask` requires a promise-returning executor; there is nothing here to await.
TaskManager.defineTask<LocationTaskBody>(LOCATION_TASK, ({ data, error }) => {
  if (!error && data?.locations?.length) deliver(data.locations);
  return Promise.resolve();
});

function deliver(readings: readonly Location.LocationObject[]): void {
  if (sink) {
    sink(readings);
    return;
  }
  if (buffered.length >= MAX_BUFFERED) return;
  buffered = buffered.concat(readings.slice(0, MAX_BUFFERED - buffered.length));
}

/** Register the sink and hand it anything that arrived before it existed. */
export function setFixSink(next: FixSink | null): void {
  sink = next;
  if (!next || buffered.length === 0) return;
  const held = buffered;
  buffered = [];
  next(held);
}

/**
 * Ask the OS to track this device until told otherwise. Resolves `started: false` when the host
 * has no background location capability, which is the caller's signal to fall back rather than
 * record nothing.
 */
export async function startBackgroundUpdates(): Promise<BackgroundStart> {
  const survivesTermination = await askForAlwaysAuthorization();
  try {
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.BestForNavigation,
      // One a second, undeferred: a track is the point, so a reading held back to save radio is a
      // corner cut off the map.
      timeInterval: 1000,
      distanceInterval: 0,
      deferredUpdatesInterval: 0,
      deferredUpdatesDistance: 0,
      // CoreLocation's own pause, which `expo-location` leaves **on** by default. It stops updates
      // when it decides the user has stopped moving, and with no activity type to judge by it may
      // not start them again — the reported symptom, arriving a second way.
      pausesUpdatesAutomatically: false,
      activityType: Location.LocationActivityType.Fitness,
      // The status bar says so while this runs. Following somebody with the screen off should be
      // visible to them.
      showsBackgroundLocationIndicator: true,
    });
    return { started: true, survivesTermination };
  } catch {
    // Thrown as `LocationUpdatesUnavailable` by hosts whose Info.plist has no `location` in
    // `UIBackgroundModes` — Expo Go, notably. The attempt is the only honest probe: a development
    // build, which does support this, is indistinguishable from Expo Go by any other means.
    return { started: false, survivesTermination: false };
  }
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
 * "Always", asked for once. Recording works with only "When In Use" — the background mode is what
 * keeps it alive with the screen off — so a refusal is reported, never treated as a failure.
 */
async function askForAlwaysAuthorization(): Promise<boolean> {
  try {
    const held = await Location.getBackgroundPermissionsAsync();
    if (held.granted) return true;
    if (!held.canAskAgain) return false;
    const asked = await Location.requestBackgroundPermissionsAsync();
    return asked.granted;
  } catch {
    return false;
  }
}
