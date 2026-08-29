import { describe, expect, it } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { forgetAnswersOnIdentityChange } from '../src/api/identity';
import { seedFromDisk, type TrailKeys } from '../src/offline/seed';
import type { OfflineTrail } from '../src/offline/store';

/**
 * The phone's copy of a trail is a seed, not a fetch. Nothing refetches a seed, and in a valley
 * there is nothing to refetch from — so anything that empties the cache has to be followed by
 * laying the seed down again, or the screen reports "Trail not found" over a trail the phone is
 * holding in full.
 *
 * That is not hypothetical: it is on the path this Work Order fixes. Open a downloaded trail,
 * press Save, sign in, and the sign-in screen pops back to the still-mounted trail screen.
 *
 * **These cases assert what a subscribed observer serves, and what the trail screen's own
 * predicate makes of it — never `getQueryData`.** A screen draws from an observer, and the first
 * version of this file asked the cache instead and so passed while the screen was broken.
 *
 * **They also do not model React's scheduling, deliberately.** An earlier version re-seeded
 * inline in the announcement loop, which is not what ships: production goes
 * `useSyncExternalStore` → re-render → `useEffect`, strictly later. Rather than approximate that
 * timing — a test that guesses scheduling cannot police a scheduling bug — the re-seed below is
 * delivered on a timer, arbitrarily *late*. That is a weaker assumption than React's, so a
 * property that survives it survives any real schedule.
 */

const KEYS: TrailKeys = {
  detail: [['trails', 'bySlug'], { input: { slug: 'vesper-peak' }, type: 'query' }],
  photos: [['trails', 'photos'], { input: { trailId: 't1', limit: 24 }, type: 'query' }],
  reviewSummary: [['reviews', 'summary'], { input: { trailId: 't1' }, type: 'query' }],
  reviewPage: [['reviews', 'list'], { input: { trailId: 't1' }, type: 'infinite' }],
};

/** What `readTrail` parses off disk, trimmed to the fields this module reads. */
function storedCopy(): OfflineTrail {
  return {
    version: 1,
    trailId: 't1',
    slug: 'vesper-peak',
    detail: { id: 't1', slug: 'vesper-peak', name: 'Vesper Peak' },
    photos: [{ id: 'p1', userId: 'alice', isMine: true }],
    reviewSummary: { total: 1 },
    reviewPage: { reviews: [{ id: 'r1', userId: 'alice', isMine: true }], nextCursor: null },
  } as unknown as OfflineTrail;
}

function announcer() {
  const listeners = new Set<(signedIn: boolean) => void>();
  return {
    subscribe: (listener: (signedIn: boolean) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    announce: (signedIn: boolean) => {
      for (const listener of listeners) listener(signedIn);
    },
  };
}

/**
 * `apps/mobile/src/api/trpc.tsx`, with the backoff compressed but its *shape* kept: the retries
 * must still outlast the re-seed, because that ordering is the whole defect. In production the
 * effect re-seeds within a frame and `retry: 2` on real backoff fails seconds later.
 */
const APP_DEFAULTS = {
  staleTime: 60_000,
  retry: 2,
  retryDelay: (attempt: number) => 30 * 2 ** attempt,
};

/** `app/trails/[slug].tsx`: what the screen puts on the display. */
function screenOf(observer: QueryObserver): 'the trail' | 'spinner' | 'Trail not found' {
  const result = observer.getCurrentResult();
  if (result.isPending) return 'spinner';
  return result.data === undefined ? 'Trail not found' : 'the trail';
}

describe('the phone’s copy, seeded into the cache', () => {
  it('is what the trail screen reads when there is no network answer', () => {
    const client = new QueryClient();
    seedFromDisk(client, KEYS, storedCopy());

    expect(client.getQueryData(KEYS.detail)).toMatchObject({ name: 'Vesper Peak' });
    expect(client.getQueryData(KEYS.reviewSummary)).toMatchObject({ total: 1 });
  });

  it('never paints over an answer the server already gave', () => {
    const client = new QueryClient();
    client.setQueryData(KEYS.detail, { id: 't1', slug: 'vesper-peak', name: 'Renamed upstream' });

    seedFromDisk(client, KEYS, storedCopy());

    expect(client.getQueryData(KEYS.detail)).toMatchObject({ name: 'Renamed upstream' });
  });

  it('claims nothing on behalf of whoever downloaded it', () => {
    const client = new QueryClient();
    seedFromDisk(client, KEYS, storedCopy());

    const photos = client.getQueryData<{ isMine: boolean }[]>(KEYS.photos);
    const page = client.getQueryData<{ pages: { reviews: { isMine: boolean }[] }[] }>(
      KEYS.reviewPage,
    );
    expect(photos?.[0]?.isMine).toBe(false);
    expect(page?.pages[0]?.reviews[0]?.isMine).toBe(false);
  });

  it('is still on the screen after a sign-in whose refetch fails in a valley', async () => {
    let attempts = 0;
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          ...APP_DEFAULTS,
          queryFn: () => {
            attempts += 1;
            return Promise.reject(new Error('offline'));
          },
        },
      },
    });
    const copy = storedCopy();
    seedFromDisk(client, KEYS, copy);

    const screen = new QueryObserver(client, { queryKey: KEYS.detail });
    const unsubscribe = screen.subscribe(() => undefined);
    expect(screenOf(screen)).toBe('the trail');

    const bus = announcer();
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    // Late on purpose — see the header. React's effect would land sooner than this.
    bus.subscribe(() => setTimeout(() => seedFromDisk(client, KEYS, copy), 5));
    bus.announce(true);

    // Long enough for the forced refetch to exhaust `retry: 2`, which is when the old code
    // flipped the screen to "Trail not found" — seconds after it had drawn the trail.
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(attempts, 'the reset really did force a refetch').toBeGreaterThan(1);
    expect(screen.getCurrentResult().isError, 'and it really did fail').toBe(true);
    expect(screenOf(screen)).toBe('the trail');

    unsubscribe();
  });

  it('pins the query-core behaviour the screen now depends on', async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, queryFn: () => Promise.reject(new Error('offline')) },
      },
    });
    client.setQueryData(KEYS.detail, { name: 'Vesper Peak' });
    const screen = new QueryObserver(client, { queryKey: KEYS.detail });
    const unsubscribe = screen.subscribe(() => undefined);

    await client.refetchQueries({ type: 'active' });

    /*
     * The belief this Work Order shipped on was that a failed refetch leaves `status: 'success'`.
     * It does not. It goes to `error` and keeps `data` — which is why a screen must branch on
     * the data and not on the flag. If a future upgrade changes either half, this fails and the
     * rule in `offline/hydrate.ts` needs rereading.
     */
    expect(screen.getCurrentResult().status).toBe('error');
    expect(screen.getCurrentResult().data).toMatchObject({ name: 'Vesper Peak' });
    expect(screen.getCurrentResult().isLoadingError).toBe(false);

    unsubscribe();
  });
});

describe('a stored copy with pieces missing', () => {
  /*
   * `readTrail` parses whatever the download wrote, and a trail with no reports has no summary
   * and no first page. Seeding `undefined` under those keys would put a query into `success`
   * with nothing in it, which reads as "no reports" rather than "not asked yet" — so the keys
   * are left alone and the live fetch fills them.
   */
  it('seeds only the pieces it has', () => {
    const client = new QueryClient();
    const sparse = { ...storedCopy(), reviewSummary: null, reviewPage: null } as OfflineTrail;

    seedFromDisk(client, KEYS, sparse);

    expect(client.getQueryData(KEYS.detail)).toMatchObject({ name: 'Vesper Peak' });
    expect(client.getQueryState(KEYS.reviewSummary)).toBeUndefined();
    expect(client.getQueryState(KEYS.reviewPage)).toBeUndefined();
  });

  it('is safe to lay down twice, because that is what a re-seed is', () => {
    const client = new QueryClient();
    const copy = storedCopy();

    seedFromDisk(client, KEYS, copy);
    seedFromDisk(client, KEYS, copy);

    const photos = client.getQueryData<{ isMine: boolean }[]>(KEYS.photos);
    expect(photos).toHaveLength(1);
    expect(photos?.[0]?.isMine).toBe(false);
  });
});
