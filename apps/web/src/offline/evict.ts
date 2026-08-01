/**
 * Giving the space back.
 *
 * Deleting a download is not deleting its URLs, because tile corridors overlap: two trails
 * in the same valley share most of their z10–z12 tiles, and half their z13. Dropping one by
 * its own URL list would punch holes in the other's map — and the hole would not appear
 * until somebody was standing in it.
 *
 * So eviction is a set difference. Take everything the departing downloads referenced,
 * subtract everything still referenced by the ones that remain, and delete what is left.
 * The ledger in IndexedDB is what makes that possible; Cache Storage on its own has no idea
 * who asked for what.
 */

import { ASSET_CACHE, MEDIA_CACHE, PAGE_CACHE, TILE_CACHE } from './caches';
import { deleteOfflineTrail, getOfflineTrail, listOfflineTrails, referencedUrls } from './store';

export interface EvictionResult {
  /** Downloads removed from the ledger. */
  trails: number;
  /** Cached responses actually deleted — smaller than the trails' URL count when they share. */
  urls: number;
}

/**
 * Remove downloads and the bytes only they were holding.
 *
 * The ledger row goes first. If the cache sweep is interrupted — a closed tab, a killed
 * worker — the result is orphaned bytes, which cost storage and nothing else; the opposite
 * order would leave a download listed as available whose tiles had already gone.
 */
export async function evictTrails(trailIds: readonly string[]): Promise<EvictionResult> {
  const departing = (await Promise.all(trailIds.map(getOfflineTrail))).filter(
    (row): row is NonNullable<typeof row> => row !== null,
  );
  if (departing.length === 0) return { trails: 0, urls: 0 };

  const keep = await referencedUrls(trailIds);
  const candidates = new Set<string>();
  for (const row of departing) {
    for (const url of [...row.tileUrls, ...row.pageUrls, ...row.mediaUrls]) {
      if (!keep.has(url)) candidates.add(url);
    }
  }

  for (const row of departing) await deleteOfflineTrail(row.trailId);

  let urls = 0;
  for (const name of [TILE_CACHE, PAGE_CACHE, MEDIA_CACHE]) {
    const cache = await caches.open(name);
    // Sequential rather than a `Promise.all` over thousands of keys: Cache Storage is backed
    // by the disk, and a few thousand simultaneous deletes on a phone makes the UI stutter
    // for no gain — the operation is bounded by IO either way.
    for (const url of candidates) {
      if (await cache.delete(url)) urls += 1;
    }
  }

  /*
   * The build assets are the one thing not in the set difference, because they are not in the
   * ledger: `download.ts` deliberately does not list a page's `/_next/static/*` against the
   * trail that happened to fetch them, since every trail page shares them and evicting them
   * with one trail would blank the others.
   *
   * That leaves them with no owner, and `ASSET_CACHE` is hand-versioned precisely so a deploy
   * does not sweep it — so without this it only ever grows, a chunk set per build a download
   * was ever made on. The moment there are no downloads left there is nothing that can need
   * them: an online page fetches its own chunks and `handleStatic` refills the shell. So the
   * whole cache goes, all at once, which is cheap and needs no ledger.
   *
   * Anything short of "none left" is deliberately not attempted. Working out which chunk a
   * remaining download still names would mean re-reading its stored markup, and getting it
   * wrong costs a hiker a page that will not render in a place with no signal to repair it.
   */
  if ((await listOfflineTrails()).length === 0) await caches.delete(ASSET_CACHE);

  return { trails: departing.length, urls };
}

/**
 * What the browser says this origin is using, and what it will allow.
 *
 * Reported rather than the sum of our own measured downloads, because they answer different
 * questions: ours is "what did these trails cost", this is "how close am I to the point
 * where the browser starts evicting things without asking". Both are shown.
 *
 * Absent on Safari before 17 and in some private modes, hence the null.
 */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  if (typeof usage !== 'number' || typeof quota !== 'number') return null;
  return { usage, quota };
}

/**
 * Ask the browser not to evict us under storage pressure.
 *
 * Worth asking exactly once, at the first download: an unpersisted origin's caches are
 * best-effort, and "best effort" is decided by an eviction heuristic that has never been on
 * a mountain. Chrome grants this silently to installed or frequently-visited sites; Firefox
 * prompts; Safari decides on its own. A refusal is not an error — the download still works,
 * it is just evictable.
 */
export async function requestPersistence(): Promise<boolean> {
  if (!navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
