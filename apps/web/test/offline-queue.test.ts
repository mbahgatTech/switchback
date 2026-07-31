import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewWrite } from '@switchback/core';
import {
  adoptPendingReview,
  flushPendingReviews,
  getPendingReview,
  holdReviewsFor,
  isUnreachable,
  listPendingReviews,
  pendingReview,
  putPendingReview,
  releaseReviewsFor,
  type FlushOptions,
  type FlushResult,
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
function createFakeIndexedDB(seed: Record<string, Array<Record<string, unknown>>> = {}): unknown {
  const stores = new Map<string, Map<string, unknown>>();
  const keyPaths = new Map<string, string>();

  // Rows the browser already held before the version this test is exercising. Seeded with the
  // key they were stored under, because a store that predates the upgrade predates its key
  // path too — which is exactly what the upgrade has to cope with.
  for (const [name, rows] of Object.entries(seed)) {
    stores.set(name, new Map(rows.map((row) => [String(row.trailId ?? row.key), row])));
  }

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
        // The key path the store was created with, so a fake stays honest about a schema
        // where the two queues and the ledger no longer key on the same field.
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
      keyPaths.delete(name);
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
        // The version-change transaction, which the upgrade uses to carry the old review
        // queue into the new one. A real one spans the whole upgrade; this one is a plain
        // transaction over the same stores, which is all `carryReviewsForward` asks of it.
        transaction: transaction('upgrade', 'versionchange'),
      };
      queueMicrotask(() => {
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

/** The one hiker every case below runs as, unless it says otherwise. */
const HIKER = 'hiker-a';

/**
 * `flushPendingReviews`, as that hiker. Ownership gets its own block at the end.
 *
 * `stillReader` defaults to "the same person all the way through", which is every case except
 * the ones that deliberately change it mid-drain.
 */
function flush(
  post: (write: ReviewWrite) => Promise<unknown>,
  options: Partial<FlushOptions> = {},
): Promise<FlushResult> {
  return flushPendingReviews(post, {
    readerId: HIKER,
    stillReader: () => HIKER,
    ...options,
  });
}

const write = (trailId: string, rating: number): ReviewWrite => ({
  trailId,
  rating,
  body: 'The ford below the col is impassable.',
  hikedOn: '2026-07-04',
  conditions: ['muddy'],
});

/** Queue one row, at a chosen moment, so ordering can be asserted. */
function queue(trailId: string, at: number, userId: string | null = HIKER): Promise<void> {
  return putPendingReview(
    pendingReview({
      trailId,
      trailName: `Trail ${trailId}`,
      trailPath: `/trails/${trailId}`,
      write: write(trailId, 4),
      at,
      userId,
    }),
  );
}

/** A tRPC client error the server did send: it has an envelope. */
function refusal(message: string): Error & { data: { code: string } } {
  return Object.assign(new Error(message), { data: { code: 'BAD_REQUEST' } });
}

/** The server refused because nobody is signed in. Not a fault with the report. */
function unauthorised(): Error & { data: { code: string; httpStatus: number } } {
  return Object.assign(new Error('Sign in to do that.'), {
    data: { code: 'UNAUTHORIZED', httpStatus: 401 },
  });
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
    const result = await flush(async (payload) => {
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

    const result = await flush(async (payload) => {
      if (payload.trailId === 'a') throw refusal('That trail no longer exists.');
      return undefined;
    });

    expect(result).toEqual({ sent: 1, kept: 1 });
    const kept = await getPendingReview(HIKER, 'a');
    expect(kept?.blocked).toBe(true);
    expect(kept?.attempts).toBe(1);
    expect(kept?.lastError).toBe('That trail no longer exists.');
    // The report itself is untouched — a refusal is not a reason to alter what was written.
    expect(kept?.write.body).toBe('The ford below the col is impassable.');
    expect(await getPendingReview(HIKER, 'b')).toBeNull();
  });

  it('stops at the first sign the connection is gone', async () => {
    await queue('a', 1_000);
    await queue('b', 2_000);

    let calls = 0;
    const result = await flush(async () => {
      calls += 1;
      throw unreachable();
    });

    // One attempt, not two: the second would fail identically and cost a hiker battery.
    expect(calls).toBe(1);
    expect(result).toEqual({ sent: 0, kept: 2 });

    const first = await getPendingReview(HIKER, 'a');
    expect(first?.attempts).toBe(1);
    expect(first?.blocked).toBe(false);
    expect(first?.lastError).toBeNull();
    // Untouched, so it keeps its place in the queue rather than jumping it.
    expect((await getPendingReview(HIKER, 'b'))?.attempts).toBe(0);
  });

  it('does not refuse a report for good over a session that had expired', async () => {
    await queue('a', 1_000);

    // Blocked rows are only ever retried by a person pressing a button on `/downloads`, so
    // treating "sign in to do that" as a refusal of the report loses it to a page the reader
    // has no reason to open. An auth failure waits for a session instead.
    const refused = await flush(async () => {
      throw unauthorised();
    });
    expect(refused).toEqual({ sent: 0, kept: 1 });

    const waiting = await getPendingReview(HIKER, 'a');
    expect(waiting?.blocked).toBe(false);
    expect(waiting?.lastError).toBeNull();

    // An ordinary automatic flush after signing back in, with nothing pressed.
    expect(await flush(async () => undefined)).toEqual({ sent: 1, kept: 0 });
  });

  it('skips a refused report on an automatic run and retries it when asked', async () => {
    await queue('a', 1_000);
    await flush(async () => {
      throw refusal('That trail no longer exists.');
    });

    let calls = 0;
    const automatic = await flush(async () => {
      calls += 1;
      return undefined;
    });
    expect(calls).toBe(0);
    expect(automatic).toEqual({ sent: 0, kept: 1 });

    const asked = await flush(async () => undefined, { force: true });
    expect(asked).toEqual({ sent: 1, kept: 0 });
  });

  it('sends only the trail asked for', async () => {
    await queue('a', 1_000);
    await queue('b', 2_000);

    const sentIds: string[] = [];
    const result = await flush(
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
        userId: HIKER,
      }),
    );

    const rows = await listPendingReviews();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.write.rating).toBe(2);
  });
});

/**
 * Whose report is whose.
 *
 * The case these exist for is one browser and two people: somebody writes a report on a ridge
 * with no signal and closes the laptop, and the next person to sit down signs in. Before a row
 * carried an author, the drain that runs on every page load posted the first person's words to
 * the second person's account — under an upsert keyed on trail and user, so they published on
 * a public trail page under a name that was not theirs, and the only copy was consumed on the
 * way out.
 */
describe('a report belongs to whoever wrote it', () => {
  const OTHER = 'hiker-b';

  it('is not sent under a different account', async () => {
    await queue('a', 1_000, HIKER);

    const sent: string[] = [];
    const result = await flushPendingReviews(
      async (payload) => {
        sent.push(payload.trailId);
        return undefined;
      },
      { readerId: OTHER, stillReader: () => OTHER },
    );

    expect(sent).toEqual([]);
    expect(result).toEqual({ sent: 0, kept: 1 });
    // Kept whole and still the first hiker's: not adopted, not marked as refused, not touched.
    const kept = await getPendingReview(HIKER, 'a');
    expect(kept?.userId).toBe(HIKER);
    expect(kept?.attempts).toBe(0);
    expect(kept?.write.body).toBe('The ford below the col is impassable.');
  });

  it('is not sent under a different account even when a person presses the button', async () => {
    await queue('a', 1_000, HIKER);

    // `force` is what a press on `/downloads` passes, and it overrides a refusal by the
    // server. It does not override this: whose the report is was never in question.
    const result = await flushPendingReviews(async () => undefined, {
      readerId: OTHER,
      stillReader: () => OTHER,
      force: true,
      trailId: 'a',
    });

    expect(result).toEqual({ sent: 0, kept: 1 });
    expect(await getPendingReview(HIKER, 'a')).not.toBeNull();
  });

  it('goes out the moment its own author is back', async () => {
    await queue('a', 1_000, HIKER);
    await flushPendingReviews(async () => undefined, {
      readerId: OTHER,
      stillReader: () => OTHER,
    });
    expect(await flush(async () => undefined)).toEqual({ sent: 1, kept: 0 });
  });

  it('does not displace another hiker report about the same trail', async () => {
    await queue('a', 1_000, HIKER);
    await queue('a', 2_000, OTHER);

    // The store used to key on the trail alone, so the second of these silently replaced the
    // first — one person's report destroyed by another person writing about the same hill.
    expect(await listPendingReviews()).toHaveLength(2);
    expect((await getPendingReview(HIKER, 'a'))?.userId).toBe(HIKER);
    expect((await getPendingReview(OTHER, 'a'))?.userId).toBe(OTHER);

    const sent: string[] = [];
    await flush(async (payload) => {
      sent.push(payload.trailId);
      return undefined;
    });
    expect(sent).toEqual(['a']);
    // Only the reader's own went. The other is untouched and still theirs.
    expect(await getPendingReview(OTHER, 'a')).not.toBeNull();
  });

  it('is not sent at all while nobody is signed in', async () => {
    await queue('a', 1_000, HIKER);
    await queue('b', 2_000, null);

    let calls = 0;
    const result = await flushPendingReviews(
      async () => {
        calls += 1;
        return undefined;
      },
      { readerId: null, stillReader: () => null, force: true },
    );

    expect(calls).toBe(0);
    expect(result).toEqual({ sent: 0, kept: 2 });
  });

  it('stops the moment somebody else signs in part-way through a drain', async () => {
    // A shared laptop. The first hiker left a tab open with three reports queued; the second
    // signs in on another tab while the drain is running. From that instant the cookie the
    // browser attaches is the second person's, and every remaining post would publish the
    // first person's words under the second person's name.
    await queue('a', 1_000, HIKER);
    await queue('b', 2_000, HIKER);
    await queue('c', 3_000, HIKER);

    let here: string | null = HIKER;
    const sent: string[] = [];
    const result = await flushPendingReviews(
      async (payload) => {
        sent.push(payload.trailId);
        if (payload.trailId === 'a') here = 'hiker-b';
        return undefined;
      },
      { readerId: HIKER, stillReader: () => here },
    );

    // The one in flight when it changed is allowed to land; nothing after it is attempted.
    expect(sent).toEqual(['a']);
    expect(result).toEqual({ sent: 1, kept: 2 });
    // And the two left behind are untouched — no attempt counted, nothing blocked, still the
    // first hiker's. They go out on the next drain that runs as that person.
    for (const trailId of ['b', 'c']) {
      const kept = await getPendingReview(HIKER, trailId);
      expect(kept?.userId).toBe(HIKER);
      expect(kept?.attempts).toBe(0);
      expect(kept?.blocked).toBe(false);
    }
  });

  it('sends nothing when the reader changed before the first request', async () => {
    await queue('a', 1_000, HIKER);

    let calls = 0;
    const result = await flushPendingReviews(
      async () => {
        calls += 1;
        return undefined;
      },
      { readerId: HIKER, stillReader: () => 'hiker-b', force: true },
    );

    expect(calls).toBe(0);
    expect(result).toEqual({ sent: 0, kept: 1 });
  });
});

/**
 * Reports the device cannot name an author for.
 *
 * Every row queued before authorship was recorded, plus anything written by a browser that had
 * never been told who was signed in. The two tidy answers are both wrong — adopting them to
 * whoever is here now is the defect itself, and discarding them destroys somebody's only copy
 * — so nothing happens to one of these without a person saying so.
 */
describe('an unattributed report', () => {
  it('is neither sent nor discarded on its own', async () => {
    await queue('a', 1_000, null);

    let calls = 0;
    const automatic = await flush(async () => {
      calls += 1;
      return undefined;
    });

    expect(calls).toBe(0);
    expect(automatic).toEqual({ sent: 0, kept: 1 });

    // Nor by a person pressing "post it now" over their own queue, which passes `force`.
    expect(await flush(async () => undefined, { force: true })).toEqual({ sent: 0, kept: 1 });

    // Still there, still nobody's, still word for word what was written.
    const kept = await getPendingReview(null, 'a');
    expect(kept?.userId).toBeNull();
    expect(kept?.write.body).toBe('The ford below the col is impassable.');
  });

  it('goes out once somebody claims it, under that person', async () => {
    await queue('a', 1_000, null);
    await adoptPendingReview('a', HIKER);

    // Re-keyed, so the row is now findable as this reader's and not as nobody's.
    expect(await getPendingReview(null, 'a')).toBeNull();
    expect((await getPendingReview(HIKER, 'a'))?.userId).toBe(HIKER);

    expect(await flush(async () => undefined)).toEqual({ sent: 1, kept: 0 });
  });

  it('is the only kind that can be claimed', async () => {
    await queue('a', 1_000, HIKER);
    await adoptPendingReview('a', 'hiker-b');

    // Claiming looks the row up under the unattributed key and finds nothing, so the named
    // row is untouched. A report with an author has one, and no press by anybody changes it.
    expect((await getPendingReview(HIKER, 'a'))?.userId).toBe(HIKER);
    expect(await listPendingReviews()).toHaveLength(1);
  });

  it('will not be claimed over a report of the claimer own about the same trail', async () => {
    // Reachable straight out of the v4 upgrade. The migrated draft is unattributed, so the
    // trail page form — which asks for `getPendingReview(readerId, trailId)` — cannot see it,
    // and the ordinary thing to do is write the report again. Both rows are then on
    // `/downloads` at once, in two different sections, about the same hill.
    await queue('si', 1_000, null);
    await queue('si', 2_000, HIKER);
    const mine = await getPendingReview(HIKER, 'si');

    const outcome = await adoptPendingReview('si', HIKER);

    // Owner is half the key, so the claim's destination is exactly where the reader's own row
    // sits, and an IndexedDB `put` replaces on collision. Refused instead: the newer text is
    // still there, the older one is still unattributed, and nothing was sent.
    expect(outcome).toBe('would-replace-your-own');
    expect(await listPendingReviews()).toHaveLength(2);
    expect(await getPendingReview(HIKER, 'si')).toEqual(mine);
    expect((await getPendingReview(null, 'si'))?.userId).toBeNull();
  });

  it('replaces the claimer own report only when they say to', async () => {
    await queue('si', 1_000, null);
    await queue('si', 2_000, HIKER);

    expect(await adoptPendingReview('si', HIKER, { replace: true })).toBe('adopted');

    // One row, the claimed one, under the claimer. This is the destructive answer, and it is
    // reachable only from a second press with both reports named on screen.
    expect(await listPendingReviews()).toHaveLength(1);
    expect((await getPendingReview(HIKER, 'si'))?.queuedAt).toBe(1_000);
    expect(await getPendingReview(null, 'si')).toBeNull();
  });

  it('says so when there is nothing left to claim', async () => {
    expect(await adoptPendingReview('si', HIKER)).toBe('nothing-to-claim');
  });
});

/**
 * What happens when the browser changes hands.
 *
 * Mark, never delete. A queued report is the only copy of something a person wrote standing in
 * the place they were writing about, and "somebody else has signed in" is not a reason to
 * destroy it. It is a reason to set it aside and say so.
 */
describe('a change of account', () => {
  const AT = 1_760_000_000_000;

  it('marks a report rather than deleting it', async () => {
    await queue('a', 1_000, HIKER);

    await holdReviewsFor(HIKER, AT);

    const held = await getPendingReview(HIKER, 'a');
    expect(held).not.toBeNull();
    expect(held?.heldAt).toBe(AT);
    // The words are untouched, which is the whole point of marking instead.
    expect(held?.write.body).toBe('The ford below the col is impassable.');
  });

  it('keeps the date the report was first set aside', async () => {
    await queue('a', 1_000, HIKER);
    await holdReviewsFor(HIKER, AT);
    // Somebody else comes and goes again. The report was set aside once, not twice.
    await holdReviewsFor(HIKER, AT + 100_000);

    expect((await getPendingReview(HIKER, 'a'))?.heldAt).toBe(AT);
  });

  it('leaves rows belonging to anybody else alone', async () => {
    await queue('a', 1_000, HIKER);
    await queue('b', 2_000, 'hiker-b');
    await queue('c', 3_000, null);

    await holdReviewsFor(HIKER, AT);

    expect((await getPendingReview('hiker-b', 'b'))?.heldAt).toBeNull();
    expect((await getPendingReview(null, 'c'))?.heldAt).toBeNull();
  });

  it('releases the report when that person comes back', async () => {
    await queue('a', 1_000, HIKER);
    await holdReviewsFor(HIKER, AT);
    await releaseReviewsFor(HIKER);

    expect((await getPendingReview(HIKER, 'a'))?.heldAt).toBeNull();
    // Being held was never a second gate in front of the drain — it is a thing to say on a
    // screen. Ownership is the gate, and it has not changed.
    expect(await flush(async () => undefined)).toEqual({ sent: 1, kept: 0 });
  });
});

/**
 * Reports already queued on real devices when this shipped.
 *
 * The migration is the part of this change that could actually lose something. A row written
 * on a phone last week has no author on it, and the version bump has to decide what that
 * means. Adopting it to whoever opens the app next is the defect the rest of this file is
 * about; deleting it destroys the only copy of a report somebody wrote on a ridge. So it is
 * carried across as nobody's, and stays on the device until a person says which.
 */
describe('the upgrade from the trail-keyed queue', () => {
  it('carries an old row across as unattributed rather than adopting or dropping it', async () => {
    vi.stubGlobal(
      'indexedDB',
      createFakeIndexedDB({
        'pending-reviews': [
          {
            trailId: 'a',
            trailName: 'Trail a',
            trailPath: '/trails/a',
            write: write('a', 4),
            queuedAt: 1_000,
            attempts: 2,
            lastError: null,
            blocked: false,
          },
        ],
      }),
    );

    const rows = await listPendingReviews();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBeNull();
    expect(rows[0]?.heldAt).toBeNull();
    expect(rows[0]?.key).toBe(':a');
    // Everything else survives untouched, including how many times it has already been tried.
    expect(rows[0]?.write.body).toBe('The ford below the col is impassable.');
    expect(rows[0]?.attempts).toBe(2);

    // And it is inert: no drain sends it, whoever is signed in and however hard they press.
    let calls = 0;
    await flush(
      async () => {
        calls += 1;
        return undefined;
      },
      { force: true },
    );
    expect(calls).toBe(0);
    expect(await listPendingReviews()).toHaveLength(1);
  });
});
