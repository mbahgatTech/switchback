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
 * copy re-assert an account that has since gone — so the id is only believed when the browser
 * says it is online, which is exactly when the network-first navigation handler proves it came
 * from the server. What makes even that safe is that `reconcileReader` deletes those copies on
 * every change of hands, so a cached page belonging to somebody other than the remembered
 * reader does not survive to be read.
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
 * a fact about this document, and a client navigation neither remounts `ReaderIdentity` nor
 * changes who is here. A restore from the back/forward cache brings it back as true, which is
 * correct — the handover did run, and what may have changed since is the reader, which is read
 * fresh at the moment of every write.
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

export function ReaderIdentity({ readerId }: { readerId: string | null }) {
  useEffect(() => {
    // A page the network did not serve is the previous reader's HTML. See the note above.
    if (!navigator.onLine) {
      refreshReaderSnapshot();
      return;
    }
    reconcileReader(readerId)
      .then(refreshReaderSnapshot)
      .catch(() => {
        // Every branch inside `reconcileReader` already swallows its own failure; this is the
        // outer guard for a browser with no storage at all. The drains stay safe regardless —
        // they refuse a row whose owner is not the reader, and an unreadable memory makes the
        // reader null, which owns nothing.
        refreshReaderSnapshot();
      });
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
