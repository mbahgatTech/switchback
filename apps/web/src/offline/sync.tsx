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
 * drain as soon as the browser has decided who is here covers every browser, at the cost of
 * only firing while a tab is open — which, for a person who has just come back into signal and
 * is looking at their phone, is when it fires anyway.
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
 *
 * **What it will not do is flush somebody else's queue.** Both drains are handed the reader
 * this browser is acting as, and both send only rows written under that account — see
 * `ownedBy` in `identity.ts`. This component is the reason that guard has to exist at all: it
 * runs in the layout, on every page, on every return to the foreground, so on a shared
 * computer it is the first thing that happens after the next person signs in. It used to post
 * whatever it found over whatever session the browser was holding.
 *
 * **Which reader that is, is read here and not in a render.** Three times over.
 *
 * The value is taken from `localStorage` inside `flush`, so it is the answer at the instant of
 * the request rather than at the last paint. A rendered answer goes stale in two ordinary ways
 * and neither involves an attacker: a second tab left open while somebody signs in on the
 * first, and a document restored from the back/forward cache, which keeps its module state and
 * fires `visibilitychange` on the way back. Both leave a tab whose last render said A while
 * the cookie on its next request says B — and `ownedBy(row, 'A')` is then true of A's report,
 * which goes out over B's session and is deleted from the device on the way.
 *
 * And it is handed on, as `stillReader`, so the drains can ask it again themselves. Reading it
 * once here is only the answer for the *first* request of the flush: draining a six-hour hike
 * is dozens of requests over minutes, and a sign-in in another tab lands in the middle of that
 * as easily as before it. The drains re-ask before every request and stop when the answer
 * changes; see `stillActingAs` in `identity.ts`.
 *
 * And the *first* drain waits for `reader.tsx` to say the browser has settled. `reconcileReader`
 * is asynchronous, so on the page where the account changed, this component mounts while
 * `localStorage` still names the person who left — a drain there would read the stale value
 * honestly and still be wrong. So mount asks `readerSettled()` and usually gets false, and the
 * subscription runs the drain the moment the handover has held that person's rows. Both, rather
 * than either: whichever of the two effects commits second is the one that fires, so the queue
 * does not depend on the order two siblings in the layout happen to mount in. And a *different
 * tab* signing somebody in arrives through the same subscription, for free.
 */

import { useCallback, useEffect } from 'react';
import type { ReviewWrite } from '@switchback/core';
import { useTRPCClient } from '../trpc/react';
import { flushPendingActivities } from './activities';
import { writingReader } from './identity';
import { flushPendingReviews } from './queue';
import { readerSettled, subscribeToReader } from './reader';

export function SyncQueuedWrites() {
  const client = useTRPCClient();

  const flush = useCallback(() => {
    // No point spending a request to learn what `navigator.onLine` already said. It is a weak
    // signal in the other direction — online can mean a captive portal — but a false negative
    // here costs nothing: the next `online` event or the next page load tries again.
    if (!navigator.onLine) return;
    // This browser has not finished working out who is here. Nothing may be sent on a guess;
    // the subscription below runs this again the moment it has. See the note at the top.
    if (!readerSettled()) return;
    // Here, and not from a render. See the second half of the note at the top of this file.
    const readerId = writingReader();
    // Nobody is signed in, so nothing on this device is sendable. Both drains would reach the
    // same answer on their own; stopping here says why, and saves the two IndexedDB reads it
    // would take them to reach it on every page load of every signed-out visit.
    if (readerId === null) return;

    void (async () => {
      // Reports first, hikes second, and chained rather than run together. A report is one
      // small request and a hike is dozens; the connection that has just come back is one
      // bar, which is the same reason each drain is sequential inside itself.
      await flushPendingReviews((write: ReviewWrite) => client.reviews.upsert.mutate(write), {
        readerId,
        stillReader: writingReader,
      });
      await flushPendingActivities(
        {
          start: (input) => client.activities.start.mutate(input),
          append: (input) => client.activities.append.mutate(input),
          finish: (input) => client.activities.finish.mutate(input),
        },
        { readerId, stillReader: writingReader },
      );
    })().catch(() => {
      // Every failure mode this can produce is already recorded on the row it belongs to,
      // and shown on the trail page and in the storage manager. There is nothing useful to
      // say here that is not said somewhere a person will actually look.
    });
  }, [client]);

  useEffect(() => {
    // A no-op on the page that changed hands, where the handover has not finished yet, and the
    // ordinary first drain everywhere else — including a document restored from the
    // back/forward cache, which never mounts again but does come back settled.
    flush();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') flush();
    };
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', onVisible);
    // Every change of reader, and the end of this document's handover. `ReaderIdentity`
    // announces once it has settled, whichever way it went.
    const stopWatchingReader = subscribeToReader(flush);
    return () => {
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', onVisible);
      stopWatchingReader();
    };
  }, [flush]);

  return null;
}
