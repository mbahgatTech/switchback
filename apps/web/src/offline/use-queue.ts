'use client';

/**
 * The queue, as a component sees it. Each hook splits what it finds three ways — yours, held for
 * somebody else (a count only, never the words), and unattributed — and subscribes rather than polls.
 *
 * **Drawing reads the subscription; acting reads `localStorage`.** Every callback that sends,
 * adopts or deletes calls `writingReader()`, because the render that drew the button may have
 * happened under an account that has since left.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReviewWrite } from '@switchback/core';
import { useTRPCClient } from '../trpc/react';
import {
  adoptPendingActivity,
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
import { heldForAnother, isUnattributed, ownedBy, writingReader } from './identity';
import {
  adoptPendingReview,
  deletePendingReview,
  flushPendingReviews,
  getPendingReview,
  listPendingReviews,
  subscribeToQueue,
  type AdoptOutcome,
  type FlushResult,
  type PendingReview,
} from './queue';
import { useReaderId } from './reader';

/** Splits rows into what this reader may act on and what they may not. One function for both queues. */
function partition<T extends { userId: string | null }>(
  rows: readonly T[],
  readerId: string | null,
): { mine: T[]; unattributed: T[]; held: number } {
  return {
    mine: rows.filter((row) => ownedBy(row, readerId)),
    unattributed: rows.filter(isUnattributed),
    held: rows.filter((row) => heldForAnother(row, readerId)).length,
  };
}

/** The one place the review queue meets tRPC — `queue.ts` takes a poster so it stays testable. */
function usePoster(): (write: ReviewWrite) => Promise<unknown> {
  const client = useTRPCClient();
  return useCallback((write: ReviewWrite) => client.reviews.upsert.mutate(write), [client]);
}

export interface PendingReviewsApi {
  /** Reports written under the account signed in now. */
  reviews: PendingReview[];
  /** Reports written before the queue recorded authorship. Claimed or discarded by hand. */
  unattributed: PendingReview[];
  /** How many belong to somebody else. A number, and nothing more — never the words. */
  held: number;
  loading: boolean;
  /** True while something is being sent, so a button can say so and refuse a second press. */
  busy: boolean;
  /** Send everything of yours, including rows the server previously refused. */
  flushAll: () => Promise<FlushResult>;
  /** Send one trail's report, on purpose, now. */
  post: (trailId: string) => Promise<FlushResult>;
  /** Throw one of yours away. The only path that loses a report, and always a person's choice. */
  discard: (trailId: string) => Promise<void>;
  /** Claim an unattributed report and send it as yourself. */
  adopt: (trailId: string, options?: { replace?: boolean }) => Promise<AdoptOutcome>;
  /** Throw an unattributed report away, having decided it is not yours to send. */
  discardUnattributed: (trailId: string) => Promise<void>;
}

/** Everything waiting to be sent, for the storage manager. */
export function usePendingReviews(): PendingReviewsApi {
  const readerId = useReaderId();
  const [rows, setRows] = useState<PendingReview[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const send = usePoster();

  const refresh = useCallback(async () => {
    setRows(await listPendingReviews().catch(() => []));
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeToQueue(() => {
      void refresh();
    });
  }, [refresh]);

  const split = useMemo(() => partition(rows, readerId), [rows, readerId]);

  const run = useCallback(
    async (options: { trailId?: string }) => {
      setBusy(true);
      try {
        // `force` because both entry points are somebody pressing a button, and a person asking
        // is a new fact about the world — they may have signed back in since.
        return await flushPendingReviews(send, {
          ...options,
          readerId: writingReader(),
          stillReader: writingReader,
          force: true,
        });
      } finally {
        setBusy(false);
        await refresh();
      }
    },
    [send, refresh],
  );

  return {
    reviews: split.mine,
    unattributed: split.unattributed,
    held: split.held,
    loading,
    busy,
    flushAll: useCallback(() => run({}), [run]),
    post: useCallback((trailId: string) => run({ trailId }), [run]),
    discard: useCallback(
      async (trailId: string) => {
        // The reader as stored, not as drawn: the key is half owner, so a stale value here
        // deletes the report of the person who left.
        await deletePendingReview(writingReader(), trailId);
        await refresh();
      },
      [refresh],
    ),
    adopt: useCallback(
      async (trailId: string, adoptOptions: { replace?: boolean } = {}) => {
        // The control is not rendered when nobody is signed in; the guard is here so the answer
        // cannot depend on that.
        const reader = writingReader();
        if (reader === null) return 'nothing-to-claim';
        setBusy(true);
        try {
          const outcome = await adoptPendingReview(trailId, reader, adoptOptions).catch(
            (error: unknown) => {
              // The button is disabled while `busy`, so focus has left it and nothing else on
              // the page will change to show that the write was refused.
              setDrainNotice('That report could not be claimed. It is still on this device.');
              throw error;
            },
          );
          // Every terminal outcome goes in the page's one live region, word for word the same
          // as the visible sentence: a press replaces the control that made it, taking focus to
          // `<body>`, so a sentence living only in a `<span>` is announced to nobody.
          if (outcome !== 'adopted') {
            setDrainNotice(
              outcome === 'would-replace-your-own'
                ? 'You already have a report waiting for this trail. Keep yours, or replace it with this one.'
                : 'That report is no longer on this device. It has already been claimed or discarded.',
            );
            return outcome;
          }
          const result = await flushPendingReviews(send, {
            trailId,
            readerId: reader,
            stillReader: writingReader,
            force: true,
          });
          // Settling the last unattributed row takes the button, the row and the section off the
          // page, so silence on success and silence on failure look identical.
          setDrainNotice(
            result.sent > 0
              ? 'Posted under your account.'
              : 'It could not be posted. It is still on this device, now under your account.',
          );
          return outcome;
        } finally {
          setBusy(false);
          await refresh();
        }
      },
      [send, refresh],
    ),
    discardUnattributed: useCallback(
      async (trailId: string) => {
        await deletePendingReview(null, trailId);
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

/**
 * One trail's queued report, for the form that wrote it. Keyed on the reader as well as the trail,
 * which is what stops the form prefilling the last person's draft into this person's textarea.
 */
export function usePendingReview(trailId: string): PendingReviewApi {
  const readerId = useReaderId();
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const send = usePoster();

  const refresh = useCallback(async () => {
    const row =
      readerId === null ? null : await getPendingReview(readerId, trailId).catch(() => null);
    setPending(row);
    setLoading(false);
  }, [trailId, readerId]);

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
        return await flushPendingReviews(send, {
          trailId,
          readerId: writingReader(),
          stillReader: writingReader,
          force: true,
        });
      } finally {
        setBusy(false);
        await refresh();
      }
    }, [send, trailId, refresh]),
    discard: useCallback(async () => {
      await deletePendingReview(writingReader(), trailId);
      await refresh();
    }, [trailId, refresh]),
  };
}

/** The hike queue's tRPC adapter. Three mutations, because a hike is three calls in a fixed order. */
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
  /** Hikes recorded under the account signed in now. */
  activities: PendingActivity[];
  /** Hikes recorded before the queue recorded authorship. Claimed or discarded by hand. */
  unattributed: PendingActivity[];
  /** How many belong to somebody else. A number, and nothing more. */
  held: number;
  loading: boolean;
  busy: boolean;
  /**
   * Something the last drain needs a person to know. Not component state: the background drain in
   * the layout runs while nobody is on this page, so the sentence is held in `activities.ts`.
   */
  notice: string | null;
  /** Send every queued hike of yours, including any the server previously refused. */
  sendAll: () => Promise<FlushActivitiesResult>;
  /** Send one hike, on purpose, now. */
  send: (activityId: string) => Promise<FlushActivitiesResult>;
  /** Throw one away. The only path that loses a hike, and it is always a person's choice. */
  discard: (activityId: string) => Promise<void>;
  /** Claim an unattributed hike and add it to your account. */
  adopt: (activityId: string) => Promise<void>;
}

/** Every hike waiting on a connection, for the storage manager. */
export function usePendingActivities(): PendingActivitiesApi {
  const readerId = useReaderId();
  const [rows, setRows] = useState<PendingActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const post = useActivityPosters();

  const refresh = useCallback(async () => {
    setRows(await listPendingActivities().catch(() => []));
    setNotice(drainNotice());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    return subscribeToPendingActivities(() => {
      void refresh();
    });
  }, [refresh]);

  const split = useMemo(() => partition(rows, readerId), [rows, readerId]);

  const run = useCallback(
    async (options: { activityId?: string }) => {
      setBusy(true);
      try {
        // `force`, as for reports above: a person pressing a button is a new fact about the world.
        const result = await flushPendingActivities(post, {
          ...options,
          readerId: writingReader(),
          stillReader: writingReader,
          force: true,
        });
        // Every terminal outcome is said, not only the one that lost something: a press that
        // empties the list takes the button and heading with it, so silence on success looks
        // exactly like silence on failure. The drain's own truncation sentence wins.
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

  const throwAway = useCallback(
    async (activityId: string) => {
      // Read before the delete: a hike part-way through a drain has an open recording on the
      // server, and leaving it means the next `activities.start` sweep publishes a hike the
      // reader threw away. Swallowed — nothing to delete and no connection are both fine.
      const row = await getPendingActivity(activityId).catch(() => null);
      await deleteActivity(activityId);
      // Only for a hike this reader could have started: an unattributed row's server copy
      // belongs to whoever recorded it, and `activities.remove` is scoped to the caller.
      if (row?.serverStarted && ownedBy(row, writingReader()) && post.remove) {
        await post.remove({ id: activityId }).catch(() => undefined);
      }
      await refresh();
    },
    [post, refresh],
  );

  return {
    activities: split.mine,
    unattributed: split.unattributed,
    held: split.held,
    loading,
    busy,
    notice,
    sendAll: useCallback(() => run({}), [run]),
    send: useCallback((activityId: string) => run({ activityId }), [run]),
    discard: throwAway,
    adopt: useCallback(
      async (activityId: string) => {
        const reader = writingReader();
        if (reader === null) return;
        setBusy(true);
        try {
          await adoptPendingActivity(activityId, reader).catch((error: unknown) => {
            // As on the report claim: the button is disabled and has lost focus, so nothing
            // else on the page will show that the write was refused.
            setDrainNotice('That hike could not be claimed. It is still on this device.');
            throw error;
          });
          const result = await flushPendingActivities(post, {
            activityId,
            readerId: reader,
            stillReader: writingReader,
            force: true,
          });
          // Claiming the last unattributed row removes the button, the row and the section, so
          // without this the page answers a press by going quiet — which is what failure does.
          if (result.truncated === 0) {
            setDrainNotice(
              result.sent > 0
                ? 'Added to your account.'
                : 'It could not be added. It is still on this device, now under your account.',
            );
          }
        } finally {
          setBusy(false);
          await refresh();
        }
      },
      [post, refresh],
    ),
  };
}
