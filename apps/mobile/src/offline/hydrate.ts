import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useCacheGeneration } from '@/api/identity';
import { GALLERY_LIMIT, REVIEW_PAGE_SIZE } from '@/api/pages';
import { useTRPC } from '@/api/trpc';
import { seedFromDisk } from '@/offline/seed';
import type { OfflineTrail } from '@/offline/store';

/**
 * Put a saved trail back into the query cache.
 *
 * The alternative was to thread an `offline` prop through the trail screen and down into
 * the gallery and the reports, and have each of them decide whether to draw live data or
 * stored data. That is three components learning about downloads, and three chances to get
 * the fallback subtly wrong.
 *
 * This does it in one place instead. The stored payload was fetched with the same
 * procedures and the same arguments the screens use, so writing it under the same keys
 * makes every one of them render from the phone without knowing anything has changed.
 *
 * It also buys the right behaviour when a fetch fails. React Query keeps `status: 'success'`
 * on a query that has data and a failed refetch, so a trail opened in a valley shows the
 * saved copy with a note saying so — rather than the "Trail not found" a bare error would
 * put under the name of a trail the phone is holding in full.
 *
 * **A seed is not a fetch, so it has to be laid again.** `api/identity.ts` empties the cache on
 * every change of signed-in identity, which destroys these entries; an active query refetches
 * itself, but nothing refetches a seed, and in a valley there is nothing to refetch from. Hence
 * the generation in the dependencies below: it moves when the cache is emptied, and only then.
 * Without it, signing in from a downloaded trail leaves "Trail not found" over a trail the phone
 * is holding in full — the exact outcome this module exists to prevent.
 *
 * What is written, and why ownership is stripped from it, is `offline/seed.ts`.
 */
export function useOfflineHydration(copy: OfflineTrail | null): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const generation = useCacheGeneration();

  useEffect(() => {
    if (!copy) return;
    const { trailId } = copy;

    seedFromDisk(
      queryClient,
      {
        detail: trpc.trails.bySlug.queryKey({ slug: copy.slug }),
        photos: trpc.trails.photos.queryKey({ trailId, limit: GALLERY_LIMIT }),
        reviewSummary: trpc.reviews.summary.queryKey({ trailId }),
        reviewPage: trpc.reviews.list.infiniteQueryKey({
          trailId,
          sort: 'recent',
          limit: REVIEW_PAGE_SIZE,
        }),
      },
      copy,
    );
    // `generation` is a trigger rather than a value this effect reads. See the note above.
  }, [copy, generation, queryClient, trpc]);
}
