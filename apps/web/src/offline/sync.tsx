'use client';

/**
 * Sending what was written where there was no signal.
 *
 * Mounted once in the layout, renders nothing, and exists so that a hiker never has to
 * remember they owe the queue anything. They wrote the report on the ridge and recorded the
 * hike getting there; the moment the phone finds a tower — or the moment they next open the
 * site at all — both go out. Mounted in the layout rather than on `/record` for exactly that
 * reason: somebody who gets back to the car and opens the app to look at the map should have
 * their hike uploaded then, not only if they happen to reopen the recorder.
 *
 * This is the web half of the plan's "Background Sync flushes recorded activities and queued
 * reviews when connectivity returns". Deliberately not the Background Sync API: that is
 * Chromium-only, and the hikers most likely to need this are on iPhones. A listener plus a
 * flush on mount covers every browser, at the cost of only firing while a tab is open —
 * which, for a person who has just come back into signal and is looking at their phone, is
 * when it fires anyway.
 *
 * **`online` alone is not that listener.** iOS Safari fires it unreliably, and the commonest
 * sequence on this product produces no transition at all: the phone was off, or in airplane
 * mode, in the valley, and is switched on at the trailhead — it boots already online, so
 * there is nothing for `online` to fire on. `visibilitychange` to `visible` is the event that
 * actually happens when a hiker picks their phone up, and it costs three lines.
 *
 * Three triggers means two of them can fire in the same tick — a phone unlocked as its radio
 * reattaches does exactly that — so both drains are serialised inside themselves rather than
 * guarded here. See `serialise` in `queue.ts`: a guard on this component would not cover the
 * storage manager's buttons, which are a fourth caller into the same two functions.
 *
 * Mounted for everybody, including a signed-out reader, and that is deliberate: with nothing
 * queued neither drain makes a request at all, and with something queued an auth refusal is
 * treated as "try again after a sign-in" rather than as a refusal of the hike. Gating this on
 * a session would only move the decision, and a session that expires mid-drain would still
 * have to be handled where the refusal arrives.
 */

import { useCallback, useEffect } from 'react';
import type { ReviewWrite } from '@switchback/core';
import { useTRPCClient } from '../trpc/react';
import { flushPendingActivities } from './activities';
import { flushPendingReviews } from './queue';

export function SyncQueuedWrites() {
  const client = useTRPCClient();

  const flush = useCallback(() => {
    // No point spending a request to learn what `navigator.onLine` already said. It is a weak
    // signal in the other direction — online can mean a captive portal — but a false negative
    // here costs nothing: the next `online` event or the next page load tries again.
    if (!navigator.onLine) return;

    void (async () => {
      // Reports first, hikes second, and chained rather than run together. A report is one
      // small request and a hike is dozens; the connection that has just come back is one
      // bar, which is the same reason each drain is sequential inside itself.
      await flushPendingReviews((write: ReviewWrite) => client.reviews.upsert.mutate(write));
      await flushPendingActivities({
        start: (input) => client.activities.start.mutate(input),
        append: (input) => client.activities.append.mutate(input),
        finish: (input) => client.activities.finish.mutate(input),
      });
    })().catch(() => {
      // Every failure mode this can produce is already recorded on the row it belongs to,
      // and shown on the trail page and in the storage manager. There is nothing useful to
      // say here that is not said somewhere a person will actually look.
    });
  }, [client]);

  useEffect(() => {
    flush();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') flush();
    };
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [flush]);

  return null;
}
