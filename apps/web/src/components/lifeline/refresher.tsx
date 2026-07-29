'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Keep the follow page current without asking anyone to press anything.
 *
 * A `router.refresh()` on a timer rather than a subscription or a polling query, because the
 * page is server-rendered and the refresh is the whole update: new position, new status, new
 * gauge, all recomputed on the server where the overdue rule already lives. There is no
 * second rendering path to keep in step, and the page is correct with JavaScript switched
 * off — it is then simply a page you reload yourself, which is what the printed timestamp
 * beside this is for.
 *
 * **It stops while the tab is hidden.** Somebody waiting on a hike leaves this open for
 * hours; a timer that kept firing in a background tab would spend their battery to redraw a
 * page nobody is looking at. Coming back to the tab refreshes immediately, so the first
 * thing they see on returning is current rather than however old the tab was.
 */

export interface RefresherProps {
  /** Seconds between refreshes while the page is visible. */
  everyS: number;
}

export function Refresher({ everyS }: RefresherProps) {
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = (): void => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = (): void => {
      stop();
      timer = setInterval(() => router.refresh(), Math.max(15, everyS) * 1000);
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        router.refresh();
        start();
      } else {
        stop();
      }
    };

    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [everyS, router]);

  return null;
}
