'use client';

/**
 * The reader this browser is acting as, recorded once per page by `<ReaderIdentity>` and read
 * everywhere synchronously. For *drawing* only — anything that acts calls `writingReader()`.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { reconcileReader } from './handover';
import { readerKeyChanged, rememberedReader } from './identity';

/** Everyone rendering something that depends on who is here. Module-level, like the two queues. */
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The same subscription for something that is not a component: `SyncQueuedWrites` uses it to learn
 * that this browser has finished deciding who is here, which gates its first drain.
 */
export function subscribeToReader(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * Cached because `useSyncExternalStore` compares snapshots by identity and calls this every render:
 * a fresh `localStorage` read each time would be a re-render loop. Invalidated only by `announce`.
 */
let snapshot: string | null = null;
let snapshotRead = false;

/**
 * Whether the handover for this document has run to an answer, either way. `reconcileReader` is
 * async, so a drain that read `localStorage` before it settled would be honest and wrong.
 * Deliberately never reset: it is a fact about this document, and a bfcache restore keeps it true.
 */
let settled = false;

export function readerSettled(): boolean {
  return settled;
}

function readerSnapshot(): string | null {
  if (!snapshotRead) {
    snapshot = rememberedReader().id;
    snapshotRead = true;
  }
  return snapshot;
}

function refreshReaderSnapshot(): void {
  snapshotRead = false;
  settled = true;
  announce();
}

/** Null on the server, and null for the first client render. */
function serverSnapshot(): string | null {
  return null;
}

/**
 * Who this browser is acting as, as a component sees it. Null means the browser is acting as
 * nobody — signed out, or never told — and to a rendered queue both mean "nothing here is yours".
 */
export function useReaderId(): string | null {
  return useSyncExternalStore(subscribe, readerSnapshot, serverSnapshot);
}

/**
 * Who the server says is here, or `undefined` when it could not be asked. Necessary because a
 * document served out of Cache Storage carries whatever id was true when it was stored, and
 * `navigator.onLine` cannot tell you which it is — the worker falls back when `fetch` throws.
 * `undefined` rather than `null` for the failure: `null` is a real answer that runs the handover.
 */
async function askTheServer(): Promise<string | null | undefined> {
  try {
    const response = await fetch('/api/reader', {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return undefined;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('id' in body)) return undefined;
    const { id } = body;
    if (id === null) return null;
    return typeof id === 'string' && id !== '' ? id : undefined;
  } catch {
    // No network, a captive portal, or a body that is not the shape we asked for: nothing is
    // proven, so nothing is reconciled.
    return undefined;
  }
}

/**
 * Ends this browser's reader session now. **Every path that ends the session must call this**: a
 * sign-out done as a client `router.push` does not re-render the root layout, so `ReaderIdentity`
 * would stay mounted with the departing reader's id and nothing in `offline/` would hear it.
 * Awaits the handover so a caller can navigate after it, and never throws.
 */
export async function forgetReaderNow(): Promise<void> {
  try {
    await reconcileReader(null);
  } catch {
    // As `ReaderIdentity` below: the outer guard for a browser with no storage at all.
  } finally {
    refreshReaderSnapshot();
  }
}

export function ReaderIdentity({ readerId }: { readerId: string | null }) {
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const remembered = rememberedReader();
      // The overwhelming majority of page loads, and the only path that costs nothing.
      if (remembered.known && remembered.id === readerId) {
        refreshReaderSnapshot();
        return;
      }

      // They disagree, so something is about to be held, released or deleted. Ask the origin: a
      // cached page's embedded id is whatever was true when it was stored. See `askTheServer`.
      const confirmed = await askTheServer();
      if (cancelled) return;
      if (confirmed === undefined) {
        // Nothing is proven. Leave the memory as it is and let the next page try.
        refreshReaderSnapshot();
        return;
      }

      reconcileReader(confirmed)
        .then(refreshReaderSnapshot)
        .catch(() => {
          // Outer guard for a browser with no storage at all. The drains stay safe regardless:
          // an unreadable memory makes the reader null, and null owns nothing.
          refreshReaderSnapshot();
        });
    })();

    return () => {
      cancelled = true;
    };
    // On mount and on a change of the rendered id, deliberately nothing else: re-asserting it on
    // a timer or a visibility change would let two tabs take turns clearing each other's storage.
  }, [readerId]);

  useEffect(() => {
    /*
     * What another tab did (`storage`, which fires on every document but the writer) and what the
     * back button undid (`pageshow` with `persisted`, which restores stale module state). Both
     * only invalidate the cached answer — neither reconciles, and neither is what keeps a queued
     * row off the wrong account. That is `writingReader()` at the moment of the write.
     */
    const onStorage = (event: StorageEvent): void => {
      if (readerKeyChanged(event.key)) refreshReaderSnapshot();
    };
    const onPageShow = (event: PageTransitionEvent): void => {
      if (event.persisted) refreshReaderSnapshot();
    };
    window.addEventListener('storage', onStorage);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  return null;
}
