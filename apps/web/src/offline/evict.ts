/**
 * Giving the space back. Eviction is a set difference, not a delete of the departing trail's URLs:
 * corridors overlap, so dropping one by its own list would punch holes in another trail's map.
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
 * Removes downloads and the bytes only they were holding. The ledger row goes first: an interrupted
 * sweep then leaves orphaned bytes, where the opposite order would list a trail whose tiles had gone.
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
    // Sequential rather than a `Promise.all` over thousands of keys: Cache Storage is on disk,
    // and thousands of simultaneous deletes make a phone stutter for no gain.
    for (const url of candidates) {
      if (await cache.delete(url)) urls += 1;
    }
  }

  /*
   * `ASSET_CACHE` is deliberately absent from the ledger — every trail page shares those chunks —
   * so it has no owner and nothing else would ever reclaim it. With no downloads left nothing can
   * need them, so the whole cache goes at once. Anything short of "none left" is not attempted:
   * guessing which chunks a remaining download still names costs a page that will not render.
   */
  if ((await listOfflineTrails()).length === 0) await caches.delete(ASSET_CACHE);

  return { trails: departing.length, urls };
}

/**
 * What the browser says this origin is using, and what it will allow — a different question from
 * the sum of our own downloads, and both are shown. Null on Safari before 17 and some private modes.
 */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage, quota } = await navigator.storage.estimate();
  if (typeof usage !== 'number' || typeof quota !== 'number') return null;
  return { usage, quota };
}

/**
 * Asks the browser not to evict us under storage pressure. Worth asking once, at the first
 * download. A refusal is not an error — the download still works, it is just evictable.
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
