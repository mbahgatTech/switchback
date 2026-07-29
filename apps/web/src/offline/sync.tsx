'use client';

/**
 * Sending what was written where there was no signal.
 *
 * Mounted once in the layout, renders nothing, and exists so that a hiker never has to
 * remember they owe the queue anything. They wrote the report on the ridge; the moment the
 * phone finds a tower — or the moment they next open the site at all — it goes out.
 *
 * This is the web half of the plan's "Background Sync flushes recorded activities and queued
 * reviews when connectivity returns". Deliberately not the Background Sync API: that is
 * Chromium-only, and the hikers most likely to need this are on iPhones. A listener on
 * `online` plus a flush on mount covers every browser, at the cost of only firing while a tab
 * is open — which, for a person who has just come back into signal and is looking at their
 * phone, is when it fires anyway.
 */

import { useCallback, useEffect } from 'react';
import type { ReviewWrite } from '@switchback/core';
import { useTRPCClient } from '../trpc/react';
import { flushPendingReviews } from './queue';

export function SyncQueuedWrites() {
  const client = useTRPCClient();

  const flush = useCallback(() => {
    // No point spending a request to learn what `navigator.onLine` already said. It is a weak
    // signal in the other direction — online can mean a captive portal — but a false negative
    // here costs nothing: the next `online` event or the next page load tries again.
    if (!navigator.onLine) return;
    void flushPendingReviews((write: ReviewWrite) => client.reviews.upsert.mutate(write)).catch(
      () => {
        // Every failure mode this can produce is already recorded on the row it belongs to,
        // and shown on the trail page and in the storage manager. There is nothing useful to
        // say here that is not said somewhere a person will actually look.
      },
    );
  }, [client]);

  useEffect(() => {
    flush();
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [flush]);

  return null;
}
