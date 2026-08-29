import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { OfflinePhotos, OfflineReviewPage, OfflineTrail } from '@/offline/store';

/**
 * Writing the phone's copy of a trail into the query cache.
 *
 * Separated from the hook that calls it (`offline/hydrate.ts`) because the keys are the part
 * that needs a tRPC proxy and the writing is the part with the rules in it — and the rules are
 * what a test has to be able to reach.
 */

/** The four live queries a downloaded trail stands in for. */
export interface TrailKeys {
  detail: QueryKey;
  photos: QueryKey;
  reviewSummary: QueryKey;
  reviewPage: QueryKey;
}

/**
 * Lay the stored copy down as the floor under a trail screen.
 *
 * **Never over live data.** Each write is `current ?? stored`, so a query that already has an
 * answer from the server keeps it. Seeding is only ever the floor, and calling this twice is
 * therefore safe — which matters, because it is called again every time the cache is emptied.
 */
export function seedFromDisk(
  queryClient: Pick<QueryClient, 'setQueryData'>,
  keys: TrailKeys,
  copy: OfflineTrail,
): void {
  const { detail, photos, reviewSummary, reviewPage } = copy;

  queryClient.setQueryData(keys.detail, (current) => current ?? detail);
  queryClient.setQueryData(keys.photos, (current) => current ?? unowned(photos));

  if (reviewSummary) {
    queryClient.setQueryData(keys.reviewSummary, (current) => current ?? reviewSummary);
  }
  if (reviewPage) {
    /*
     * One page, and the cursor that produced it. `initialPageParam` is null for a
     * `cursor?: string` input, so `pageParams: [null]` is what the live query would have built —
     * get this wrong and "Show more" asks the server for the page it already has.
     */
    queryClient.setQueryData(
      keys.reviewPage,
      (current) => current ?? { pages: [unclaimed(reviewPage)], pageParams: [null] },
    );
  }
}

/**
 * `isMine` as stored is a fact about whoever downloaded the trail, not about whoever is holding
 * the phone — the payload sits on disk and outlives both the session that wrote it and the
 * account that owned it. Seeded false, so the floor never draws a caption editor or a "Remove
 * this photograph" over somebody else's frame; the true answer arrives with the live fetch.
 */
function unowned(photos: OfflinePhotos): OfflinePhotos {
  return photos.map((photo) => ({ ...photo, isMine: false }));
}

/** The same, for the stored page of reports — `isMine` is what badges one of them "You". */
function unclaimed(page: OfflineReviewPage): OfflineReviewPage {
  return { ...page, reviews: page.reviews.map((review) => ({ ...review, isMine: false })) };
}
