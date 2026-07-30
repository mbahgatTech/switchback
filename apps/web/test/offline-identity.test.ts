/**
 * Who the browser is acting as, and what happens when that changes.
 *
 * The defect these are about needs no attacker and no unusual browser. One laptop, two people:
 * the first records a hike or writes a trail report with no signal and closes it; the second
 * opens it and signs in; the flusher mounted in the root layout runs on the second person's
 * first page and posts the first person's writes to the second person's account. The report is
 * an upsert keyed on trail and user, so it published on a public page under the wrong name,
 * and the device's only copy was deleted on the way.
 *
 * Two rules close it, and they are tested in two places. *Nothing is sent for anybody but the
 * reader* lives on the drains, and is exercised in `offline-queue.test.ts` and
 * `offline-activities.test.ts`. *The browser notices it has changed hands* lives here.
 *
 * Runs in the node environment with no jsdom, so `localStorage` and Cache Storage are stood up
 * as a few lines of Map each — enough for the exact surface these modules touch, and honest
 * about which calls they make.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetReader,
  heldForAnother,
  isUnattributed,
  ownedBy,
  rememberReader,
  rememberedReader,
  writingReader,
} from '../src/offline/identity';
import { clearReaderStorage, reconcileReader } from '../src/offline/handover';
import {
  getPendingReview,
  pendingReview,
  putPendingReview,
  type PendingReview,
} from '../src/offline/queue';

// ---------------------------------------------------------------------------
// The browser, in a few Maps
// ---------------------------------------------------------------------------

interface FakeRequest<T> {
  result: T | undefined;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

/** The same shape as the fake in `offline-queue.test.ts`, trimmed to what these tests reach. */
function createFakeIndexedDB(): unknown {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, string>();

  function transaction() {
    const tx: {
      oncomplete: (() => void) | null;
      onabort: (() => void) | null;
      objectStore: (name: string) => unknown;
    } = { oncomplete: null, onabort: null, objectStore: () => undefined };

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
            rows.set(String(row[keyPaths.get(name) ?? 'key']), row);
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
    deleteObjectStore: (name: string) => {
      stores.delete(name);
    },
    transaction,
    close: () => undefined,
  };

  return {
    open: () => {
      const request: FakeRequest<typeof db> & { transaction?: unknown } = {
        result: db,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
        transaction: transaction(),
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

function createFakeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/** Cache Storage as a set of names. Nothing here reads a cached response, only the keys. */
function createFakeCaches(names: readonly string[]): { store: Set<string>; api: CacheStorage } {
  const store = new Set(names);
  const api = {
    keys: () => Promise.resolve([...store]),
    delete: (name: string) => Promise.resolve(store.delete(name)),
    open: () =>
      Promise.resolve({
        delete: () => Promise.resolve(false),
        match: () => Promise.resolve(undefined),
        put: () => Promise.resolve(undefined),
      }),
    has: (name: string) => Promise.resolve(store.has(name)),
    match: () => Promise.resolve(undefined),
  } as unknown as CacheStorage;
  return { store, api };
}

const A = 'hiker-a';
const B = 'hiker-b';

function report(trailId: string, userId: string | null): PendingReview {
  return pendingReview({
    trailId,
    trailName: `Trail ${trailId}`,
    trailPath: `/trails/${trailId}`,
    write: { trailId, rating: 4, conditions: [], body: 'The ford below the col is impassable.' },
    at: 1_000,
    userId,
  });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
  vi.stubGlobal('localStorage', createFakeStorage());
  vi.stubGlobal('caches', createFakeCaches([]).api);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ownedBy', () => {
  it('matches only a row written under the reader signed in now', () => {
    expect(ownedBy({ userId: A }, A)).toBe(true);
    expect(ownedBy({ userId: A }, B)).toBe(false);
  });

  it('refuses a row nobody wrote, whoever is asking', () => {
    // Unattributed means "belongs to nobody", not "belongs to everybody" — which is the
    // difference between keeping a report for its author and publishing it under a stranger.
    expect(ownedBy({ userId: null }, A)).toBe(false);
    expect(ownedBy({ userId: null }, null)).toBe(false);
  });

  it('gives a signed-out browser nothing', () => {
    expect(ownedBy({ userId: A }, null)).toBe(false);
  });

  it('sorts a row into exactly one of the three groups the storage manager shows', () => {
    const mine = { userId: A };
    const theirs = { userId: B };
    const nobodys = { userId: null };

    expect([ownedBy(mine, A), isUnattributed(mine), heldForAnother(mine, A)]).toEqual([
      true,
      false,
      false,
    ]);
    expect([ownedBy(theirs, A), isUnattributed(theirs), heldForAnother(theirs, A)]).toEqual([
      false,
      false,
      true,
    ]);
    expect([ownedBy(nobodys, A), isUnattributed(nobodys), heldForAnother(nobodys, A)]).toEqual([
      false,
      true,
      false,
    ]);
  });
});

describe('the remembered reader', () => {
  it('tells "nobody is signed in" apart from "never asked"', () => {
    // The two look the same to anything writing a row and mean opposite things to the
    // handover: one is a fact to act on, the other is the first page since this shipped.
    expect(rememberedReader()).toEqual({ id: null, known: false });

    rememberReader(null);
    expect(rememberedReader()).toEqual({ id: null, known: true });

    rememberReader(A);
    expect(rememberedReader()).toEqual({ id: A, known: true });
    expect(writingReader()).toBe(A);

    forgetReader();
    expect(rememberedReader().known).toBe(false);
  });
});

describe('reconciling a change of reader', () => {
  it('records the first sighting without clearing anything', async () => {
    const { store, api } = createFakeCaches(['sb-shell-v1', 'sb-tiles-v1']);
    vi.stubGlobal('caches', api);

    const changed = await reconcileReader(A);

    // Not a change of hands: a browser with no memory is one that has not loaded a page since
    // this shipped, and taking every hiker's downloads away on that afternoon to guard
    // against a handover that probably did not happen is the wrong trade.
    expect(changed).toBe(false);
    expect([...store]).toEqual(['sb-shell-v1', 'sb-tiles-v1']);
    expect(rememberedReader()).toEqual({ id: A, known: true });
  });

  it('marks the departing reader rows rather than deleting them', async () => {
    rememberReader(A);
    await putPendingReview(report('a', A));

    expect(await reconcileReader(B)).toBe(true);

    const held = await getPendingReview(A, 'a');
    expect(held).not.toBeNull();
    expect(held?.userId).toBe(A);
    expect(held?.heldAt).not.toBeNull();
    // Word for word what was written. Marking is the whole policy; deleting would destroy the
    // only copy of it because a different person signed in.
    expect(held?.write.body).toBe('The ford below the col is impassable.');
  });

  it('marks on sign-out too, and releases on the way back', async () => {
    rememberReader(A);
    await putPendingReview(report('a', A));

    await reconcileReader(null);
    expect((await getPendingReview(A, 'a'))?.heldAt).not.toBeNull();
    expect(rememberedReader()).toEqual({ id: null, known: true });

    await reconcileReader(A);
    expect((await getPendingReview(A, 'a'))?.heldAt).toBeNull();
  });

  it('deletes the departing reader cached pages', async () => {
    rememberReader(A);
    const { store, api } = createFakeCaches([
      'sb-shell-v1',
      'sb-pages-v1',
      'sb-tiles-v1',
      'somebody-elses-cache',
    ]);
    vi.stubGlobal('caches', api);

    await reconcileReader(B);

    // Everything under `sb-` was fetched with the first reader's cookie: the shell holds
    // `/record` as it rendered for them, the pages hold their own hikes on those trails.
    // A cache this product does not own is not ours to remove.
    expect([...store]).toEqual(['somebody-elses-cache']);
  });

  it('does nothing at all when the reader has not changed', async () => {
    rememberReader(A);
    await putPendingReview(report('a', A));
    const { store, api } = createFakeCaches(['sb-shell-v1']);
    vi.stubGlobal('caches', api);

    expect(await reconcileReader(A)).toBe(false);

    expect([...store]).toEqual(['sb-shell-v1']);
    expect((await getPendingReview(A, 'a'))?.heldAt).toBeNull();
  });

  it('changes hands even when there is no Cache Storage to clear', async () => {
    rememberReader(A);
    await putPendingReview(report('a', A));
    vi.stubGlobal('caches', { keys: () => Promise.reject(new Error('denied')) });

    // A locked profile or a private window still has to be able to change hands. The queue
    // guard is what prevents the defect; the sweep is the disclosure half, and failing it
    // must not fail the sign-in.
    await expect(reconcileReader(B)).resolves.toBe(true);
    expect((await getPendingReview(A, 'a'))?.heldAt).not.toBeNull();
    expect(rememberedReader()).toEqual({ id: B, known: true });
  });
});

describe('clearReaderStorage', () => {
  it('leaves the queue alone', async () => {
    await putPendingReview(report('a', A));
    await putPendingReview(report('b', null));

    await clearReaderStorage();

    // The line this file draws twice: a download can be fetched again and a queued write
    // cannot, so the caches go and the queue stays.
    expect((await getPendingReview(A, 'a'))?.write.body).toBe(
      'The ford below the col is impassable.',
    );
    expect(await getPendingReview(null, 'b')).not.toBeNull();
  });
});
