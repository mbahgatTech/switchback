/**
 * When the browser changes hands.
 *
 * One function, and it is the whole of the answer to the shared-computer case. Person A hikes,
 * writes a report on a ridge with no signal, closes the laptop. Person B opens it and signs
 * in. Between those two facts, three things have to happen before B's first page finishes
 * rendering, and none of them used to happen at all.
 *
 * **A's queued writes are marked, not deleted.** They cannot be sent — `ownedBy` in
 * `identity.ts` already refuses that, and refuses it whatever this file does — but the row
 * still has to be kept. Deleting it would destroy the only copy of a report or a day's track
 * on the strength of somebody else signing in, which is a larger loss than the one being
 * prevented. So the rows are stamped `heldAt` and shown as held: sign in as that person and
 * they go out untouched.
 *
 * **B's own held rows are released.** The same function runs in the other direction, so a
 * hiker who signs out and back in — or who shares a machine with a partner and takes turns —
 * finds their queue exactly as they left it rather than permanently marked.
 *
 * **The reader-specific bytes go.** Everything in Cache Storage under `sb-` was fetched with
 * A's cookie: the shell holds `/record` as it rendered for A, complete with the name and start
 * time of any recording they left open, and the downloaded trail pages hold A's own hikes on
 * those trails. Those are A's, they are one layer under the page B is looking at, and the
 * service worker will serve them to B the moment the signal drops. So they are deleted, along
 * with the downloads ledger that names them.
 *
 * That last one is the only thing here that destroys anything, and the line it draws is worth
 * saying out loud: **a download can be fetched again and a queued write cannot.** Trails come
 * back from the network for the cost of one download; a report written on a ridge exists
 * nowhere else in the world. So the caches are cleared and the queue is kept, and the two
 * halves of this file are that one distinction applied twice.
 *
 * `evictTrails` is used rather than a bare `caches.delete`, so the ledger and the bytes go
 * together. A ledger row left behind would list a trail as available offline whose tiles had
 * gone — the exact dishonesty `evict.ts` exists to prevent — and bytes left behind with no
 * ledger row could never be reclaimed by anything.
 */

import { holdActivitiesFor, releaseActivitiesFor } from './activities';
import { CACHE_PREFIX } from './caches';
import { evictTrails } from './evict';
import { rememberedReader, rememberReader } from './identity';
import { holdReviewsFor, releaseReviewsFor } from './queue';
import { listOfflineTrails } from './store';

/**
 * Delete every byte this origin cached for the reader who has left.
 *
 * Downloads first and through the ledger, then a sweep for anything under `sb-` that no
 * download claimed — the shell, and any cache orphaned by a version bump that `activate` has
 * not got to yet. Nothing here throws: a browser that refuses `caches` entirely (a locked
 * profile, a private window) still has to be able to change hands.
 */
export async function clearReaderStorage(): Promise<void> {
  try {
    const trails = await listOfflineTrails();
    if (trails.length > 0) await evictTrails(trails.map((row) => row.trailId));
  } catch {
    // The sweep below still runs, and it is the one that removes the reader-specific pages.
  }

  try {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith(CACHE_PREFIX)).map((name) => caches.delete(name)),
    );
  } catch {
    // No Cache Storage, or no permission to it. The queue guard is what actually prevents the
    // defect; this is the disclosure half, and failing it must not fail the sign-in.
  }
}

/**
 * Reconcile the browser's memory of who is here with the page the server just rendered.
 *
 * Called from `ReaderIdentity` on every page, and does nothing on the overwhelming majority of
 * them — the id has not changed, and this returns after one `localStorage` read.
 *
 * **The first sighting is not a change of hands.** A browser with no remembered reader is one
 * that has not loaded a page since this shipped, and clearing its caches would take away the
 * downloads of every hiker in the product on the same afternoon to protect against a change
 * that probably did not happen. It is recorded and nothing else. Every change after it is
 * caught, and the queued rows from before are handled by being unattributed rather than by
 * being guessed at.
 */
export async function reconcileReader(rendered: string | null): Promise<boolean> {
  const remembered = rememberedReader();

  if (!remembered.known) {
    rememberReader(rendered);
    return false;
  }
  if (remembered.id === rendered) return false;

  const at = Date.now();
  // Held before anything is cleared: if the tab is closed half-way through, the rows a person
  // wrote are already marked and the worst outcome is a cache sweep that has to run again.
  if (remembered.id !== null) {
    await holdReviewsFor(remembered.id, at).catch(() => undefined);
    await holdActivitiesFor(remembered.id, at).catch(() => undefined);
  }
  if (rendered !== null) {
    await releaseReviewsFor(rendered).catch(() => undefined);
    await releaseActivitiesFor(rendered).catch(() => undefined);
  }

  await clearReaderStorage();
  // Last, so an interruption anywhere above leaves the handover to be run again rather than
  // recorded as done. Every step of it is idempotent, which is what makes that safe.
  rememberReader(rendered);
  return true;
}
