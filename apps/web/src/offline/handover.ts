/**
 * Reconciles the browser's remembered reader with the rendered one: holds the departing reader's
 * queued writes, releases the arriving reader's, and clears caches fetched under the old session.
 */

import { holdActivitiesFor, releaseActivitiesFor } from './activities';
import { CACHE_PREFIX, READER_SHELL_PAGES, SHELL_CACHE } from './caches';
import { evictTrails } from './evict';
import { rememberedReader, rememberReader } from './identity';
import { holdReviewsFor, releaseReviewsFor } from './queue';
import { listOfflineTrails } from './store';

/**
 * Deletes every byte this origin cached for the reader who has left. Three passes, in an order that
 * keeps `/downloads` honest whichever one fails. Nothing throws: a browser that refuses `caches`
 * entirely (a locked profile, a private window) still has to be able to change hands.
 */
export async function clearReaderStorage(): Promise<void> {
  let ledgerRead = true;
  try {
    // Through the ledger, so rows and bytes go together. `ASSET_CACHE` is deliberately absent from
    // the ledger — every trail page shares those chunks — so `evictTrails` owns their lifetime.
    const trails = await listOfflineTrails();
    if (trails.length > 0) await evictTrails(trails.map((row) => row.trailId));
  } catch {
    ledgerRead = false;
  }

  try {
    // By entry, not by cache name: `SHELL_CACHE` also holds `/offline`, `/downloads` and this
    // build's own chunks, which nothing refills without a full navigation.
    const shell = await caches.open(SHELL_CACHE);
    await Promise.all(READER_SHELL_PAGES.map((path) => shell.delete(path)));
  } catch {
    // `ownedBy` is what actually prevents the defect; failing this half must not fail the sign-in.
  }

  // Skipped when the ledger could not be read: its rows would then outlive their bytes, and
  // `/downloads` would list a trail as available offline with nothing behind it. No retry — a
  // later sweep cannot tell the departed reader's downloads from the arriving reader's.
  if (!ledgerRead) return;

  try {
    const names = await caches.keys();
    await Promise.all(
      names
        // Spares this build's shell, whose reader-specific entries pass two took, and deliberately
        // takes `LEGACY_SHELL_CACHE`: its `/` and `/record` were rendered for the reader leaving.
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE)
        .map((name) => caches.delete(name)),
    );
  } catch {
    // As above.
  }
}

/**
 * Reconciles the remembered reader with the one the server just rendered. A first sighting and a
 * sign-in from signed-out are not handovers: nothing such a browser cached was fetched under a name.
 */
export async function reconcileReader(rendered: string | null): Promise<boolean> {
  const remembered = rememberedReader();

  if (!remembered.known) {
    rememberReader(rendered);
    return false;
  }
  if (remembered.id === rendered) return false;

  const at = Date.now();
  // Queued writes are held, never deleted: a download can be refetched, a report written offline
  // cannot. Held before anything is cleared, so an interrupted tab still leaves the rows marked.
  if (remembered.id !== null) {
    await holdReviewsFor(remembered.id, at).catch(() => undefined);
    await holdActivitiesFor(remembered.id, at).catch(() => undefined);
  }
  if (rendered !== null) {
    await releaseReviewsFor(rendered).catch(() => undefined);
    await releaseActivitiesFor(rendered).catch(() => undefined);
  }

  // Only when a named reader is actually leaving. Null to somebody is a sign-in, not a handover.
  if (remembered.id !== null) await clearReaderStorage();
  // Last, so an interruption above leaves the handover to be run again. Every step is idempotent.
  rememberReader(rendered);
  return true;
}
