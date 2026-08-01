'use client';

/**
 * Installs the service worker after hydration. Skipped in development: a worker caching
 * `/_next/static` in front of a dev server makes edits appear to do nothing, intermittently.
 */

import { useEffect } from 'react';
import { BUILD_ID } from './caches';

export function RegisterServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return;
    if (!('serviceWorker' in navigator)) return;

    // After load, not during: registration competes with the page's own requests.
    const register = () => {
      // The build id rides in the query string — the only channel into a file outside the module
      // graph, and a changed URL is a different worker, so a deploy installs rather than waits.
      navigator.serviceWorker
        .register(`/sw.js?v=${encodeURIComponent(BUILD_ID)}`, { scope: '/' })
        .catch((error: unknown) => {
          // For a developer console and nowhere else: the site works without it, minus offline.
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
