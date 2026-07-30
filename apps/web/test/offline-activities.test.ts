import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackFix } from '@switchback/core';
import {
  chunkKey,
  claimLive,
  deleteActivity,
  drainNotice,
  flushPendingActivities,
  getPendingActivity,
  listPendingActivities,
  markFinished,
  newActivityId,
  pendingActivity,
  putActivityHeader,
  readFixes,
  readOpenActivity,
  releaseLive,
  setDrainNotice,
  writeChunk,
  type ActivityPosters,
  type FinishWrite,
  type PendingActivity,
} from '../src/offline/activities';

/**
 * A hike recorded with no signal exists in exactly one place until it drains.
 *
 * That makes the rules about when a row is kept, when its progress advances, and when it is
 * finally deleted worth testing directly — a green button on the storage manager proves
 * nothing about whether the same day would be uploaded twice, or half.
 *
 * `apps/web/test` runs in the node environment with no jsdom and no fake-indexeddb, so the
 * store is stood up here against the exact surface `idb.ts` uses. A near-copy of the fake in
 * `offline-queue.test.ts`, with one real difference — `put` reads the store's configured key
 * path rather than assuming `trailId`, because these two stores key on `activityId` and
 * `key`. Extracting a shared fake would be tidier; a local copy is chosen because it leaves
 * the reviews test byte-identical, which is the property most worth protecting here.
 */

interface FakeRequest<T> {
  result: T | undefined;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

function createFakeIndexedDB(): unknown {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, string>();

  function transaction(_name: string, _mode: string) {
    const tx: {
      oncomplete: (() => void) | null;
      onabort: (() => void) | null;
      objectStore: (name: string) => unknown;
    } = {
      oncomplete: null,
      onabort: null,
      objectStore: () => undefined,
    };

    function request<T>(compute: () => T): FakeRequest<T> {
      const pending: FakeRequest<T> = {
        result: undefined,
        error: null,
        onsuccess: null,
        onerror: null,
      };
      queueMicrotask(() => {
        pending.result = compute();
        pending.onsuccess?.();
        tx.oncomplete?.();
      });
      return pending;
    }

    tx.objectStore = (name: string) => {
      const rows = stores.get(name) ?? new Map<string, unknown>();
      stores.set(name, rows);
      return {
        getAll: () => request(() => [...rows.values()]),
        get: (key: string) => request(() => rows.get(key)),
        put: (row: Record<string, unknown>) =>
          request(() => {
            const path = keyPaths.get(name) ?? 'trailId';
            rows.set(String(row[path]), row);
            return undefined;
          }),
        delete: (key: string) =>
          request(() => {
            rows.delete(key);
            return undefined;
          }),
      };
    };

    return tx;
  }

  const db = {
    objectStoreNames: { contains: (name: string) => stores.has(name) },
    createObjectStore: (name: string, options?: { keyPath?: string }) => {
      stores.set(name, new Map<string, unknown>());
      if (options?.keyPath) keyPaths.set(name, options.keyPath);
      return {};
    },
    transaction,
    close: () => undefined,
  };

  return {
    open: () => {
      const request: FakeRequest<typeof db> = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

const ID = '6f8b1c2a-3d4e-4f50-9a1b-2c3d4e5f6071';

function fix(t: number): TrackFix {
  return { t, lng: -121.5 + t / 100_000, lat: 48.0 + t / 100_000, eleM: 900 + t };
}

const finishWrite = (id: string): FinishWrite => ({
  id,
  name: 'Vesper Peak',
  notes: null,
  visibility: 'private',
  trailId: 'trail-1',
  logCompletion: true,
});

/** Queue a hike with `count` fixes, laid out in chunks the way the recorder writes them. */
async function queueHike(
  id: string,
  count: number,
  overrides: Partial<PendingActivity> = {},
): Promise<void> {
  const fixes = Array.from({ length: count }, (_, i) => fix(i));
  for (let index = 0; index * 500 < Math.max(count, 1); index += 1) {
    await writeChunk({
      key: chunkKey(id, index),
      activityId: id,
      index,
      fixes: fixes.slice(index * 500, (index + 1) * 500),
    });
  }
  await putActivityHeader({
    ...pendingActivity({
      activityId: id,
      startedAt: 1_700_000_000_000,
      trailId: 'trail-1',
      trailName: 'Vesper Peak',
      activityType: 'hiking',
      serverStarted: false,
    }),
    count,
    ...overrides,
  });
}

/** Records what the server was asked to do, in order. */
function recorder(): { calls: string[]; posters: ActivityPosters } {
  const calls: string[] = [];
  return {
    calls,
    posters: {
      start: async (input) => {
        calls.push(`start:${input.id}`);
        return undefined;
      },
      append: async (input) => {
        calls.push(`append:${input.fixes[0]?.t}-${input.fixes[input.fixes.length - 1]?.t}`);
        return undefined;
      },
      finish: async (input) => {
        calls.push(`finish:${input.id}`);
        return undefined;
      },
    },
  };
}

/** A tRPC client error the server did send: it has an envelope. */
function refusal(message: string): Error & { data: { code: string } } {
  return Object.assign(new Error(message), { data: { code: 'BAD_REQUEST' } });
}

/** The server refused because nobody is signed in. Not a fault with the hike. */
function unauthorised(): Error & { data: { code: string; httpStatus: number } } {
  return Object.assign(new Error('Sign in to do that.'), {
    data: { code: 'UNAUTHORIZED', httpStatus: 401 },
  });
}

/** The server has no row under this id — swept out from under a header that says otherwise. */
function notFound(): Error & { data: { code: string } } {
  return Object.assign(new Error('No such recording.'), { data: { code: 'NOT_FOUND' } });
}

/** A tRPC client error where nothing came back at all. */
function unreachable(): Error & { data: null } {
  return Object.assign(new Error('Failed to fetch'), { data: null });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  releaseLive();
  // Module-level, and it outlives a store that is stood up fresh for every test.
  setDrainNotice(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  releaseLive();
});

describe('newActivityId', () => {
  it('mints a v4 UUID the server will accept', () => {
    const id = newActivityId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(newActivityId()).not.toBe(id);
  });

  it('still mints one where randomUUID is missing, as it is on a bare http origin', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    expect(newActivityId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
  });
});

describe('the journal', () => {
  it('round-trips a header', async () => {
    await queueHike(ID, 3);
    const row = await getPendingActivity(ID);
    expect(row?.activityId).toBe(ID);
    expect(row?.trailName).toBe('Vesper Peak');
    expect(row?.serverStarted).toBe(false);
    expect(row?.count).toBe(3);
  });

  it('reassembles chunked fixes in index order across a 500 boundary', async () => {
    await queueHike(ID, 1_200);
    const fixes = await readFixes(ID);
    expect(fixes).toHaveLength(1_200);
    // In order and complete: the chunk boundary is where a lexical sort of the keys would
    // have gone wrong without the padding, and where an off-by-one would drop a fix.
    expect(fixes.map((f) => f.t)).toEqual(Array.from({ length: 1_200 }, (_, i) => i));
  });

  it('does not offer a finished hike back to the recorder as an open one', async () => {
    await queueHike(ID, 10);
    await markFinished(ID, finishWrite(ID));
    expect(await readOpenActivity()).toBeNull();
    // Still queued, though: it is a debt, not a deletion.
    expect(await listPendingActivities()).toHaveLength(1);
  });

  it('hands an unfinished hike back with its fixes', async () => {
    await queueHike(ID, 7, { sent: 3 });
    const open = await readOpenActivity();
    expect(open?.header.sent).toBe(3);
    expect(open?.fixes).toHaveLength(7);
  });

  it('removes the header and every chunk when a hike is discarded', async () => {
    await queueHike(ID, 900);
    await deleteActivity(ID);
    expect(await listPendingActivities()).toEqual([]);
    expect(await readFixes(ID)).toEqual([]);
  });
});

describe('flushPendingActivities', () => {
  it('starts, appends and finishes in that order, then forgets the hike', async () => {
    await queueHike(ID, 600);
    await markFinished(ID, finishWrite(ID));

    const { calls, posters } = recorder();
    const result = await flushPendingActivities(posters);

    expect(calls).toEqual([`start:${ID}`, 'append:0-499', 'append:500-599', `finish:${ID}`]);
    expect(result).toEqual({ sent: 1, kept: 0, truncated: 0 });
    expect(await listPendingActivities()).toEqual([]);
    expect(await readFixes(ID)).toEqual([]);
  });

  it('keeps the write when the flush fails, and resumes without re-sending what landed', async () => {
    await queueHike(ID, 1_500);
    await markFinished(ID, finishWrite(ID));

    // Dies part-way through: the first batch lands, the second does not.
    let appends = 0;
    const first = recorder();
    await flushPendingActivities({
      ...first.posters,
      append: async (input) => {
        appends += 1;
        if (appends === 2) throw unreachable();
        return first.posters.append(input);
      },
    });

    const kept = await getPendingActivity(ID);
    expect(kept?.serverStarted).toBe(true);
    expect(kept?.sent).toBe(500);
    expect(kept?.attempts).toBe(1);
    expect(kept?.blocked).toBe(false);
    expect(kept?.lastError).toBeNull();

    // Reconnected. The retry picks up at 500 and re-sends nothing already acknowledged —
    // and does not repeat `start`, because the server has that hike under this id already.
    const second = recorder();
    const result = await flushPendingActivities(second.posters);
    expect(second.calls).toEqual(['append:500-999', 'append:1000-1499', `finish:${ID}`]);
    expect(result).toEqual({ sent: 1, kept: 0, truncated: 0 });
  });

  it('replays start when the response was lost, and never posts a second hike', async () => {
    await queueHike(ID, 100);
    await markFinished(ID, finishWrite(ID));

    // The server took the start and the answer never came back.
    const lost = recorder();
    await flushPendingActivities({
      ...lost.posters,
      start: async (input) => {
        lost.calls.push(`start:${input.id}`);
        throw unreachable();
      },
    });
    expect((await getPendingActivity(ID))?.serverStarted).toBe(false);

    const again = recorder();
    await flushPendingActivities(again.posters);
    // The same id both times, which is what makes the replay land on the same row rather
    // than opening a second recording of the same day.
    expect(lost.calls).toEqual([`start:${ID}`]);
    expect(again.calls[0]).toBe(`start:${ID}`);
    expect(again.calls.filter((c) => c.startsWith('start:'))).toHaveLength(1);
  });

  it('stops at the first sign the connection is gone', async () => {
    await queueHike(ID, 10);
    await markFinished(ID, finishWrite(ID));
    const other = '11111111-2222-4333-8444-555555555555';
    await queueHike(other, 10, { queuedAt: 1_800_000_000_000 });
    await markFinished(other, finishWrite(other));

    let starts = 0;
    const result = await flushPendingActivities({
      start: async () => {
        starts += 1;
        throw unreachable();
      },
      append: async () => undefined,
      finish: async () => undefined,
    });

    // One attempt, not two: the second would fail identically and cost a hiker battery.
    expect(starts).toBe(1);
    expect(result).toEqual({ sent: 0, kept: 2, truncated: 0 });
    expect((await getPendingActivity(other))?.attempts).toBe(0);
  });

  it('blocks a hike the server refuses and carries on to the next', async () => {
    await queueHike(ID, 10);
    await markFinished(ID, finishWrite(ID));
    const other = '11111111-2222-4333-8444-555555555555';
    await queueHike(other, 10, { queuedAt: 1_800_000_000_000 });
    await markFinished(other, finishWrite(other));

    const result = await flushPendingActivities({
      start: async (input) => {
        if (input.id === ID) throw refusal('That recording is not yours.');
        return undefined;
      },
      append: async () => undefined,
      finish: async () => undefined,
    });

    expect(result).toEqual({ sent: 1, kept: 1, truncated: 0 });
    const blocked = await getPendingActivity(ID);
    expect(blocked?.blocked).toBe(true);
    expect(blocked?.lastError).toBe('That recording is not yours.');
    expect(await getPendingActivity(other)).toBeNull();
  });

  it('leaves a blocked hike alone automatically and sends it when a person asks', async () => {
    await queueHike(ID, 10);
    await markFinished(ID, finishWrite(ID));
    await flushPendingActivities({
      start: async () => {
        throw refusal('That recording is not yours.');
      },
      append: async () => undefined,
      finish: async () => undefined,
    });

    const automatic = recorder();
    expect(await flushPendingActivities(automatic.posters)).toEqual({
      sent: 0,
      kept: 1,
      truncated: 0,
    });
    expect(automatic.calls).toEqual([]);

    const asked = recorder();
    expect(await flushPendingActivities(asked.posters, { force: true })).toEqual({
      sent: 1,
      kept: 0,
      truncated: 0,
    });
  });

  it('does not block a hike over a session that had expired, and sends it after a sign-in', async () => {
    await queueHike(ID, 10);
    await markFinished(ID, finishWrite(ID));

    // A signed-out visit, or a session that lapsed in a valley. `SyncQueuedWrites` is mounted
    // for everybody, so this drain runs whether or not anybody has signed in.
    const refused = await flushPendingActivities({
      start: async () => {
        throw unauthorised();
      },
      append: async () => undefined,
      finish: async () => undefined,
    });
    expect(refused).toEqual({ sent: 0, kept: 1, truncated: 0 });

    const waiting = await getPendingActivity(ID);
    // Not blocked, and not labelled with a fault it does not have: blocked rows are only ever
    // retried from a button on `/downloads`, which is not a page a hiker has any reason to
    // open, so this used to lose the hike to a page nobody visits.
    expect(waiting?.blocked).toBe(false);
    expect(waiting?.lastError).toBeNull();

    // Signing back in re-mounts the layout, which flushes. Nothing had to be pressed.
    const after = recorder();
    expect(await flushPendingActivities(after.posters)).toEqual({
      sent: 1,
      kept: 0,
      truncated: 0,
    });
    expect(after.calls).toEqual([`start:${ID}`, 'append:0-9', `finish:${ID}`]);
  });

  it('finishes a replayed hike whose delete failed, and reports no loss', async () => {
    // Everything was acknowledged and `finish` landed; only the delete did not. The append
    // loop has nothing outstanding, so the server is never asked to take another fix.
    await queueHike(ID, 10, { serverStarted: true, sent: 10 });
    await markFinished(ID, finishWrite(ID));

    const { calls, posters } = recorder();
    const result = await flushPendingActivities(posters);

    expect(calls).toEqual([`finish:${ID}`]);
    expect(result).toEqual({ sent: 1, kept: 0, truncated: 0 });
    expect(await listPendingActivities()).toEqual([]);
  });

  it('says so when a recording was closed before this device had sent all of it', async () => {
    // The shape that used to be silent: the router's stale sweep closes every earlier open
    // recording the moment a new one starts, so a hike still draining is closed under it and
    // every remaining fix is refused. Ten fixes queued, none acknowledged.
    await queueHike(ID, 10, { serverStarted: true });
    await markFinished(ID, finishWrite(ID));

    const { calls, posters } = recorder();
    const result = await flushPendingActivities({
      ...posters,
      append: async () => {
        calls.push('append:refused');
        throw refusal('That recording is already finished.');
      },
    });

    // What can be landed is landed. What was lost is counted and said out loud, rather than
    // reported as a clean upload of a hike that is now two hours short.
    expect(calls).toEqual(['append:refused', `finish:${ID}`]);
    expect(result).toEqual({ sent: 1, kept: 0, truncated: 1 });
    expect(drainNotice()).toContain('closed before all of it had been sent');
  });

  it('does not leave an unfinished hike blocked for ever once the server has closed it', async () => {
    // Recorded, navigated away from without pressing Finish, and closed by the next `start`.
    // Nothing can ever be appended to it again, so a row that only offers "Add it now" is a
    // permanent error with no working control on it.
    await queueHike(ID, 10, { serverStarted: true });

    const { calls, posters } = recorder();
    const result = await flushPendingActivities({
      ...posters,
      append: async () => {
        calls.push('append:refused');
        throw refusal('That recording is already finished.');
      },
    });

    expect(calls).toEqual(['append:refused']);
    expect(result).toEqual({ sent: 1, kept: 0, truncated: 1 });
    expect(await listPendingActivities()).toEqual([]);
  });

  it('re-announces a hike whose server row was swept away, rather than blocking it for ever', async () => {
    // `start` was acknowledged at the car park and the signal died before the first upload,
    // so the sweep found a recording with no samples and deleted it — under a header that
    // still says `serverStarted`.
    await queueHike(ID, 10, { serverStarted: true });
    await markFinished(ID, finishWrite(ID));

    const { calls, posters } = recorder();
    let refusals = 0;
    const result = await flushPendingActivities({
      ...posters,
      append: async (input) => {
        refusals += 1;
        if (refusals === 1) {
          calls.push('append:missing');
          throw notFound();
        }
        return posters.append(input);
      },
    });

    expect(calls).toEqual(['append:missing', `start:${ID}`, 'append:0-9', `finish:${ID}`]);
    expect(result).toEqual({ sent: 1, kept: 0, truncated: 0 });
  });

  it('gives up on a hike the server keeps losing, rather than re-announcing for ever', async () => {
    await queueHike(ID, 10, { serverStarted: true });
    await markFinished(ID, finishWrite(ID));

    let appends = 0;
    const { posters } = recorder();
    const result = await flushPendingActivities({
      ...posters,
      append: async () => {
        appends += 1;
        throw notFound();
      },
    });

    expect(appends).toBe(2);
    expect(result).toEqual({ sent: 0, kept: 1, truncated: 0 });
    expect((await getPendingActivity(ID))?.blocked).toBe(true);
  });

  it('abandons a hike discarded while it was uploading rather than publishing it', async () => {
    await queueHike(ID, 1_000, { serverStarted: true });
    await markFinished(ID, finishWrite(ID));

    const { calls, posters } = recorder();
    const result = await flushPendingActivities({
      ...posters,
      append: async (input) => {
        const answer = await posters.append(input);
        // The reader presses Discard on `/downloads` mid-drain. Nothing cancels the run.
        await deleteActivity(ID);
        return answer;
      },
    });

    // No `finish`, and no further appends: a hike somebody threw away must not appear in
    // their account, and finishing it would also log a completion and a point of popularity
    // against the trail. The row must not come back either — writing progress onto a deleted
    // key re-creates it.
    expect(calls).toEqual(['append:0-499']);
    expect(result).toEqual({ sent: 0, kept: 0, truncated: 0 });
    expect(await listPendingActivities()).toEqual([]);
  });

  it('runs one drain at a time when two callers ask at once', async () => {
    // A phone unlocked as its radio reattaches fires `online` and `visibilitychange` in the
    // same tick. Both used to snapshot the same queue and send the whole hike twice.
    await queueHike(ID, 10);
    await markFinished(ID, finishWrite(ID));

    const { calls, posters } = recorder();
    const [first, second] = await Promise.all([
      flushPendingActivities(posters),
      flushPendingActivities(posters),
    ]);

    expect(calls).toEqual([`start:${ID}`, 'append:0-9', `finish:${ID}`]);
    expect(first).toEqual({ sent: 1, kept: 0, truncated: 0 });
    expect(second).toEqual({ sent: 0, kept: 0, truncated: 0 });
  });

  it('lands what fits when the recording has reached its maximum length, and says so', async () => {
    await queueHike(ID, 10, { serverStarted: true });
    await markFinished(ID, finishWrite(ID));

    const { calls, posters } = recorder();
    const result = await flushPendingActivities({
      ...posters,
      append: async () => {
        throw refusal(
          'This recording has reached its maximum length. Finish it and start another.',
        );
      },
    });

    expect(calls).toEqual([`finish:${ID}`]);
    // Losing the tail is better than losing the hike — but it is counted, not swallowed.
    expect(result).toEqual({ sent: 1, kept: 0, truncated: 1 });
  });

  it('blocks a full recording nobody has finished, which can still be ended from /record', async () => {
    await queueHike(ID, 10, { serverStarted: true });

    const { posters } = recorder();
    const result = await flushPendingActivities({
      ...posters,
      append: async () => {
        throw refusal(
          'This recording has reached its maximum length. Finish it and start another.',
        );
      },
    });

    expect(result).toEqual({ sent: 0, kept: 1, truncated: 0 });
    const kept = await getPendingActivity(ID);
    expect(kept?.blocked).toBe(true);
    expect(kept?.lastError).toContain('maximum length');
  });

  it('leaves the recorder to upload the hike it is still recording', async () => {
    await queueHike(ID, 10);
    claimLive(ID);

    const { calls, posters } = recorder();
    expect(await flushPendingActivities(posters)).toEqual({ sent: 0, kept: 1, truncated: 0 });
    // Both would otherwise write `sent` on the same row and the loser would re-send a batch.
    expect(calls).toEqual([]);

    releaseLive(ID);
    const after = recorder();
    await flushPendingActivities(after.posters);
    expect(after.calls).toEqual([`start:${ID}`, 'append:0-9']);
  });

  it('catches an unfinished hike up without deleting it', async () => {
    // The tab was closed mid-hike, so nothing ever pressed Finish. The fixes still belong on
    // the server; the row stays so the recording can be picked back up and ended properly.
    await queueHike(ID, 10);

    const { calls, posters } = recorder();
    const result = await flushPendingActivities(posters);

    expect(calls).toEqual([`start:${ID}`, 'append:0-9']);
    expect(result).toEqual({ sent: 0, kept: 1, truncated: 0 });
    expect((await getPendingActivity(ID))?.sent).toBe(10);
  });

  it('sends only the hike asked for', async () => {
    await queueHike(ID, 10);
    await markFinished(ID, finishWrite(ID));
    const other = '11111111-2222-4333-8444-555555555555';
    await queueHike(other, 10, { queuedAt: 1_800_000_000_000 });
    await markFinished(other, finishWrite(other));

    const { calls, posters } = recorder();
    const result = await flushPendingActivities(posters, { activityId: other });

    expect(calls).toEqual([`start:${other}`, 'append:0-9', `finish:${other}`]);
    expect(result).toEqual({ sent: 1, kept: 1, truncated: 0 });
    expect((await listPendingActivities()).map((row) => row.activityId)).toEqual([ID]);
  });
});
