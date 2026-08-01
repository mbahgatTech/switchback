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
 * **The reader-specific bytes go.** Everything cleared under `sb-` was fetched with A's cookie:
 * the shell holds `/record` as it rendered for A, complete with the name and start time of any
 * recording they left open, and the downloaded trail pages hold A's own hikes on those trails.
 * Those are A's, they are one layer under the page B is looking at, and the service worker will
 * serve them to B the moment the signal drops. So they are deleted, along with the downloads
 * ledger that names them.
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
 *
 * ---
 *
 * **Nobody is not somebody.** Two of the transitions this function sees are not changes of
 * hands at all, and neither may destroy a download:
 *
 * - *The first sighting.* A browser with no remembered reader has not loaded a page since this
 *   shipped. It is recorded and nothing else.
 * - *Nobody to somebody.* Downloads need no account — `/downloads` checks no session and the
 *   download button on a trail page has no auth gate — so the ordinary way to acquire trails is
 *   to do it signed out and sign in afterwards. Every cache such a browser holds was fetched
 *   with no session at all, so there is no account data in it to protect and nothing is bought
 *   by deleting it. What it costs is the map for the hike being planned. The same branch fires
 *   on an ordinary session lapse — thirty days, on a single-user phone — where A → null → A
 *   would otherwise wipe the downloads twice.
 *
 * Somebody to nobody *is* a change of hands: signing out is a person leaving a machine, and
 * what they leave behind was fetched under their name.
 */

import { holdActivitiesFor, releaseActivitiesFor } from './activities';
import { CACHE_PREFIX, READER_SHELL_PAGES, SHELL_CACHE } from './caches';
import { evictTrails } from './evict';
import { rememberedReader, rememberReader } from './identity';
import { holdReviewsFor, releaseReviewsFor } from './queue';
import { listOfflineTrails } from './store';

/**
 * Delete every byte this origin cached for the reader who has left.
 *
 * Three passes, in the order that keeps `/downloads` honest whichever of them fails.
 *
 * **The downloads, through the ledger.** So the row and the bytes go together; see the note at
 * the top.
 *
 * **The reader-specific shell pages, by entry rather than by cache.** `SHELL_CACHE` also holds
 * `/offline`, `/downloads` and the current build's own chunks — impersonal, and unrepairable in
 * practice once dropped, because `install` runs once per worker version and `repairShell` only
 * fires on a real navigation, which App Router client routing never performs. Deleting the cache
 * by name cost a hiker who signed in and then lost signal a plain-text 503 on `/`, `/downloads`
 * and `/record`. See `READER_SHELL_PAGES`.
 *
 * **Everything else under `sb-`** — tiles, trail pages, photographs, the previous build's shell
 * under `LEGACY_SHELL_CACHE`, and any cache orphaned by a version bump that `activate` has not
 * got to yet. The legacy shell belongs in that list rather than beside `SHELL_CACHE`: its copies
 * of `/` and `/record` were rendered for the reader who is leaving, and the only thing the worker
 * still reads out of it is `/_next/static/*`, which `adoptLegacyShell` has already carried across.
 *
 * `ASSET_CACHE` is swept there too, and is almost always gone before the sweep reaches it. The
 * harvested chunks are deliberately absent from the ledger — `download.ts` will not list them
 * against one trail, because every trail page shares them and evicting them with one trail would
 * blank the others — so `evictTrails` owns their lifetime instead and drops the whole cache the
 * moment the last download does. The first pass above evicts every trail, which is that moment.
 * What can still be there afterwards is a cache belonging to no download at all, and
 * content-hashed build output belongs to nobody in any case.
 *
 * That last pass is skipped when the ledger could not be read. Its rows would then survive
 * while their bytes did not, and `/downloads` would list a trail as available offline with a
 * byte count against it and nothing behind it — the dishonesty `evict.ts` is written to
 * prevent, arrived at from the other side. Keeping another reader's tiles is the smaller harm
 * than lying to this one about what is on the disk. Skipping it is also what keeps those
 * surviving downloads legible: a page in `PAGE_CACHE` names hashed URLs no current build serves,
 * and `handleStatic` finds them by looking in `ASSET_CACHE` second, so taking that cache while
 * leaving the pages would give a hiker with no signal React's error boundary out of a cache that
 * contains the page.
 *
 * There is deliberately no retry for that case, and it is worth being plain about the residual.
 * A later sweep cannot tell the departed reader's downloads from ones made since — the ledger
 * that would say so is the thing that was unreadable — so a retry would delete the arriving
 * hiker's own trails on some later page load, for a reason they could not see. The handover is
 * still recorded as done, because it must be: `rememberReader` is what makes `writingReader()`
 * name the person actually here, and leaving it unwritten would stamp the new reader's own
 * reports with the old reader's id. So on a browser whose IndexedDB was unreadable at the
 * moment the account changed, the previous reader's downloaded trail pages may outlive them.
 *
 * Nothing here throws: a browser that refuses `caches` entirely (a locked profile, a private
 * window) still has to be able to change hands.
 */
export async function clearReaderStorage(): Promise<void> {
  let ledgerRead = true;
  try {
    const trails = await listOfflineTrails();
    if (trails.length > 0) await evictTrails(trails.map((row) => row.trailId));
  } catch {
    ledgerRead = false;
  }

  try {
    const shell = await caches.open(SHELL_CACHE);
    await Promise.all(READER_SHELL_PAGES.map((path) => shell.delete(path)));
  } catch {
    // No Cache Storage, or no permission to it. The queue guard is what actually prevents the
    // defect; this is the disclosure half, and failing it must not fail the sign-in.
  }

  if (!ledgerRead) return;

  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
        .map((name) => caches.delete(name)),
    );
  } catch {
    // As above.
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
 *
 * **Nor is signing in on a browser that was signed out.** Same argument, one transition later:
 * a download needs no account, so acquiring trails signed out and signing in afterwards is the
 * ordinary order of events rather than an unusual one, and nothing in those caches was fetched
 * under anybody's name. The queue is still held and released — that costs nothing and keeps the
 * marks consistent — but nothing is deleted. See the module note.
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

  // Only when a named reader is actually leaving. Null to somebody is a sign-in, not a
  // handover, and what it would destroy was fetched with no session at all.
  if (remembered.id !== null) await clearReaderStorage();
  // Last, so an interruption anywhere above leaves the handover to be run again rather than
  // recorded as done. Every step of it is idempotent, which is what makes that safe.
  rememberReader(rendered);
  return true;
}
