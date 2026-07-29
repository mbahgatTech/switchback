import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { GALLERY_LIMIT, REVIEW_PAGE_SIZE } from '@/api/pages';
import { useTRPC } from '@/api/trpc';
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
 * **Never over live data.** Each write is `current ?? stored`, so a query that already has
 * an answer from the server keeps it. Seeding is only ever the floor.
 *
 * It also buys the right behaviour when a fetch fails. React Query keeps `status: 'success'`
 * on a query that has data and a failed refetch, so a trail opened in a valley shows the
 * saved copy with a note saying so — rather than the "Trail not found" a bare error would
 * put under the name of a trail the phone is holding in full.
 */
export function useOfflineHydration(copy: OfflineTrail | null): void {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!copy) return;
    const { trailId, detail, photos, reviewSummary, reviewPage } = copy;

    queryClient.setQueryData(
      trpc.trails.bySlug.queryKey({ slug: copy.slug }),
      (current) => current ?? detail,
    );
    queryClient.setQueryData(
      trpc.trails.photos.queryKey({ trailId, limit: GALLERY_LIMIT }),
      (current) => current ?? photos,
    );
    if (reviewSummary) {
      queryClient.setQueryData(
        trpc.reviews.summary.queryKey({ trailId }),
        (current) => current ?? reviewSummary,
      );
    }
    if (reviewPage) {
      /*
       * One page, and the cursor that produced it. `initialPageParam` is null for a
       * `cursor?: string` input, so `pageParams: [null]` is what the live query would have
       * built — get this wrong and "Show more" asks the server for the page it already has.
       */
      queryClient.setQueryData(
        trpc.reviews.list.infiniteQueryKey({
          trailId,
          sort: 'recent',
          limit: REVIEW_PAGE_SIZE,
        }),
        (current) => current ?? { pages: [reviewPage], pageParams: [null] },
      );
    }
  }, [copy, queryClient, trpc]);
}
