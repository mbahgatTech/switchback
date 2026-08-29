import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as BackgroundModule from '../src/record/background';

/**
 * The OS half of recording, with CoreLocation stood in for. What is checked is the behaviour that
 * only shows up on a mountain: a host that cannot run the task at all, a failure the OS reports
 * mid-hike, and readings arriving while nothing is listening.
 */

type TaskBody = { data?: { locations: unknown[] }; error?: unknown };

const os = vi.hoisted(() => ({
  /** The task body `defineTask` was given, so a test can play the OS and call it. */
  task: null as ((body: { data?: { locations: unknown[] }; error?: unknown }) => void) | null,
  startLocationUpdatesAsync: vi.fn(async (_task: string, _options: unknown) => undefined),
  stopLocationUpdatesAsync: vi.fn(async (_task: string) => undefined),
  hasStartedLocationUpdatesAsync: vi.fn(async (_task: string) => true),
  getBackgroundPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  requestBackgroundPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
}));

vi.mock('expo-task-manager', () => ({
  defineTask: (_name: string, executor: (body: TaskBody) => unknown) => {
    os.task = executor;
  },
}));

vi.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  LocationActivityType: { Fitness: 3 },
  startLocationUpdatesAsync: (...args: [string, unknown]) => os.startLocationUpdatesAsync(...args),
  stopLocationUpdatesAsync: (...args: [string]) => os.stopLocationUpdatesAsync(...args),
  hasStartedLocationUpdatesAsync: (...args: [string]) => os.hasStartedLocationUpdatesAsync(...args),
  getBackgroundPermissionsAsync: () => os.getBackgroundPermissionsAsync(),
  requestBackgroundPermissionsAsync: () => os.requestBackgroundPermissionsAsync(),
}));

type Background = typeof BackgroundModule;

/** A fresh copy of the module, because defining the task is something it does exactly once. */
async function load(): Promise<Background> {
  vi.resetModules();
  os.task = null;
  return import('../src/record/background');
}

function reading(lng: number, lat: number) {
  return { coords: { longitude: lng, latitude: lat, altitude: 600 }, timestamp: 1 };
}

/** Both handlers, with the readings collected for inspection. */
function handlers() {
  const readings: unknown[] = [];
  const failures: string[] = [];
  return {
    readings,
    failures,
    sink: {
      onReadings: (batch: readonly unknown[]) => readings.push(...batch),
      onFailure: (reason: string) => failures.push(reason),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  os.startLocationUpdatesAsync.mockResolvedValue(undefined);
  os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
  os.getBackgroundPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
});

describe('starting on a host that can track in the background', () => {
  it('registers the task and reports it started', async () => {
    const background = await load();
    const start = await background.startBackgroundUpdates();
    expect(start.started).toBe(true);
    expect(os.startLocationUpdatesAsync).toHaveBeenCalledWith(
      background.LOCATION_TASK,
      expect.anything(),
    );
  });

  it("turns off CoreLocation's own pause, which is the other way tracking stops", async () => {
    const background = await load();
    await background.startBackgroundUpdates();
    const options = os.startLocationUpdatesAsync.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options.pausesUpdatesAutomatically).toBe(false);
    expect(options.activityType).toBe(3);
  });

  it('reports a hike that will not outlive a termination when "Always" is refused', async () => {
    os.getBackgroundPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    os.requestBackgroundPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    const background = await load();
    // Still recording: the background mode carries the screen-off case on its own.
    expect(await background.startBackgroundUpdates()).toEqual({
      started: true,
      survivesTermination: false,
    });
  });
});

describe('starting on a host that cannot', () => {
  it('names it unsupported so the caller falls back to the foreground watcher', async () => {
    os.startLocationUpdatesAsync.mockRejectedValue(
      new Error("Background location has not been configured, make sure to add 'location'"),
    );
    const background = await load();
    expect(await background.startBackgroundUpdates()).toEqual({
      started: false,
      reason: 'unsupported',
    });
  });

  it('never spends the "Always" prompt on a capability the host does not have', async () => {
    os.startLocationUpdatesAsync.mockRejectedValue(
      new Error("add 'location' to 'UIBackgroundModes'"),
    );
    const background = await load();
    await background.startBackgroundUpdates();
    expect(os.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(os.getBackgroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('distinguishes location services being off from a build that cannot do this', async () => {
    os.startLocationUpdatesAsync.mockRejectedValue(new Error('Location services are disabled'));
    const background = await load();
    expect(await background.startBackgroundUpdates()).toEqual({
      started: false,
      reason: 'failed',
      message: 'Location services are disabled',
    });
  });
});

describe('readings arriving from the OS', () => {
  it('hands a whole batch to the sink, not just the newest', async () => {
    const background = await load();
    const { readings, sink } = handlers();
    background.setBackgroundHandlers(sink);
    os.task?.({ data: { locations: [reading(-121.4, 48.0), reading(-121.5, 48.1)] } });
    expect(readings).toHaveLength(2);
  });

  it('replays what arrived before anything was listening', async () => {
    const background = await load();
    os.task?.({ data: { locations: [reading(-121.4, 48.0)] } });
    os.task?.({ data: { locations: [reading(-121.5, 48.1)] } });
    const { readings, sink } = handlers();
    background.setBackgroundHandlers(sink);
    expect(readings).toHaveLength(2);
  });

  it('replays them once', async () => {
    const background = await load();
    os.task?.({ data: { locations: [reading(-121.4, 48.0)] } });
    background.setBackgroundHandlers(handlers().sink);
    const second = handlers();
    background.setBackgroundHandlers(second.sink);
    expect(second.readings).toHaveLength(0);
  });
});

describe('failures the OS reports mid-hike', () => {
  it('reaches the caller rather than being swallowed', async () => {
    const background = await load();
    const { failures, readings, sink } = handlers();
    background.setBackgroundHandlers(sink);
    os.task?.({
      error: { message: 'The operation couldn’t be completed. (kCLErrorDomain error 1.)' },
    });
    expect(failures).toEqual(['The operation couldn’t be completed. (kCLErrorDomain error 1.)']);
    expect(readings).toHaveLength(0);
  });
});

describe('asking the OS whether it is still tracking', () => {
  it('answers no when the query itself fails, so a restore never claims a hike is live', async () => {
    os.hasStartedLocationUpdatesAsync.mockRejectedValue(new Error('no task manager'));
    const background = await load();
    await expect(background.isTrackingInBackground()).resolves.toBe(false);
  });

  it('stops nothing when nothing is registered', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
    const background = await load();
    await background.stopBackgroundUpdates();
    expect(os.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('reads "Always" from the OS every time it is asked', async () => {
    const background = await load();
    os.getBackgroundPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    await expect(background.hasAlwaysAuthorization()).resolves.toBe(false);
    os.getBackgroundPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
    await expect(background.hasAlwaysAuthorization()).resolves.toBe(true);
  });
});
