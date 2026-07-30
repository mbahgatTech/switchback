'use client';

/**
 * The queue, as a component sees it.
 *
 * Three hooks over two stores, split the same way the download hooks are: the storage manager
 * wants everything queued, and a trail page wants only its own row. A page that shows one
 * trail should not re-render because a report for a different trail finally went out.
 *
 * All of them subscribe to their store rather than polling it, so the banner on a trail page
 * clears the moment the background flusher posts that trail's report — without either
 * component knowing the other exists.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewWrite } from '@switchback/core';
import { useTRPCClient } from '../trpc/react';
import {
  deleteActivity,
  drainNotice,
  flushPendingActivities,
  getPendingActivity,
  listPendingActivities,
  setDrainNotice,
  subscribeToPendingActivities,
  type ActivityPosters,
  type FlushActivitiesResult,
  type PendingActivity,
} from './activities';
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

// ---------------------------------------------------------------------------
// Hikes
// ---------------------------------------------------------------------------

/**
 * The one place the hike queue meets tRPC.
 *
 * Three mutations rather than one, because a hike is three server calls in a fixed order.
 * Same shape as the object `SyncQueuedWrites` builds, and for the same reason `usePoster`
 * exists above: `activities.ts` takes posters so it can be tested in a plain node
 * environment, and this is the adapter that pays for it.
 */
function useActivityPosters(): ActivityPosters {
  const client = useTRPCClient();
  return useMemo<ActivityPosters>(
    () => ({
      start: (input) => client.activities.start.mutate(input),
      append: (input) => client.activities.append.mutate(input),
      finish: (input) => client.activities.finish.mutate(input),
      remove: (input) => client.activities.remove.mutate(input),
    }),
    [client],
  );
}

export interface PendingActivitiesApi {
  activities: PendingActivity[];
  loading: boolean;
  busy: boolean;
  /**
   * Something the last drain needs a person to know, or null.
   *
   * Not component state. The drain that most needs to say something is the background one in
   * the layout, which runs while nobody is on this page and deletes the row the outcome
   * belonged to on its way out, so the sentence is held in `activities.ts` and read here —
   * and it is still there the next time `/downloads` is opened. Rendered from a live region
   * that is mounted whether or not there is a queue, because the queue emptying is exactly
   * what a successful drain does.
   */
  notice: string | null;
  /** Send every queued hike, including any the server previously refused. */
  sendAll: () => Promise<FlushActivitiesResult>;
  /** Send one hike, on purpose, now. */
  send: (activityId: string) => Promise<FlushActivitiesResult>;
  /** Throw one away. The only path that loses a hike, and it is always a person's choice. */
  discard: (activityId: string) => Promise<void>;
}

/** Every hike waiting on a connection, for the storage manager. */
export function usePendingActivities(): PendingActivitiesApi {
  const [activities, setActivities] = useState<PendingActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const post = useActivityPosters();

  const refresh = useCallback(async () => {
    const rows = await listPendingActivities().catch(() => []);
    setActivities(rows);
    setNotice(drainNotice());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeToPendingActivities(() => {
      void refresh();
    });
  }, [refresh]);

  const run = useCallback(
    async (options: { activityId?: string }) => {
      setBusy(true);
      try {
        // `force`, on the same reasoning written above for reports: an automatic flush leaves
        // refused rows alone, and a person pressing a button is a new fact about the world.
        const result = await flushPendingActivities(post, { ...options, force: true });
        // Every terminal outcome is said, not only the one that lost something. A press that
        // empties the list takes the button, the row and the heading off the page with it, so
        // silence on success is indistinguishable from silence on failure — and to a reader
        // who cannot see the list disappear, it is indistinguishable from nothing happening.
        // The drain sets its own sentence for a truncation; that one wins.
        if (result.truncated === 0) {
          setDrainNotice(
            result.sent > 0
              ? `${result.sent} ${result.sent === 1 ? 'hike' : 'hikes'} added to your account.`
              : 'No hikes could be added. They are still on this device.',
          );
        }
        return result;
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [post, refresh],
  );

  return {
    activities,
    loading,
    busy,
    notice,
    sendAll: useCallback(() => run({}), [run]),
    send: useCallback((activityId: string) => run({ activityId }), [run]),
    discard: useCallback(
      async (activityId: string) => {
        // The server's copy goes too, when there is one. A hike part-way through a drain has
        // an open recording on the server, and leaving it there means the next `activities
        // .start` sweep closes and publishes a hike the reader deliberately threw away.
        // Swallowed: nothing to delete, or no connection to ask over, are both fine — the
        // sweep's own rule deletes a recording with no samples, and `Recorder.onDiscard`
        // makes the same judgement for the same reason.
        //
        // The button is deliberately *not* disabled while a drain is in flight, which was the
        // other half of the suggestion this fixes. `busy` here is this hook's own state and
        // cannot see the drain running in the root layout, so gating on it would refuse the
        // press in a case it does not cover and allow it in the case it does; a global flag
        // would disable the one destructive control on the page for a reason the reader has
        // no way to see. The race is closed where it happens instead — `sendOne` re-reads the
        // row before every write and before `finish`, and abandons it when it has gone.
        const row = await getPendingActivity(activityId).catch(() => null);
        await deleteActivity(activityId);
        if (row?.serverStarted && post.remove) {
          await post.remove({ id: activityId }).catch(() => undefined);
        }
        await refresh();
      },
      [post, refresh],
    ),
  };
}
