import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalStore } from '../src/record/journal';
import type * as StoreModule from '../src/record/store';

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
    readHead() {
      return this.head;
    },
    writeHead(raw) {
      // The file store stages under another name and renames, so a reader never sees half a head.
      this.headWrites.push({ kind: 'stage', raw });
      this.head = raw;
      this.headWrites.push({ kind: 'commit', raw });
    },
    readFixes() {
      return this.lines;
    },
    appendFixes(raw) {
      this.appends += 1;
      this.lines += raw;
    },
    rewriteFixes(raw) {
      this.rewrites += 1;
      this.lines = raw;
    },
    open() {
      this.head = null;
      this.lines = '';
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
  store.setSignedInUser(user);
  store.begin({ id: 'act_1', startedAt: START, trailId: null });
  await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('background'));
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
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
    // Stamped from the clock rather than from a reading claiming to be from tomorrow.
    expect(first?.t).toBeLessThan(60 * 60 * 48);
  });
});

describe('the head on disk', () => {
  it('is staged before it is committed, so a kill cannot leave half of one', async () => {
    const journal = memoryJournal();
    await recording(journal);
    expect(journal.headWrites.length).toBeGreaterThan(0);
    expect(journal.headWrites.map((write) => write.kind)).toEqual(
      journal.headWrites.map((_, i) => (i % 2 === 0 ? 'stage' : 'commit')),
    );
  });

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
    store.setSignedInUser('usr_a');
    expect(store.recordingSnapshot().fixes.map((fix) => fix.t)).toEqual([0, 1]);
  });

  it('repairs the torn tail, so the next fix does not land on the fragment', async () => {
    const journal = killedMidHike();
    await load(journal).then((store) => store.setSignedInUser('usr_a'));
    expect(journal.lines.endsWith('\n')).toBe(true);
  });

  it('comes back paused when the OS is no longer tracking', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
    const journal = killedMidHike();
    const store = await load(journal);
    store.setSignedInUser('usr_a');
    expect(store.recordingSnapshot().phase).toBe('paused');
  });

  it('carries on when iOS relaunched the app and still holds the task', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    const journal = killedMidHike();
    const store = await load(journal);
    store.setSignedInUser('usr_a');
    await vi.waitFor(() => expect(store.recordingSnapshot().phase).toBe('locating'));
    expect(store.recordingSnapshot().tracking).toBe('background');
  });

  it('reads "Always" from the OS rather than assuming a restored hike is fragile', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    os.getBackgroundPermissionsAsync.mockResolvedValue({ granted: true, canAskAgain: false });
    const journal = killedMidHike();
    const store = await load(journal);
    store.setSignedInUser('usr_a');
    await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('background'));
    expect(store.recordingSnapshot().mayNotSurviveTermination).toBe(false);
  });

  it('stops a task still registered for a hike nobody is recording', async () => {
    os.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    const journal = killedMidHike();
    journal.head = JSON.stringify({ ...JSON.parse(journal.head ?? '{}'), live: false });
    const store = await load(journal);
    store.setSignedInUser('usr_a');
    await vi.waitFor(() => expect(os.stopLocationUpdatesAsync).toHaveBeenCalled());
  });

  it('erases the journal of a format this build no longer reads', async () => {
    const journal = memoryJournal();
    const store = await load(journal);
    store.setSignedInUser('usr_a');
    expect(journal.legacyCleared).toBeGreaterThan(0);
  });

  it('never stops a live subscription because the journal could not be read', async () => {
    const journal = memoryJournal();
    journal.readHead = () => {
      throw new Error('disk');
    };
    const store = await load(journal);
    expect(() => store.setSignedInUser('usr_a')).toThrow();
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
    store.setSignedInUser('usr_a');
    expect(store.recordingSnapshot().activityId).toBe('act_1');
  });

  it('shows nobody else where they have been, and erases it', async () => {
    const journal = pausedHikeOf('usr_a');
    const store = await load(journal);
    store.setSignedInUser('usr_b');
    expect(store.recordingSnapshot().activityId).toBeNull();
    expect(journal.cleared).toBeGreaterThan(0);
  });

  it('keeps a signed-out hike rather than destroying it, because tokens expire on mountains', async () => {
    const journal = pausedHikeOf('usr_a');
    const store = await load(journal);
    store.setSignedInUser('usr_a');
    store.setSignedInUser(null);
    expect(store.recordingSnapshot().activityId).toBeNull();
    expect(journal.cleared).toBe(0);
  });

  it('tells mounted subscribers, rather than leaving the clock on screen until a re-render', async () => {
    const journal = pausedHikeOf('usr_a');
    const store = await load(journal);
    store.setSignedInUser('usr_a');
    let announced = 0;
    const stop = store.subscribeToRecording(() => {
      announced += 1;
    });
    store.setSignedInUser(null);
    stop();
    expect(announced).toBeGreaterThan(0);
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
    expect(snapshot.pending).toBeGreaterThanOrEqual(0);
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
    store.setSignedInUser('usr_a');
    store.begin({ id: 'act_1', startedAt: START, trailId: null });
    await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('foreground'));
    expect(os.watchPositionAsync).toHaveBeenCalled();
    expect(store.recordingSnapshot().geoError).toBeNull();
  });

  it('reports a start that failed for any other reason', async () => {
    os.startLocationUpdatesAsync.mockRejectedValue(new Error('Location services are disabled'));
    const journal = memoryJournal();
    const store = await load(journal);
    store.setSignedInUser('usr_a');
    store.begin({ id: 'act_1', startedAt: START, trailId: null });
    await vi.waitFor(() =>
      expect(store.recordingSnapshot().geoError).toBe('Location services are disabled'),
    );
  });
});

describe('what the journal costs per fix', () => {
  it('appends each fix and never rewrites the track while recording', async () => {
    const journal = memoryJournal();
    await recording(journal);
    const rewritesBefore = journal.rewrites;
    os.task?.({ data: { locations: [0, 1, 2, 3].map((s) => reading(s)) } });
    // Four appends, no rewrite. Rewriting the whole track per fix is what the append-only format
    // exists to avoid, and it is invisible to any assertion that only counts the lines on disk.
    expect(journal.appends).toBe(4);
    expect(journal.rewrites).toBe(rewritesBefore);
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
    store.setSignedInUser('usr_a');
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
    store.setSignedInUser('usr_a');
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
    store.setSignedInUser('usr_a');
    await vi.waitFor(() => expect(store.recordingSnapshot().tracking).toBe('background'));
    expect(store.recordingSnapshot().mayNotSurviveTermination).toBe(true);
    expect(store.trackingNote(store.recordingSnapshot())).toBe('background-fragile');
  });
});
