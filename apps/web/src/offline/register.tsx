'use client';

/**
 * Installing the service worker.
 *
 * A component rather than a script tag, because registration has to happen after hydration
 * and only in a browser that has the API — Safari in private mode does not, and iOS did not
 * until 11.3. It renders nothing.
 *
 * Registration is deliberately unconditional in production and skipped in development. A
 * worker that caches `/_next/static` in front of a dev server that rebuilds those files on
 * every keystroke produces the worst debugging experience this stack can offer: edits that
 * appear to do nothing, intermittently.
 */

import { useEffect } from 'react';

export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    // After load, not during: registration competes with the page's own requests for the
    // connection, and the page is what the user is waiting for.
    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((error: unknown) => {
        // Worth surfacing to a developer console and nowhere else — the site works without
        // it, minus the offline half, and there is nothing the reader can do about it.
        console.error('Service worker registration failed', error);
      });
    };

    if (document.readyState === 'complete') {
      register();
      return;
    }
    window.addEventListener('load', register, { once: true });
    return () => window.removeEventListener('load', register);
  }, []);

  return null;
}
