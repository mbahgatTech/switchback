'use client';

/**
 * Drains both offline queues when the browser can send again. Mounted once in the layout, renders
 * nothing, and never sends a row it does not own — the reader is read at the instant of the request.
 *
 * Three triggers, because `online` alone is not enough: iOS Safari fires it unreliably, and a phone
 * switched on at the trailhead boots already online with no transition to fire on.
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
    if (!navigator.onLine) return;
    // This browser has not finished working out who is here. Nothing may be sent on a guess;
    // the subscription below runs this again the moment it has.
    if (!readerSettled()) return;
    // Here, and not from a render: another tab's sign-in or a bfcache restore makes the last
    // rendered answer a person who left while the next request carries the arriver's cookie.
    const readerId = writingReader();
    // Nobody is signed in, so nothing on this device is sendable.
    if (readerId === null) return;

    void (async () => {
      // Reports first and chained rather than run together: a report is one small request, a
      // hike is dozens, and the connection that has just come back is one bar.
      await flushPendingReviews((write: ReviewWrite) => client.reviews.upsert.mutate(write), {
        readerId,
        // Handed on so each drain re-asks: a sign-in can land mid-flush as easily as before it.
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
      // Every failure mode this produces is already recorded on the row it belongs to and shown
      // on the trail page and in the storage manager.
    });
  }, [client]);

  useEffect(() => {
    // A no-op on the page that changed hands, where the handover has not finished; the ordinary
    // first drain everywhere else, including a bfcache restore that never mounts again.
    flush();
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') flush();
    };
    window.addEventListener('online', flush);
    document.addEventListener('visibilitychange', onVisible);
    // Every change of reader, and the end of this document's handover. Also catches another tab.
    const stopWatchingReader = subscribeToReader(flush);
    return () => {
      window.removeEventListener('online', flush);
      document.removeEventListener('visibilitychange', onVisible);
      stopWatchingReader();
    };
  }, [flush]);

  return null;
}
