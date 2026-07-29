import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewWrite } from '@switchback/core';
import {
  flushPendingReviews,
  getPendingReview,
  isUnreachable,
  listPendingReviews,
  pendingReview,
  putPendingReview,
} from '../src/offline/queue';

/**
 * The queue is the one place in this product where losing a byte loses something irreplaceable.
 *
 * A tile can be fetched again, a page can be rendered again, a photograph is still in the
 * camera roll. A report written on a ridge exists in exactly one place until it posts, so the
 * rules about when a row is kept, when it is marked, and when it is deleted are worth testing
 * directly rather than inferring from a green download button.
 *
 * `apps/web/test` runs in the node environment with no jsdom and no fake-indexeddb, so the
 * store is stood up here: a few dozen lines against the exact surface `idb.ts` uses. That is
 * cheaper than a dependency and it keeps the test honest about which API calls the code makes.
 */

interface FakeRequest<T> {
  result: T | undefined;
  error: unknown;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

/**
 * A database that lives in a Map.
 *
 * Callbacks fire on a microtask because the real ones do, and because the code under test
 * assigns its handlers *after* the call that will invoke them — a fake that fired
 * synchronously would call a handler that is still null and hang every promise.
 */
function createFakeIndexedDB(): unknown {
  const stores = new Map<string, Map<string, unknown>>();

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
        // After the request, as in a real transaction: `idb.ts` closes the connection here.
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
        put: (row: { trailId: string }) =>
          request(() => {
            rows.set(row.trailId, row);
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
    createObjectStore: (name: string) => {
      stores.set(name, new Map<string, unknown>());
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

const write = (trailId: string, rating: number): ReviewWrite => ({
  trailId,
  rating,
  body: 'The ford below the col is impassable.',
  hikedOn: '2026-07-04',
  conditions: ['muddy'],
});

/** Queue one row, at a chosen moment, so ordering can be asserted. */
function queue(trailId: string, at: number): Promise<void> {
  return putPendingReview(
    pendingReview({
      trailId,
      trailName: `Trail ${trailId}`,
      trailPath: `/trails/${trailId}`,
      write: write(trailId, 4),
      at,
    }),
  );
}

/** A tRPC client error the server did send: it has an envelope. */
function refusal(message: string): Error & { data: { code: string } } {
  return Object.assign(new Error(message), { data: { code: 'UNAUTHORIZED' } });
}

/** A tRPC client error where nothing came back at all. */
function unreachable(): Error & { data: null } {
  return Object.assign(new Error('Failed to fetch'), { data: null });
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', createFakeIndexedDB());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isUnreachable', () => {
  it('treats a failed fetch as unreachable', () => {
    // What `fetch` itself throws when the connection cannot be made.
    expect(isUnreachable(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('treats a tRPC error with no envelope as unreachable', () => {
    expect(isUnreachable(unreachable())).toBe(true);
    expect(isUnreachable({ data: undefined })).toBe(true);
  });

  it('treats a refusal the server issued as reachable', () => {
    // The distinction the whole retry policy rests on: this one must not be re-sent forever.
    expect(isUnreachable(refusal('Not signed in'))).toBe(false);
  });

  it('does not mistake an ordinary error or a non-object for a dead connection', () => {
    expect(isUnreachable(new Error('boom'))).toBe(false);
    expect(isUnreachable('offline')).toBe(false);
    expect(isUnreachable(null)).toBe(false);
    expect(isUnreachable(undefined)).toBe(false);
  });
});

describe('flushPendingReviews', () => {
  it('sends what is queued, oldest first, and forgets it afterwards', async () => {
    await queue('a', 1_000);
    await queue('b', 2_000);

    const sentIds: string[] = [];
    const result = await flushPendingReviews(async (payload) => {
      sentIds.push(payload.trailId);
      return undefined;
    });

    expect(sentIds).toEqual(['a', 'b']);
    expect(result).toEqual({ sent: 2, kept: 0 });
    expect(await listPendingReviews()).toEqual([]);
  });

  it('keeps and marks a report the server refuses, and carries on to the next', async () => {
    await queue('a', 1_000);
    await queue('b', 2_000);

    const result = await flushPendingReviews(async (payload) => {
      if (payload.trailId === 'a') throw refusal('Your session has expired.');
      return undefined;
    });

    expect(result).toEqual({ sent: 1, kept: 1 });
    const kept = await getPendingReview('a');
    expect(kept?.blocked).toBe(true);
    expect(kept?.attempts).toBe(1);
    expect(kept?.lastError).toBe('Your session has expired.');
    // The report itself is untouched — a refusal is not a reason to alter what was written.
    expect(kept?.write.body).toBe('The ford below the col is impassable.');
    expect(await getPendingReview('b')).toBeNull();
  });

  it('stops at the first sign the connection is gone', async () => {
    await queue('a', 1_000);
    await queue('b', 2_000);

    let calls = 0;
    const result = await flushPendingReviews(async () => {
      calls += 1;
      throw unreachable();
    });

    // One attempt, not two: the second would fail identically and cost a hiker battery.
    expect(calls).toBe(1);
    expect(result).toEqual({ sent: 0, kept: 2 });

    const first = await getPendingReview('a');
    expect(first?.attempts).toBe(1);
    expect(first?.blocked).toBe(false);
    expect(first?.lastError).toBeNull();
    // Untouched, so it keeps its place in the queue rather than jumping it.
    expect((await getPendingReview('b'))?.attempts).toBe(0);
  });

  it('skips a refused report on an automatic run and retries it when asked', async () => {
    await queue('a', 1_000);
    await flushPendingReviews(async () => {
      throw refusal('Your session has expired.');
    });

    let calls = 0;
    const automatic = await flushPendingReviews(async () => {
      calls += 1;
      return undefined;
    });
    expect(calls).toBe(0);
    expect(automatic).toEqual({ sent: 0, kept: 1 });

    const asked = await flushPendingReviews(async () => undefined, { force: true });
    expect(asked).toEqual({ sent: 1, kept: 0 });
  });

  it('sends only the trail asked for', async () => {
    await queue('a', 1_000);
    await queue('b', 2_000);

    const sentIds: string[] = [];
    const result = await flushPendingReviews(
      async (payload) => {
        sentIds.push(payload.trailId);
        return undefined;
      },
      { trailId: 'b' },
    );

    expect(sentIds).toEqual(['b']);
    expect(result).toEqual({ sent: 1, kept: 1 });
    expect((await listPendingReviews()).map((row) => row.trailId)).toEqual(['a']);
  });

  it('replaces an earlier draft for the same trail rather than queueing twice', async () => {
    await queue('a', 1_000);
    await putPendingReview(
      pendingReview({
        trailId: 'a',
        trailName: 'Trail a',
        trailPath: '/trails/a',
        write: write('a', 2),
        at: 5_000,
      }),
    );

    const rows = await listPendingReviews();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.write.rating).toBe(2);
  });
});
