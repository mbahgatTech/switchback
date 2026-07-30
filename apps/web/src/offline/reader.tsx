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
 */

import { useEffect, useSyncExternalStore } from 'react';
import { reconcileReader } from './handover';
import { rememberedReader } from './identity';

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
 * Cached because `useSyncExternalStore` compares snapshots by identity and calls this on every
 * render — a fresh read of `localStorage` each time would be a re-render loop rather than a
 * subscription. Invalidated by `announce`, which is the only thing that can change the answer.
 */
let snapshot: string | null = null;
let snapshotRead = false;

function readerSnapshot(): string | null {
  if (!snapshotRead) {
    snapshot = rememberedReader().id;
    snapshotRead = true;
  }
  return snapshot;
}

function refreshReaderSnapshot(): void {
  snapshotRead = false;
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
    // On mount and on a change of the rendered id, and deliberately on nothing else. There is
    // no listener for another tab moving the remembered reader on: this document was rendered
    // for `readerId`, and re-asserting that on a timer or a visibility change would let two
    // tabs signed in as two people take it in turns to clear each other's storage. Every
    // transition that matters is a full document load anyway — an OAuth callback and a
    // sign-out redirect both are — and what stands between the transitions is not this effect
    // but `ownedBy`, which refuses a row whatever the browser has remembered.
  }, [readerId]);

  return null;
}
