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
 *
 * ---
 *
 * **Every one of them is scoped to the reader.** A queue is not a property of a browser, it is
 * a property of a person who used that browser, and on a shared computer those are different
 * things. So each hook splits what it finds three ways and hands the caller all three:
 *
 * - **yours** — written under the account signed in now. Ordinary rows, sent by the ordinary
 *   drain, shown in full.
 * - **held** — written under some other account. A count and nothing else: not the trail, not
 *   the date, and above all not the words. What is owed is visible so that a person who has
 *   filled their storage can see why; whose it is and what it says are not this reader's to
 *   read. They go out when that person signs back in, untouched.
 * - **unattributed** — written before the queue recorded authorship. Shown, named, and left
 *   for a person to claim or discard, because those two are the only honest options and the
 *   device cannot choose between them. See `handover.ts`.
 *
 * ---
 *
 * **Drawing reads the subscription; acting reads `localStorage`.** `useReaderId()` gives these
 * hooks the value to render — which list a row belongs in, whether to offer a claim button.
 * Every callback that *sends, adopts or deletes* calls `writingReader()` instead, at the
 * moment the button does its work. The two disagree exactly when it matters: a second tab
 * signs in, or this document comes back from the back/forward cache, and the render that drew
 * the button happened under an account that has since left while the request the button makes
 * carries the cookie of the account that arrived. Acting on the drawn value posts one hiker's
 * report under another's name; acting on the stored value posts nothing, which is correct.
 * See the note on `writingReader` in `identity.ts`.
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

/**
 * Split what is on the device into what this reader may act on and what they may not.
 *
 * One function for both queues, because the rule is the same for a report and for a day's
 * track and writing it twice is how the two drift apart.
 */
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
  /** Reports written under the account signed in now. */
  reviews: PendingReview[];
  /** Reports written before the queue recorded authorship. Claimed or discarded by hand. */
  unattributed: PendingReview[];
  /** How many belong to somebody else. A number, and nothing more; see the note at the top. */
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
        // `force` because both entry points here are somebody pressing a button. An automatic
        // flush leaves refused rows alone; a person asking is a new fact about the world —
        // they may have signed back in since.
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
        // deletes the report of the person who left rather than the one this list belongs to.
        await deletePendingReview(writingReader(), trailId);
        await refresh();
      },
      [refresh],
    ),
    adopt: useCallback(
      async (trailId: string, adoptOptions: { replace?: boolean } = {}) => {
        // Nobody is signed in, so there is no name to put on it. The control that calls this
        // is not rendered in that state; the guard is here so the answer cannot depend on it.
        const reader = writingReader();
        if (reader === null) return 'nothing-to-claim';
        setBusy(true);
        try {
          const outcome = await adoptPendingReview(trailId, reader, adoptOptions);
          // The claimer already has a report queued for this trail. Nothing has been written
          // and nothing may be, until they say which of the two to keep — the caller draws
          // that question. See `adoptPendingReview`.
          if (outcome !== 'adopted') return outcome;
          const result = await flushPendingReviews(send, {
            trailId,
            readerId: reader,
            stillReader: writingReader,
            force: true,
          });
          // Said out loud, on the same reasoning as the hikes below: settling the last
          // unattributed row takes the button, the row and the whole section off the page, so
          // silence on success and silence on failure look identical — and to somebody who
          // cannot see the list disappear, both look like nothing happened.
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
 * One trail's queued report, for the form that wrote it.
 *
 * Keyed on the reader as well as the trail, which is what stops the form prefilling the last
 * person's draft into this person's textarea. A report queued by somebody else for this trail
 * is not returned, not counted, and not hinted at: the form behaves exactly as it does when
 * there is nothing queued, because from this reader's side of the screen there is not.
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
  /** Hikes recorded under the account signed in now. */
  activities: PendingActivity[];
  /** Hikes recorded before the queue recorded authorship. Claimed or discarded by hand. */
  unattributed: PendingActivity[];
  /** How many belong to somebody else. A number, and nothing more. */
  held: number;
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
        // `force`, on the same reasoning written above for reports: an automatic flush leaves
        // refused rows alone, and a person pressing a button is a new fact about the world.
        const result = await flushPendingActivities(post, {
          ...options,
          readerId: writingReader(),
          stillReader: writingReader,
          force: true,
        });
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

  const throwAway = useCallback(
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
      // Only for a hike this reader could have started on the server. An unattributed row's
      // server copy, if it has one, belongs to whoever recorded it — and `activities.remove`
      // is scoped to the caller, so asking would fail anyway. Discarding here means "take it
      // off this device", which is the only claim the person pressing it can make.
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
          await adoptPendingActivity(activityId, reader);
          const result = await flushPendingActivities(post, {
            activityId,
            readerId: reader,
            stillReader: writingReader,
            force: true,
          });
          // Claiming the last unattributed row removes the button, then the row, then the
          // whole section — so without this the page answers a press by going quiet and
          // shorter, which is what a failure looks like too. Same argument as `run` above,
          // and it carries further here: this screen is about rows whose author is in doubt,
          // and a claim that could not be sent re-lists the hike elsewhere on the page.
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
