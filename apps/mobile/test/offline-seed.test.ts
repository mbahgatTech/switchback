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

  it('survives the sign-in that empties the cache underneath it', async () => {
    const client = new QueryClient({
      defaultOptions: {
        // A valley: the refetch a reset kicks off cannot land.
        queries: { queryFn: () => Promise.reject(new Error('offline')), retry: false },
      },
    });
    const copy = storedCopy();
    seedFromDisk(client, KEYS, copy);

    const screen = new QueryObserver(client, { queryKey: KEYS.detail });
    const unsubscribe = screen.subscribe(() => undefined);

    const bus = announcer();
    // What the trail screen's effect does when the generation moves.
    forgetAnswersOnIdentityChange(client, bus.subscribe);
    bus.subscribe(() => seedFromDisk(client, KEYS, copy));
    bus.announce(true);

    await Promise.resolve();
    expect(client.getQueryData(KEYS.detail)).toMatchObject({ name: 'Vesper Peak' });
    unsubscribe();
  });
});
