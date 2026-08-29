import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalStore } from '../src/record/journal';
import type { TrackFix } from '@switchback/core';
import type * as GeoModule from '@switchback/geo';
import type * as StoreModule from '../src/record/store';
import { summariseTrack } from '@switchback/geo';

/**
 * The recorder itself, which had no tests at all — and that is where every blocker of the first
 * round lived. A batch collapsing to one fix, a head that could destroy a hike, a paused hike
 * telling the user it was recording, an upload writing its progress into the wrong hike: none of
 * them are visible from a codec test, and all of them are visible from here.
 *
 * `expo-*` is mocked and the journal is an in-memory `JournalStore`, which is the seam the module
 * did not have when those defects shipped.
 */

/*
 * The recorder is module-scoped state by design, so every case re-imports it — and that pulls
 * `@switchback/geo`, `@switchback/core` and zod through the transform each time. The work is the
 * import graph, not the assertions; the default five seconds is close enough to it on a loaded
 * machine to go red for no reason.
 */
vi.setConfig({ testTimeout: 30_000 });

const os = vi.hoisted(() => ({
  task: null as ((body: { data?: { locations: unknown[] }; error?: unknown }) => void) | null,
  startLocationUpdatesAsync: vi.fn(async (_task: string, _options: unknown) => undefined),
  stopLocationUpdatesAsync: vi.fn(async (_task: string) => undefined),
  hasStartedLocationUpdatesAsync: vi.fn(async (_task: string) => false),
  getBackgroundPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  requestBackgroundPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  requestForegroundPermissionsAsync: vi.fn(async () => ({ granted: true, canAskAgain: true })),
  watchPositionAsync: vi.fn(async (_options: unknown, _cb: unknown) => ({
    remove: () => undefined,
  })),
}));

vi.mock('expo-task-manager', () => ({
  defineTask: (_name: string, executor: (body: never) => unknown) => {
    os.task = executor as unknown as typeof os.task;
  },
}));

vi.mock('expo-location', () => ({
  Accuracy: { BestForNavigation: 6 },
  LocationActivityType: { Fitness: 3 },
  startLocationUpdatesAsync: (...a: [string, unknown]) => os.startLocationUpdatesAsync(...a),
  stopLocationUpdatesAsync: (...a: [string]) => os.stopLocationUpdatesAsync(...a),
  hasStartedLocationUpdatesAsync: (...a: [string]) => os.hasStartedLocationUpdatesAsync(...a),
  getBackgroundPermissionsAsync: () => os.getBackgroundPermissionsAsync(),
  requestBackgroundPermissionsAsync: () => os.requestBackgroundPermissionsAsync(),
  requestForegroundPermissionsAsync: () => os.requestForegroundPermissionsAsync(),
  watchPositionAsync: (...a: [unknown, unknown]) => os.watchPositionAsync(...a),
}));

vi.mock('expo-haptics', () => ({
  notificationAsync: async () => undefined,
  NotificationFeedbackType: { Warning: 1, Success: 2 },
}));

vi.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: async () => undefined,
  deactivateKeepAwake: () => undefined,
}));

/**
 * The real geo, with one counter around it. Folding incrementally and re-deriving from the whole
 * buffer produce identical numbers — that is what the property test in `packages/geo` proves — so
 * the call count is the only thing that can tell an O(1) step from an O(n) one.
 */
const geo = vi.hoisted(() => {
  let advances = 0;
  return { bump: () => (advances += 1), advanceCalls: () => advances, reset: () => (advances = 0) };
});

vi.mock('@switchback/geo', async () => {
  const real = await vi.importActual<typeof GeoModule>('@switchback/geo');
  return {
    ...real,
    advanceTrackStats: (state: GeoModule.TrackStatsState, fix: TrackFix) => {
      geo.bump();
      return real.advanceTrackStats(state, fix);
    },
  };
});

/** `store.ts` picks a file-backed store at module load; nothing here may reach the filesystem. */
vi.mock('../src/record/journal-files', () => ({
  fileJournalStore: () => memoryJournal(),
}));

/** How the head reached disk, which is the whole of the "a crash cannot destroy a hike" claim. */
interface HeadWrite {
  kind: 'stage' | 'commit';
  raw: string;
}

interface MemoryJournal extends JournalStore {
  head: string | null;
  lines: string;
  headWrites: HeadWrite[];
  appends: number;
  rewrites: number;
  cleared: number;
  legacyCleared: number;
  /** A full disk: every write is refused, exactly as the file store reports one. */
  refuseWrites: boolean;
}

function memoryJournal(): MemoryJournal {
  return {
    head: null,
    lines: '',
    headWrites: [],
    appends: 0,
    rewrites: 0,
    cleared: 0,
    legacyCleared: 0,
    refuseWrites: false,
    readHead() {
      return this.head;
    },
    writeHead(raw) {
      if (this.refuseWrites) return false;
      // The file store stages under another name and renames, so a reader never sees half a head.
      this.headWrites.push({ kind: 'stage', raw });
      this.head = raw;
      this.headWrites.push({ kind: 'commit', raw });
      return true;
    },
    readFixes() {
      return this.lines;
    },
    appendFixes(raw) {
      if (this.refuseWrites) return false;
      this.appends += 1;
      this.lines += raw;
      return true;
    },
    rewriteFixes(raw) {
      if (this.refuseWrites) return false;
      this.rewrites += 1;
      this.lines = raw;
      return true;
    },
    open() {
      if (this.refuseWrites) return false;
      this.head = null;
      this.lines = '';
      return true;
    },
    clear() {
      this.cleared += 1;
      this.head = null;
      this.lines = '';
    },
    clearLegacy() {
      this.legacyCleared += 1;
    },
  };
}

type Store = typeof StoreModule;

/** A fresh module, because the recorder is module-scoped state by design. */
async function load(journal: MemoryJournal): Promise<Store> {
  vi.resetModules();
  os.task = null;
  const store = await import('../src/record/store');
  store.setJournalStore(journal);
  return store;
}

/** An hour ago: readings must be stamped in the past, or the clock-skew guard rewrites them. */
const START = new Date(Date.now() - 3_600_000);

/** One CoreLocation reading, `seconds` after the hike began and `metres` further along. */
function reading(seconds: number, metres = 20) {
  return {
    coords: {
      longitude: -121.49 + metres * seconds * 0.000_012,
      latitude: 48.02,
      altitude: 610,
      accuracy: 6,
      speed: 1.3,
    },
    timestamp: START.getTime() + seconds * 1000,
  };
}

/** A hike under way, fed by the OS task, with the identity already settled. */
async function recording(journal: MemoryJournal, user = 'usr_a'): Promise<Store> {
  const store = await load(journal);
  store.confirmSignedInUser(user);
  store.begin({ id: 'act_1', startedAt: START, trailId: null });
  await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('background'));
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  geo.reset();
  os.startLocationUpdatesAsync.mockResolvedValue(undefined);
  os.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
  os.getBackgroundPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
  os.requestForegroundPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: true });
});

describe('a batch of readings the OS accumulated while the runtime slept', () => {
  it('becomes one fix per reading, stamped when the phone was there', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1, 2, 3, 4, 5, 6, 7].map((s) => reading(s)) } });

    const snapshot = store.recordingSnapshot();
    expect(snapshot.fixes.map((fix) => fix.t)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('reaches the journal as eight lines, not one', async () => {
    const journal = memoryJournal();
    await recording(journal);
    os.task?.({ data: { locations: [0, 1, 2, 3, 4, 5, 6, 7].map((s) => reading(s)) } });
    expect(journal.lines.trimEnd().split('\n')).toHaveLength(8);
  });

  it('leaves the live position on the newest reading, not the oldest', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    const batch = [0, 1, 2].map((s) => reading(s));
    os.task?.({ data: { locations: batch } });
    expect(store.recordingSnapshot().position?.[0]).toBeCloseTo(batch[2]!.coords.longitude, 10);
  });

  it('orders a batch the OS handed over out of order rather than discarding most of it', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [reading(2), reading(0), reading(1)] } });
    expect(store.recordingSnapshot().fixes.map((fix) => fix.t)).toEqual([0, 1, 2]);
  });

  it('ignores a reading stamped implausibly far in the future', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    const skewed = { ...reading(0), timestamp: Date.now() + 86_400_000 };
    os.task?.({ data: { locations: [skewed] } });
    const [first] = store.recordingSnapshot().fixes;
    // Stamped from the clock, so `t` is the hour since this hike began — not the twenty-five
    // hours a reading from tomorrow would imply. The gap between the two is the whole assertion,
    // and a ceiling of 48 h would have been satisfied by either.
    expect(first?.t).toBeGreaterThan(3_500);
    expect(first?.t).toBeLessThan(7_200);
  });
});

describe('the head on disk', () => {
  /*
   * There is deliberately no staging assertion here. The one that used to be here asserted that
   * the in-memory double pushed `stage` then `commit` — which it does unconditionally, for any
   * production code at all. Staging is a property of the files, and it is asserted against the
   * real `expo-file-system` calls in `journal-files.test.ts`, where removing the rename fails.
   */

  it('carries the owner, so the track can be refused to anybody else', async () => {
    const journal = memoryJournal();
    await recording(journal, 'usr_a');
    expect(JSON.parse(journal.head ?? '{}')).toMatchObject({ ownerId: 'usr_a', live: true });
  });

  it('records the hike as no longer live the moment it is paused', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    store.pause();
    expect(JSON.parse(journal.head ?? '{}')).toMatchObject({ live: false });
  });
});

describe('restoring a hike the phone was killed during', () => {
  /** A journal exactly as a kill would leave it: live, with a torn final line. */
  function killedMidHike(user = 'usr_a'): MemoryJournal {
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_1',
      ownerId: user,
      startedAt: START.getTime(),
      trailId: null,
      routeId: null,
      sent: 0,
      live: true,
    });
    journal.lines =
      '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n' +
      '{"t":1,"lng":-121.489,"lat":48.02,"eleM":611,"accuracyM":6}\n' +
      '{"t":2,"lng":-121.488,"lat":4';
    return journal;
  }

  it('comes back with every fix that finished being written', async () => {
    const journal = killedMidHike();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(store.recordingSnapshot().fixes.map((fix) => fix.t)).toEqual([0, 1]);
  });

  it('repairs the torn tail, so the next fix does not land on the fragment', async () => {
    const journal = killedMidHike();
    await load(journal).then((store) => store.confirmSignedInUser('usr_a'));
    expect(journal.lines.endsWith('\n')).toBe(true);
  });

  it('comes back paused when the OS is no longer tracking', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
    const journal = killedMidHike();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(store.recordingSnapshot().phase).toBe('paused');
  });

  it('carries on when iOS relaunched the app and still holds the task', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    const journal = killedMidHike();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    await vi.waitFor(() => expect(store.recordingSnapshot().phase).toBe('locating'));
    expect(store.recordingSnapshot().tracking).toBe('background');
  });

  it('reads "Always" from the OS rather than assuming a restored hike is fragile', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    os.getBackgroundPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: false });
    const journal = killedMidHike();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('background'));
    expect(store.recordingSnapshot().mayNotSurviveTermination).toBe(false);
  });

  it('stops a task still registered for a hike nobody is recording', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    const journal = killedMidHike();
    journal.head = JSON.stringify({ ...JSON.parse(journal.head ?? '{}'), live: false });
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    await vi.waitFor(() => expect(os.stopLocationUpdatesAsync).toHaveBeenCalled());
  });

  it('erases the journal of a format this build no longer reads', async () => {
    const journal = memoryJournal();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(journal.legacyCleared).toBeGreaterThan(0);
  });

  it('never stops a live subscription because the journal could not be read', async () => {
    const journal = memoryJournal();
    journal.readHead = () => {
      throw new Error('disk');
    };
    const store = await load(journal);
    expect(() => store.confirmSignedInUser('usr_a')).toThrow();
    expect(os.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });
});

describe('a phone handed to somebody else', () => {
  function pausedHikeOf(user: string): MemoryJournal {
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_1',
      ownerId: user,
      startedAt: START.getTime(),
      trailId: null,
      routeId: null,
      sent: 0,
      live: false,
    });
    journal.lines = '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n';
    return journal;
  }

  it('shows a hike back to the person who recorded it', async () => {
    const journal = pausedHikeOf('usr_a');
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(store.recordingSnapshot().activityId).toBe('act_1');
  });

  it('shows nobody else where they have been, and erases it', async () => {
    const journal = pausedHikeOf('usr_a');
    const store = await load(journal);
    store.confirmSignedInUser('usr_b');
    expect(store.recordingSnapshot().activityId).toBeNull();
    expect(journal.cleared).toBeGreaterThan(0);
  });

  it('keeps a signed-out hike rather than destroying it, because tokens expire on mountains', async () => {
    const journal = pausedHikeOf('usr_a');
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    store.signOut();
    expect(store.recordingSnapshot().activityId).toBeNull();
    expect(journal.cleared).toBe(0);
  });

  it('tells mounted subscribers, rather than leaving the clock on screen until a re-render', async () => {
    const journal = pausedHikeOf('usr_a');
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    let announced = 0;
    const stop = store.subscribeToRecording(() => {
      announced += 1;
    });
    store.signOut();
    stop();
    expect(announced).toBeGreaterThan(0);
  });
});

describe('a journal whose owner has not been confirmed yet', () => {
  /**
   * A live journal, exactly as an app iOS relaunched in the backcountry finds one: `me.get` has
   * not answered, so `signedInUser` is still null and `ownerVerdict` returns `wait`.
   */
  function unconfirmed(): MemoryJournal {
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_1',
      ownerId: 'usr_a',
      startedAt: START.getTime(),
      trailId: null,
      routeId: null,
      sent: 0,
      live: true,
    });
    journal.lines =
      '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n' +
      '{"t":1,"lng":-121.489,"lat":48.02,"eleM":611,"accuracyM":6}\n';
    return journal;
  }

  it('shows the person at the phone nothing of it', async () => {
    const journal = unconfirmed();
    const store = await load(journal);
    store.hydrate();
    // The whole finding: `wait` used to reach the same restore block as `restore`, so somebody who
    // picked up the phone saw the previous user's track until `me.get` answered — which on a
    // trailhead with no signal is never.
    const snapshot = store.recordingSnapshot();
    expect(snapshot.activityId).toBeNull();
    expect(snapshot.fixes).toEqual([]);
    expect(snapshot.position).toBeNull();
    expect(snapshot.phase).toBe('idle');
  });

  it('does not offer its last position to the Lifeline', async () => {
    const journal = unconfirmed();
    const store = await load(journal);
    store.hydrate();
    // A guard rather than a repair: `latestFix` withholds a position it has no stamp for, so this
    // held even while the snapshot leaked. It is asserted because the Lifeline sends whatever this
    // returns to a publicly shareable link, and the leak next door proves the reasoning is fragile.
    expect(store.latestFix()).toBeNull();
  });

  it('keeps writing the hike to disk, so a wait costs no readings', async () => {
    const journal = unconfirmed();
    const store = await load(journal);
    store.hydrate();
    os.task?.({ data: { locations: [2, 3].map((s) => reading(s)) } });
    expect(journal.lines.trimEnd().split('\n')).toHaveLength(4);
    expect(store.recordingSnapshot().fixes).toEqual([]);
  });

  it('leaves a subscription the OS is feeding alone', async () => {
    const journal = unconfirmed();
    const store = await load(journal);
    store.hydrate();
    os.task?.({ data: { locations: [2].map((s) => reading(s)) } });
    expect(os.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('hands over everything, including what arrived while it waited, to the owner', async () => {
    const journal = unconfirmed();
    const store = await load(journal);
    store.hydrate();
    os.task?.({ data: { locations: [2, 3].map((s) => reading(s)) } });
    store.confirmSignedInUser('usr_a');
    expect(store.recordingSnapshot().fixes.map((fix) => fix.t)).toEqual([0, 1, 2, 3]);
  });

  it('erases everything, including what arrived while it waited, for anybody else', async () => {
    const journal = unconfirmed();
    const store = await load(journal);
    store.hydrate();
    os.task?.({ data: { locations: [2, 3].map((s) => reading(s)) } });
    store.confirmSignedInUser('usr_b');
    expect(store.recordingSnapshot().activityId).toBeNull();
    expect(journal.cleared).toBeGreaterThan(0);
  });

  it('stops a task still registered for a hike that was already paused', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    const journal = unconfirmed();
    journal.head = JSON.stringify({ ...JSON.parse(journal.head ?? '{}'), live: false });
    const store = await load(journal);
    store.hydrate();
    // Withholding must not cost the battery fix: `BestForNavigation` left running for a hike
    // nobody is recording burns a phone whether or not an identity has resolved.
    await vi.waitFor(() => expect(os.stopLocationUpdatesAsync).toHaveBeenCalled());
  });
});

describe('an upload still in flight when the next hike starts', () => {
  it('cannot write its progress into the new hike', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1, 2].map((s) => reading(s)) } });

    // An upload that will not resolve until this test says so.
    const held: { release: () => void } = { release: () => undefined };
    let started = false;
    store.setUploader(
      () =>
        new Promise<void>((resolve) => {
          held.release = resolve;
          started = true;
        }),
    );
    const inFlight = store.flush();
    await vi.waitFor(() => expect(started).toBe(true));

    // The hiker finishes and immediately starts another. The first upload has not resolved.
    store.begin({ id: 'act_2', startedAt: new Date(START.getTime() + 60_000), trailId: null });
    held.release();
    await inFlight;

    const snapshot = store.recordingSnapshot();
    expect(snapshot.activityId).toBe('act_2');
    // Not `pending >= 0`: `build` clamps that with `Math.max`, so it holds however wrong `sent`
    // is. The head is where the damage would be visible, and it is what is checked.
    expect(JSON.parse(journal.head ?? '{}')).toMatchObject({ id: 'act_2', sent: 0 });
  });
});

describe('what the recorder says it is doing', () => {
  const base = {
    tracking: null,
    mayNotSurviveTermination: false,
  } as unknown as StoreModule.RecorderSnapshot;

  it('never claims to be recording when nothing is tracking', async () => {
    const store = await load(memoryJournal());
    expect(store.trackingNote(base)).toBe('not-tracking');
  });

  it('distinguishes every state the store can be in', async () => {
    const store = await load(memoryJournal());
    const cases: Array<[StoreModule.TrackingSource, boolean, string]> = [
      [null, false, 'not-tracking'],
      [null, true, 'not-tracking'],
      ['foreground', false, 'foreground'],
      ['background', false, 'background-durable'],
      ['background', true, 'background-fragile'],
    ];
    for (const [tracking, fragile, expected] of cases) {
      const snapshot = {
        ...base,
        tracking,
        mayNotSurviveTermination: fragile,
      };
      expect(store.trackingNote(snapshot)).toBe(expected);
    }
  });

  it('reports a paused hike as not tracking, not as recording with the screen off', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    store.pause();
    expect(store.trackingNote(store.recordingSnapshot())).toBe('not-tracking');
  });
});

describe('a failure the OS reports mid-hike', () => {
  it('reaches the screen rather than leaving the clock ticking over a dead track', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ error: { message: 'kCLErrorDomain error 1' } });
    expect(store.recordingSnapshot().geoError).toBe('kCLErrorDomain error 1');
  });
});

describe('a host that cannot track in the background', () => {
  it('falls back to the foreground watcher rather than recording nothing', async () => {
    os.startLocationUpdatesAsync.mockRejectedValue(
      new Error("add 'location' to 'UIBackgroundModes'"),
    );
    const journal = memoryJournal();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    store.begin({ id: 'act_1', startedAt: START, trailId: null });
    await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('foreground'));
    expect(os.watchPositionAsync).toHaveBeenCalled();
    expect(store.recordingSnapshot().geoError).toBeNull();
  });

  it('reports a start that failed for any other reason', async () => {
    os.startLocationUpdatesAsync.mockRejectedValue(new Error('Location services are disabled'));
    const journal = memoryJournal();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    store.begin({ id: 'act_1', startedAt: START, trailId: null });
    await vi.waitFor(() =>
      expect(store.recordingSnapshot().geoError).toBe('Location services are disabled'),
    );
  });
});

describe('the numbers on the screen', () => {
  /**
   * Five readouts on the Record screen come off `snapshot.stats`, and until this block nothing
   * asserted a single one of them. The accumulator's arithmetic is proven in `packages/geo`; what
   * is proven here is that the recorder publishes it — a mutation replacing the snapshot's stats
   * with a permanently empty object left the whole suite green while every tile read zero.
   */

  it('has walked a distance and climbed after a batch of readings', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1, 2, 3, 4, 5, 6, 7].map((s) => reading(s)) } });
    const { stats } = store.recordingSnapshot();
    // Eight readings, 20 m apart: a distance on the order of 140 m, not zero and not a kilometre.
    expect(stats.distanceM).toBeGreaterThan(100);
    expect(stats.distanceM).toBeLessThan(200);
    expect(stats.movingTimeS).toBeGreaterThan(0);
  });

  it('agrees with the full pass over the same buffer', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1, 2, 3, 4, 5, 6, 7].map((s) => reading(s)) } });
    const snapshot = store.recordingSnapshot();
    // The fold and `summariseTrack` are pinned to each other in `packages/geo`. This is the other
    // half: that the recorder's published figures are that fold over the recorder's own buffer.
    expect(snapshot.stats).toEqual(summariseTrack(snapshot.fixes));
  });

  it('climbs when the hike climbs, rather than reporting a flat day', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    const climbing = [0, 1, 2, 3, 4, 5, 6, 7].map((s) => {
      const base = reading(s);
      return { ...base, coords: { ...base.coords, altitude: 610 + s * 8 } };
    });
    os.task?.({ data: { locations: climbing } });
    expect(store.recordingSnapshot().stats.gainM).toBeGreaterThan(0);
  });

  it('starts a new hike at zero rather than on the end of the last one', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1, 2, 3].map((s) => reading(s)) } });
    expect(store.recordingSnapshot().stats.distanceM).toBeGreaterThan(0);
    store.begin({ id: 'act_2', startedAt: START, trailId: null });
    expect(store.recordingSnapshot().stats.distanceM).toBe(0);
    expect(store.recordingSnapshot().stats.gainM).toBe(0);
  });

  it('re-derives them from the journal when a hike is restored', async () => {
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_1',
      ownerId: 'usr_a',
      startedAt: START.getTime(),
      trailId: null,
      routeId: null,
      sent: 0,
      live: false,
    });
    journal.lines =
      [0, 1, 2, 3, 4]
        .map((t) =>
          JSON.stringify({
            t,
            lng: -121.49 + t * 0.000_24,
            lat: 48.02,
            eleM: 610 + t * 8,
            accuracyM: 6,
          }),
        )
        .join('\n') + '\n';
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    const snapshot = store.recordingSnapshot();
    // An eight-hour hike coming back reading 0 km is what a missing re-fold looks like.
    expect(snapshot.fixes).toHaveLength(5);
    expect(snapshot.stats).toEqual(summariseTrack(snapshot.fixes));
    expect(snapshot.stats.distanceM).toBeGreaterThan(0);
  });

  it('is emptied when a journal is discarded', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1, 2, 3].map((s) => reading(s)) } });
    store.forget();
    expect(store.recordingSnapshot().stats.distanceM).toBe(0);
  });
});

describe('a phone that will not take the writes', () => {
  /**
   * Every write path swallows its failure on purpose: a full disk halfway up a mountain is not
   * something the hiker can do anything about there, and stopping the hike over it is worse. What
   * was missing is any record that it happened — durability could be entirely gone with nothing
   * anywhere saying so, including on the screen where the hike is saved and could still be acted on.
   */

  it('says so on the snapshot when a fix does not reach the disk', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    expect(store.recordingSnapshot().journalDegraded).toBe(false);
    journal.refuseWrites = true;
    os.task?.({ data: { locations: [0, 1].map((s) => reading(s)) } });
    expect(store.recordingSnapshot().journalDegraded).toBe(true);
  });

  it('keeps recording the hike in memory regardless', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    journal.refuseWrites = true;
    os.task?.({ data: { locations: [0, 1].map((s) => reading(s)) } });
    // The point of swallowing the failure in the first place. Losing the durability guarantee
    // must not cost the fixes that are already in hand.
    expect(store.recordingSnapshot().fixes.map((fix) => fix.t)).toEqual([0, 1]);
  });

  it('tells mounted subscribers the moment it turns true', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    let announced = 0;
    const stop = store.subscribeToRecording(() => {
      announced += 1;
    });
    journal.refuseWrites = true;
    os.task?.({ data: { locations: [0].map((s) => reading(s)) } });
    stop();
    expect(announced).toBeGreaterThan(0);
  });

  it('starts the next hike clean, rather than accusing the phone forever', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    journal.refuseWrites = true;
    os.task?.({ data: { locations: [0].map((s) => reading(s)) } });
    expect(store.recordingSnapshot().journalDegraded).toBe(true);
    journal.refuseWrites = false;
    store.begin({ id: 'act_2', startedAt: START, trailId: null });
    expect(store.recordingSnapshot().journalDegraded).toBe(false);
  });
});

describe('what the journal costs per batch', () => {
  it('writes the batch the OS delivered as one append, and never rewrites the track', async () => {
    const journal = memoryJournal();
    await recording(journal);
    const rewritesBefore = journal.rewrites;
    os.task?.({ data: { locations: [0, 1, 2, 3].map((s) => reading(s)) } });
    // One open-write-close for the four readings that arrived together. Per fix, an eight-hour
    // hike costs 28,800 of them for the ~500 the batches are worth. No rewrite either: rewriting
    // the whole track is what the append-only format exists to avoid, and it is invisible to any
    // assertion that only counts the lines on disk.
    expect(journal.appends).toBe(1);
    expect(journal.rewrites).toBe(rewritesBefore);
    expect(journal.lines.trimEnd().split('\n')).toHaveLength(4);
  });

  it('still writes a foreground reading of its own, which arrives alone', async () => {
    os.startLocationUpdatesAsync.mockRejectedValue(new Error('UIBackgroundModes'));
    const journal = memoryJournal();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    store.begin({ id: 'act_1', startedAt: START, trailId: null });
    await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('foreground'));
    const [, watcher] = os.watchPositionAsync.mock.calls[0] ?? [];
    (watcher as (r: unknown) => void)(reading(0));
    (watcher as (r: unknown) => void)(reading(1));
    // The fallback watcher hands over one reading at a time, so batching it would mean holding a
    // fix out of the journal until the next one arrived.
    expect(journal.appends).toBe(2);
  });
});

describe('a head that disagrees with the track beside it', () => {
  it('never reports more sent than exist, which would send the rest nowhere', async () => {
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_1',
      ownerId: 'usr_a',
      startedAt: START.getTime(),
      trailId: null,
      routeId: null,
      // A stale count: the head survived a write the fixes file did not.
      sent: 99,
      live: false,
    });
    journal.lines =
      '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n' +
      '{"t":1,"lng":-121.489,"lat":48.02,"eleM":611,"accuracyM":6}\n';
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(store.recordingSnapshot().fixes).toHaveLength(2);

    // The harm of an unclamped count is not the readout, it is the upload: `flush` measures the
    // backlog as `fixes.length - sent`, so a count of 99 against two fixes means nothing is ever
    // sent again until ninety-eight more arrive — and the ones in between are skipped for good.
    const uploaded: number[] = [];
    store.setUploader(async (_id, batch) => {
      uploaded.push(...batch.map((fix) => fix.t));
    });
    store.resume();
    await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('background'));
    os.task?.({ data: { locations: [2, 3, 4].map((sec) => reading(sec)) } });
    await store.flush();
    expect(uploaded).toContain(2);
    expect(uploaded).toContain(4);
  });
});

describe('a hiker who refuses location', () => {
  it('does not leave the hike marked live, which would resume it on the next launch', async () => {
    os.requestForegroundPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: true });
    const journal = memoryJournal();
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    store.begin({ id: 'act_1', startedAt: START, trailId: null });
    await vi.waitFor(() => expect(store.recordingSnapshot().phase).toBe('paused'));
    expect(JSON.parse(journal.head ?? '{}')).toMatchObject({ live: false });
    expect(store.recordingSnapshot().geoError).toMatch(/Location access/);
  });
});

describe('a restored hike on a phone that never granted Always', () => {
  it('says so, rather than claiming iOS will restart it', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    os.getBackgroundPermissionsAsync.mockResolvedValue({ granted: false, canAskAgain: false });
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_1',
      ownerId: 'usr_a',
      startedAt: START.getTime(),
      trailId: null,
      routeId: null,
      sent: 0,
      live: true,
    });
    journal.lines = '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n';
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('background'));
    expect(store.recordingSnapshot().mayNotSurviveTermination).toBe(true);
    expect(store.trackingNote(store.recordingSnapshot())).toBe('background-fragile');
  });
});

describe('behaviours a mutation could quietly remove', () => {
  /** A live hike, then whatever the caller does to it. */
  async function live(journal: MemoryJournal) {
    return recording(journal);
  }

  it('stops the OS subscription on sign-out, rather than leaving GPS running for nobody', async () => {
    const journal = memoryJournal();
    const store = await live(journal);
    // The OS now holds the task, which is what `stopBackgroundUpdates` checks before stopping.
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    store.signOut();
    await vi.waitFor(() => expect(os.stopLocationUpdatesAsync).toHaveBeenCalled());
  });

  it('erases the journal when a hike is discarded', async () => {
    const journal = memoryJournal();
    const store = await live(journal);
    os.task?.({ data: { locations: [reading(0)] } });
    store.forget();
    expect(journal.head).toBeNull();
    expect(journal.lines).toBe('');
    expect(journal.cleared).toBeGreaterThan(0);
  });

  it('erases a corrupt journal rather than leaving an unattributable trace on disk', async () => {
    const journal = memoryJournal();
    journal.head = '{"v":2,"id":';
    journal.lines = '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n';
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(journal.cleared).toBeGreaterThan(0);
    expect(store.recordingSnapshot().activityId).toBeNull();
  });

  it('starts a new hike on an empty track, not on the end of the last one', async () => {
    const journal = memoryJournal();
    const store = await live(journal);
    os.task?.({ data: { locations: [reading(0), reading(1)] } });
    expect(journal.lines.trimEnd().split('\n')).toHaveLength(2);
    store.begin({ id: 'act_2', startedAt: new Date(), trailId: null });
    expect(journal.lines).toBe('');
  });

  it('marks a finished hike as no longer live, so the next launch does not resume it', async () => {
    const journal = memoryJournal();
    const store = await live(journal);
    store.stop();
    expect(JSON.parse(journal.head ?? '{}')).toMatchObject({ live: false });
  });

  it('adopts a live journal from a reading alone, without waiting to be told the task is up', async () => {
    // The second of the two documented adoption paths: iOS relaunches the app and hands over a
    // position before `reconcileWithOs` has finished asking whether the task is registered.
    os.hasStartedLocationUpdatesAsync.mockImplementation(
      () => new Promise<boolean>(() => undefined),
    );
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_1',
      ownerId: 'usr_a',
      startedAt: START.getTime(),
      trailId: null,
      routeId: null,
      sent: 0,
      live: true,
    });
    journal.lines = '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n';
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(store.recordingSnapshot().phase).toBe('paused');
    os.task?.({ data: { locations: [reading(30)] } });
    expect(store.recordingSnapshot().tracking).toBe('background');
    expect(store.recordingSnapshot().fixes.map((fix) => fix.t)).toContain(30);
  });

  it('registers for readings before anything can fail, so a bad journal costs no fixes', async () => {
    const journal = memoryJournal();
    journal.readHead = () => {
      throw new Error('disk');
    };
    const store = await load(journal);
    expect(() => store.confirmSignedInUser('usr_a')).toThrow();
    // Handlers are attached ahead of the latch and ahead of the first read, so a reading arriving
    // now reaches the store. With no hike restored there is nothing to append it to — but the
    // orphan-stop must not fire either, because the journal was never actually read.
    os.task?.({ data: { locations: [reading(0)] } });
    expect(os.stopLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it('folds one leg per fix rather than re-walking the track', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1, 2, 3, 4, 5].map((s) => reading(s)) } });
    // Six fixes, six folds. Re-deriving from the whole buffer gives the same numbers — which is
    // what the geo property test proves — so only the call count can tell the two apart.
    expect(geo.advanceCalls()).toBe(6);
    expect(store.recordingSnapshot().fixes).toHaveLength(6);
  });
});

describe('a journal older than a recording is allowed to be', () => {
  it('is erased rather than left in Documents waiting for a backup', async () => {
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_old',
      ownerId: 'usr_a',
      startedAt: Date.now() - 72 * 60 * 60 * 1000,
      trailId: null,
      routeId: null,
      sent: 0,
      live: false,
    });
    journal.lines = '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n';
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(journal.cleared).toBeGreaterThan(0);
    expect(store.recordingSnapshot().activityId).toBeNull();
  });

  it('keeps one still inside the window', async () => {
    const journal = memoryJournal();
    journal.head = JSON.stringify({
      v: 2,
      id: 'act_recent',
      ownerId: 'usr_a',
      startedAt: Date.now() - 6 * 60 * 60 * 1000,
      trailId: null,
      routeId: null,
      sent: 0,
      live: false,
    });
    journal.lines = '{"t":0,"lng":-121.49,"lat":48.02,"eleM":610,"accuracyM":6}\n';
    const store = await load(journal);
    store.confirmSignedInUser('usr_a');
    expect(store.recordingSnapshot().activityId).toBe('act_recent');
  });
});

describe('an upload the server will never accept', () => {
  it('stops the retry loop instead of burning the radio for the rest of the hike', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1].map((s) => reading(s)) } });

    let attempts = 0;
    store.setUploader(() => {
      attempts += 1;
      // What `activities.append` throws once a recording has reached MAX_SAMPLES.
      return Promise.reject(
        Object.assign(new Error('This recording has reached its maximum length.'), {
          data: { code: 'BAD_REQUEST', httpStatus: 400 },
        }),
      );
    });
    await expect(store.flush()).rejects.toThrow(/maximum length/);
    await store.flush();
    await store.flush();
    expect(attempts).toBe(1);
    expect(store.recordingSnapshot().syncError).toMatch(/maximum length/);
  });

  it('keeps retrying one that is only a lost signal', async () => {
    const journal = memoryJournal();
    const store = await recording(journal);
    os.task?.({ data: { locations: [0, 1].map((s) => reading(s)) } });

    let attempts = 0;
    store.setUploader(() => {
      attempts += 1;
      return Promise.reject(new Error('Network request failed'));
    });
    await expect(store.flush()).rejects.toThrow();
    await expect(store.flush()).rejects.toThrow();
    expect(attempts).toBe(2);
  });
});
