/**
 * The browser noticing it has changed hands. The other half of the rule — nothing is sent for
 * anybody but the reader — lives on the drains and is exercised in the other two offline tests.
 *
 * Runs in the node environment with no jsdom, so `localStorage` and Cache Storage are stood up as
 * a few lines of Map each: the exact surface these modules touch, and honest about which calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  forgetReader,
  heldForAnother,
  isUnattributed,
  ownedBy,
  readerKeyChanged,
  rememberReader,
  rememberedReader,
  writingReader,
} from '../src/offline/identity';
import {
  ASSET_CACHE,
  LEGACY_SHELL_CACHE,
  MEDIA_CACHE,
  PAGE_CACHE,
  READER_SHELL_PAGES,
  SHELL_CACHE,
  SHELL_PAGES,
  TILE_CACHE,
} from '../src/offline/caches';
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

/** Cache Storage as a set of names, plus the keys stored inside each one. */
function createFakeCaches(names: readonly string[]): {
  store: Set<string>;
  entries: Map<string, Set<string>>;
  api: CacheStorage;
} {
  const store = new Set(names);
  const entries = new Map<string, Set<string>>();
  const api = {
    keys: () => Promise.resolve([...store]),
    delete: (name: string) => Promise.resolve(store.delete(name)),
    open: (name: string) => {
      const keys = entries.get(name) ?? new Set<string>();
      entries.set(name, keys);
      return Promise.resolve({
        delete: (key: string) => Promise.resolve(keys.delete(key)),
        match: () => Promise.resolve(undefined),
        put: () => Promise.resolve(undefined),
      });
    },
    has: (name: string) => Promise.resolve(store.has(name)),
    match: () => Promise.resolve(undefined),
  } as unknown as CacheStorage;
  return { store, entries, api };
}

/** A shell cache holding everything the worker precaches, so a sweep can be seen to be scoped. */
function shellHolding(
  entries: Map<string, Set<string>>,
  paths: readonly string[] = [...SHELL_PAGES, '/_next/static/chunks/main-9f2c.js'],
): Set<string> {
  const keys = new Set(paths);
  entries.set(SHELL_CACHE, keys);
  return keys;
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

  it('notices the key another tab moved, and a wholesale clear', () => {
    // A null key means another document called `clear()`, which takes the reader with it.
    expect(readerKeyChanged('sb-reader')).toBe(true);
    expect(readerKeyChanged(null)).toBe(true);
    expect(readerKeyChanged('sb-units')).toBe(false);
  });
});

describe('the reader a write is stamped with', () => {
  it('is read from storage at the moment of the write, not from a render', () => {
    // A second tab left open while somebody signs in on the first holds a render that says A
    // while its next request carries B's cookie.
    rememberReader(A);
    expect(writingReader()).toBe(A);

    // What the other tab did.
    rememberReader(B);
    expect(writingReader()).toBe(B);
    expect(ownedBy({ userId: A }, writingReader())).toBe(false);
  });
});

describe('reconciling a change of reader', () => {
  it('records the first sighting without clearing anything', async () => {
    const { store, api } = createFakeCaches([SHELL_CACHE, TILE_CACHE]);
    vi.stubGlobal('caches', api);

    const changed = await reconcileReader(A);

    // Not a change of hands: a browser with no memory has not loaded a page since this shipped.
    expect(changed).toBe(false);
    expect([...store]).toEqual([SHELL_CACHE, TILE_CACHE]);
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
    const { store, entries, api } = createFakeCaches([
      SHELL_CACHE,
      ASSET_CACHE,
      PAGE_CACHE,
      TILE_CACHE,
      LEGACY_SHELL_CACHE,
      'somebody-elses-cache',
    ]);
    const shell = shellHolding(entries);
    vi.stubGlobal('caches', api);

    await reconcileReader(B);

    // This build's shell is not dropped by name — it also holds the offline fallback, the
    // storage manager and the build assets those need — so only its per-reader pages go. The
    // previous build's shell goes whole: `adoptLegacyShell` has already taken its chunks.
    expect([...store]).toEqual([SHELL_CACHE, 'somebody-elses-cache']);
    for (const path of READER_SHELL_PAGES) expect(shell.has(path)).toBe(false);
    expect([...shell]).toEqual(['/offline', '/downloads', '/_next/static/chunks/main-9f2c.js']);
  });

  it('keeps the downloads of somebody signing in for the first time', async () => {
    // A download needs no account, so this is the ordinary order of events: acquire trails
    // signed out, sign in afterwards. Nothing in those caches was fetched under a name.
    rememberReader(null);
    const { store, entries, api } = createFakeCaches([SHELL_CACHE, TILE_CACHE]);
    const shell = shellHolding(entries);
    vi.stubGlobal('caches', api);

    expect(await reconcileReader(A)).toBe(true);

    expect([...store]).toEqual([SHELL_CACHE, TILE_CACHE]);
    expect([...shell]).toEqual([...SHELL_PAGES, '/_next/static/chunks/main-9f2c.js']);
    expect(rememberedReader()).toEqual({ id: A, known: true });
  });

  it('clears on the way out, when a named reader signs out', async () => {
    // Somebody to nobody is a person leaving a machine, and what they leave behind was fetched
    // under their name.
    rememberReader(A);
    const { store, api } = createFakeCaches([TILE_CACHE]);
    vi.stubGlobal('caches', api);

    await reconcileReader(null);

    expect([...store]).toEqual([]);
  });

  it('does nothing at all when the reader has not changed', async () => {
    rememberReader(A);
    await putPendingReview(report('a', A));
    const { store, api } = createFakeCaches([SHELL_CACHE]);
    vi.stubGlobal('caches', api);

    expect(await reconcileReader(A)).toBe(false);

    expect([...store]).toEqual([SHELL_CACHE]);
    expect((await getPendingReview(A, 'a'))?.heldAt).toBeNull();
  });

  it('changes hands even when there is no Cache Storage to clear', async () => {
    rememberReader(A);
    await putPendingReview(report('a', A));
    vi.stubGlobal('caches', { keys: () => Promise.reject(new Error('denied')) });

    // `ownedBy` is what prevents the defect; failing the disclosure half must not fail sign-in.
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

  it('keeps the download caches when the ledger cannot be read', async () => {
    const { store, entries, api } = createFakeCaches([
      SHELL_CACHE,
      TILE_CACHE,
      PAGE_CACHE,
      MEDIA_CACHE,
      ASSET_CACHE,
    ]);
    const shell = shellHolding(entries);
    vi.stubGlobal('caches', api);
    vi.stubGlobal('indexedDB', {
      open: () => {
        throw new Error('The profile is locked.');
      },
    });

    await clearReaderStorage();

    // Ledger rows survive an unreadable store, so their bytes must survive with them — including
    // `ASSET_CACHE`, which `handleStatic` looks in second for a downloaded page's hashed URLs.
    // The reader-specific pages still go: they are in no ledger and nothing lies about them.
    expect([...store]).toEqual([SHELL_CACHE, TILE_CACHE, PAGE_CACHE, MEDIA_CACHE, ASSET_CACHE]);
    expect([...shell]).toEqual(['/offline', '/downloads', '/_next/static/chunks/main-9f2c.js']);
  });
});
