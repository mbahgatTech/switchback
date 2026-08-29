import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { OfflineTrail } from '@/offline/store';

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
  queryClient.setQueryData(keys.photos, (current) => current ?? disown(photos));

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
      (current) =>
        current ?? {
          pages: [{ ...reviewPage, reviews: disown(reviewPage.reviews) }],
          pageParams: [null],
        },
    );
  }
}

/**
 * Strip the stored ownership flag off anything that carries one.
 *
 * `isMine` as stored is a fact about whoever downloaded the trail, not about whoever is holding
 * the phone — the payload sits on disk and outlives both the session that wrote it and the
 * account that owned it. Seeded false, so the floor never draws a caption editor or a "Remove
 * this photograph" over somebody else's frame; the true answer arrives with the live fetch.
 *
 * **One known cost, accepted rather than overlooked.** `isMine` gates one affordance in the
 * other direction: `components/reviews.tsx` offers the Report control on a report that is *not*
 * yours, so a seeded page offers it on your own. Reporting yourself is pointless rather than
 * dangerous, it is corrected by the first live fetch, and the alternative — teaching the review
 * list what a download is, or carrying a third "unknown" ownership state through the router
 * shapes — buys a cosmetic fix with a structural cost. False stays the safe default: every other
 * affordance it governs is one that must not be offered over somebody else's work.
 */
function disown<T extends { isMine: boolean }>(items: T[]): T[] {
  return items.map((item) => ({ ...item, isMine: false }));
}
