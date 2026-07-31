'use client';

/**
 * The reader this browser is acting as, told once per page and read everywhere.
 *
 * `<ReaderIdentity>` is mounted in the root layout and renders nothing. It is given the id the
 * server just rendered the page for — a value the layout already has, so it costs no request —
 * and it does two things with it: records it as the browser's own answer to "who is here", and
 * runs the handover when that answer has changed. Everything else in `offline/` reads the
 * recorded value rather than a prop, because the two places that need it most are a recorder
 * writing a fix and a form catching a failed post, and both need it synchronously, several
 * layers down, at a moment nothing is re-rendering.
 *
 * **A cached page is not evidence of a session.** The service worker serves `/record` and the
 * downloaded trail pages from Cache Storage when the network fails, and that HTML was rendered
 * for whoever was signed in when it was stored. Adopting the id out of it would let a stale
 * copy re-assert an account that has since gone — or, on a page downloaded signed out, assert
 * that nobody is here and sign the current reader out of their own device. So the rendered id
 * is never acted on by itself: when it disagrees with what the browser remembers, the origin is
 * asked directly and *its* answer is what the handover runs on. See `askTheServer`. What makes
 * even that safe is that `reconcileReader` deletes those copies on every change of hands, so a
 * cached page belonging to somebody other than the remembered reader does not survive to be
 * read.
 *
 * `navigator.onLine` used to stand in for that question and could not: the worker falls back to
 * the cache when `fetch` throws, and a captive portal or a dead data session throws while
 * `onLine` is still true.
 *
 * `useSyncExternalStore` rather than `useState` plus an effect, so a component that renders
 * during the handover sees one value and not two. The server snapshot is `null`: on the server
 * there is no browser to have a memory, and a page that guessed would flash the wrong answer.
 *
 * **What this hook is for, and what it is not for.** It is for drawing: which queue to show,
 * whether to offer a claim button. It is not for deciding what may be sent. A subscribed value
 * is still a value from a render, and the two cases that matter — another tab signing in, and
 * a document restored from the back/forward cache — are exactly the cases where the last
 * render happened under one account and the next request will carry another's cookie. Anything
 * that *acts* calls `writingReader()` in `identity.ts` at the moment it acts. See the note
 * there.
 */

import { useEffect, useSyncExternalStore } from 'react';
import { reconcileReader } from './handover';
import { readerKeyChanged, rememberedReader } from './identity';

/**
 * Everyone rendering something that depends on who is here.
 *
 * A module-level set, like the two queues use, and for the same reason: the value is written
 * by a component in the layout and read by a form on a trail page and a list on `/downloads`,
 * and threading a provider between those three would be more wiring than the six lines it
 * replaces.
 */
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The same subscription, for something that is not a component.
 *
 * `SyncQueuedWrites` uses it to learn that this browser has finished deciding who is here —
 * which is the moment its first drain is allowed to run, and the moment another tab's sign-in
 * reaches this one. Returns an unsubscribe, like the hook's own.
 */
export function subscribeToReader(listener: () => void): () => void {
  return subscribe(listener);
}

/**
 * Cached because `useSyncExternalStore` compares snapshots by identity and calls this on every
 * render — a fresh read of `localStorage` each time would be a re-render loop rather than a
 * subscription. Invalidated by `announce`, which is the only thing that can change the answer.
 */
let snapshot: string | null = null;
let snapshotRead = false;

/**
 * Whether the handover for this document has run to an answer.
 *
 * False from the moment the module loads until `ReaderIdentity`'s effect has settled, whichever
 * way it went. It matters because `reconcileReader` is asynchronous: on the page where the
 * account changed, everything else in the layout mounts while `localStorage` still names the
 * person who left, and a drain that read it then would be honest and wrong. `SyncQueuedWrites`
 * asks this before its first run.
 *
 * Module state rather than a subscription value, and deliberately not reset by anything: it is
 * a fact about this document. A client navigation does not remount `ReaderIdentity` — and does
 * not re-render the root layout at all, which is why a sign-out that is only a `router.push`
 * has to call `forgetReaderNow` rather than wait to be noticed. A restore from the back/forward
 * cache brings this back as true, which is correct — the handover did run, and what may have
 * changed since is the reader, which is read fresh at the moment of every write.
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

/** Null on the server, and null for the first client render — see the note on the component. */
function serverSnapshot(): string | null {
  return null;
}

/**
 * Who this browser is acting as, as a component sees it.
 *
 * Null means the browser is acting as nobody: signed out, or never told. Both mean the same
 * thing to anything that renders a queue — nothing here is yours, and nothing will be sent.
 */
export function useReaderId(): string | null {
  return useSyncExternalStore(subscribe, readerSnapshot, serverSnapshot);
}

/**
 * Who the server says is here, or `undefined` when it could not be asked.
 *
 * The one question `ReaderIdentity` cannot answer from the page it is rendered in: a document
 * served out of Cache Storage is the *previous* reader's HTML, and its embedded id is whatever
 * was true when it was stored. This used to be inferred from `navigator.onLine`, which is not
 * the same test the service worker applies — `handleNavigation` falls back to the cache when
 * `fetch` throws, and a captive portal, a dead data session or a DNS failure all throw with
 * `onLine` still true. So a stale copy could assert an account that had since gone, and on a
 * page downloaded while signed out it could assert *nobody*, which runs the sign-out handover
 * against a reader who is signed in: their queued report and live hike marked as held for
 * somebody else, every download deleted, every later fix unattributed.
 *
 * Asking the origin replaces the inference with a fact. `/api/*` is excluded from the worker's
 * fetch handler, so this reaches the network or throws — there is no cached third answer. A
 * captive portal that answers 200 with its own HTML fails the `json()` and is reported as
 * "could not ask", which is the safe reading: reconcile nothing and try again next load.
 *
 * `undefined` rather than `null` for the failure, because `null` is a real and actionable
 * answer here — it is what a signed-out browser gets, and it is what triggers the handover
 * this whole file exists to run.
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
    // No network, a captive portal, a body that is not the shape we asked for. All of them
    // mean the same thing: nothing here is proven, so nothing is reconciled.
    return undefined;
  }
}

/**
 * End this browser's reader session now, without waiting for a page to re-render.
 *
 * `ReaderIdentity`'s effect keys on the `readerId` prop, and that prop comes from the root
 * layout — which a client-side `router.push` does not re-render. Measured on this repo: a soft
 * navigation's flight response contains the page's own subtree and no root-layout output at
 * all, so a sign-out implemented as a push leaves `ReaderIdentity` mounted with the departing
 * reader's id. Nothing in `offline/` would hear it: `localStorage` would still name them,
 * `writingReader()` would still return them, their cached `/record` and downloaded trail pages
 * would stay on the shared machine, and `SyncQueuedWrites` would keep firing against a dead
 * session on every `visibilitychange` until the next full document load.
 *
 * So the handover gets a door that does not depend on a render. **Every path that ends this
 * browser's session must call this** — the header's sign-out, and the settings page's "Sign out
 * everywhere" once that revokes the browser's own session row and not only the mobile tokens.
 * `router.refresh()` beside the push would work too, but it makes a security guarantee depend
 * on one caller's choice of navigation, which is how it came to be missing in the first place.
 *
 * Awaits the handover so a caller can navigate after it rather than during it. Never throws:
 * `reconcileReader` swallows each of its own steps, and a sign-out must not be able to fail
 * because Cache Storage did.
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
      // The overwhelming majority of page loads, and the only path that costs nothing. The
      // page and the browser already agree, so `reconcileReader` would return after one
      // `localStorage` read — and where the HTML came from cannot change that answer.
      if (remembered.known && remembered.id === readerId) {
        refreshReaderSnapshot();
        return;
      }

      // They disagree, so something is about to be held, released or deleted. Ask the origin
      // rather than trusting the page, and act on what it says rather than on what was
      // rendered: the server's answer is current, and a cached page's is not. See
      // `askTheServer`.
      const confirmed = await askTheServer();
      if (cancelled) return;
      if (confirmed === undefined) {
        // Nothing is proven. Leave the memory exactly as it is and let the next page try —
        // this is the same restraint the queue applies to a row it cannot attribute.
        refreshReaderSnapshot();
        return;
      }

      reconcileReader(confirmed)
        .then(refreshReaderSnapshot)
        .catch(() => {
          // Every branch inside `reconcileReader` already swallows its own failure; this is
          // the outer guard for a browser with no storage at all. The drains stay safe
          // regardless — they refuse a row whose owner is not the reader, and an unreadable
          // memory makes the reader null, which owns nothing.
          refreshReaderSnapshot();
        });
    })();

    return () => {
      cancelled = true;
    };
    // On mount and on a change of the rendered id, and deliberately on nothing else. Nothing
    // re-asserts the rendered id on a timer or a visibility change: two tabs signed in as two
    // people would then take it in turns to clear each other's storage. The effect below
    // listens for the other tab, but only ever *invalidates the snapshot* — it never runs
    // `reconcileReader`, so there is nothing for the two tabs to fight over.
  }, [readerId]);

  useEffect(() => {
    /*
     * What another tab did, and what the back button undid.
     *
     * `storage` fires on every document of this origin except the one that wrote — so it is
     * the only notice a tab that is merely *open* gets that somebody signed in elsewhere.
     * `pageshow` with `persisted` is the same fact arriving by the other route: a document
     * restored from the back/forward cache keeps every module value it had, including this
     * snapshot, and the browser it woke up in may have changed hands while it slept.
     *
     * Both do one thing: forget the cached answer so the next render reads `localStorage`
     * again. Neither reconciles, neither deletes, and neither is what stops a queued row going
     * to the wrong account — `writingReader()` at the moment of the write is. This keeps the
     * *screen* honest, which is a smaller job and still worth doing: a claim button offered to
     * somebody who signed out two tabs ago is a button that cannot work.
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
