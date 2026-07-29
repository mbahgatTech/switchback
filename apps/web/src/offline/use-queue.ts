'use client';

/**
 * The queue, as a component sees it.
 *
 * Two hooks over one store, split the same way the download hooks are: the storage manager
 * wants everything queued, and a trail page wants only its own row. A page that shows one
 * trail should not re-render because a report for a different trail finally went out.
 *
 * Both subscribe to the store rather than polling it, so the banner on a trail page clears
 * the moment the background flusher posts that trail's report — without either component
 * knowing the other exists.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ReviewWrite } from '@switchback/core';
import { useTRPCClient } from '../trpc/react';
import {
  deletePendingReview,
  flushPendingReviews,
  getPendingReview,
  listPendingReviews,
  subscribeToQueue,
  type FlushResult,
  type PendingReview,
} from './queue';

/**
 * The one place the queue meets tRPC.
 *
 * `queue.ts` takes a poster rather than a client precisely so it can stay testable in a
 * plain node environment; this is the two-line adapter that pays for that.
 */
function usePoster(): (write: ReviewWrite) => Promise<unknown> {
  const client = useTRPCClient();
  return useCallback((write: ReviewWrite) => client.reviews.upsert.mutate(write), [client]);
}

export interface PendingReviewsApi {
  reviews: PendingReview[];
  loading: boolean;
  /** True while something is being sent, so a button can say so and refuse a second press. */
  busy: boolean;
  /** Send everything queued, including rows the server previously refused. */
  flushAll: () => Promise<FlushResult>;
  /** Send one trail's report, on purpose, now. */
  post: (trailId: string) => Promise<FlushResult>;
  /** Throw one away. The only path that loses a report, and it is always a person's choice. */
  discard: (trailId: string) => Promise<void>;
}

/** Everything waiting to be sent, for the storage manager. */
export function usePendingReviews(): PendingReviewsApi {
  const [reviews, setReviews] = useState<PendingReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const send = usePoster();

  const refresh = useCallback(async () => {
    const rows = await listPendingReviews().catch(() => []);
    setReviews(rows);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeToQueue(() => {
      void refresh();
    });
  }, [refresh]);

  const run = useCallback(
    async (options: { trailId?: string }) => {
      setBusy(true);
      try {
        // `force` because both entry points here are somebody pressing a button. An automatic
        // flush leaves refused rows alone; a person asking is a new fact about the world —
        // they may have signed back in since.
        return await flushPendingReviews(send, { ...options, force: true });
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [send, refresh],
  );

  return {
    reviews,
    loading,
    busy,
    flushAll: useCallback(() => run({}), [run]),
    post: useCallback((trailId: string) => run({ trailId }), [run]),
    discard: useCallback(
      async (trailId: string) => {
        await deletePendingReview(trailId);
        await refresh();
      },
      [refresh],
    ),
  };
}

export interface PendingReviewApi {
  pending: PendingReview | null;
  /** Undefined until the store has been read once — the form must not flash a banner it may not need. */
  loading: boolean;
  busy: boolean;
  /** Send this one now, whatever happened last time. */
  post: () => Promise<FlushResult>;
  discard: () => Promise<void>;
}

/** One trail's queued report, for the form that wrote it. */
export function usePendingReview(trailId: string): PendingReviewApi {
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const send = usePoster();

  const refresh = useCallback(async () => {
    const row = await getPendingReview(trailId).catch(() => null);
    setPending(row);
    setLoading(false);
  }, [trailId]);

  useEffect(() => {
    void refresh();
    return subscribeToQueue(() => {
      void refresh();
    });
  }, [refresh]);

  return {
    pending,
    loading,
    busy,
    post: useCallback(async () => {
      setBusy(true);
      try {
        return await flushPendingReviews(send, { trailId, force: true });
      } finally {
        setBusy(false);
        await refresh();
      }
    }, [send, trailId, refresh]),
    discard: useCallback(async () => {
      await deletePendingReview(trailId);
      await refresh();
    }, [trailId, refresh]),
  };
}
