/**
 * The record of what has been downloaded.
 *
 * Cache Storage holds the bytes — tiles, pages, photographs — and this holds the ledger:
 * which download owns which URLs, when it was taken, and how big it turned out to be. The
 * split matters because tile corridors overlap. Two trails in the same valley share most of
 * their tiles, and deleting one download must not blank the other's map, so eviction is a
 * set difference against everything still held rather than a straight delete of a list.
 *
 * IndexedDB rather than `localStorage` because the detail payload for a long trail is
 * hundreds of kilobytes of coordinates, and because `localStorage` is synchronous — every
 * read of it blocks the frame that is trying to draw a map.
 *
 * The database itself — its name, its version, and the stores in it — is declared in `idb.ts`,
 * because the queue of unsent reports shares it. This file owns only what a download row is.
 */

import type { TrailDetail } from '@switchback/core';
import { TRAILS_STORE, run } from './idb';

export interface OfflineTrail {
  trailId: string;
  slug: string;
  name: string;
  regionName: string | null;
  lengthM: number;
  gainM: number;
  /** Epoch milliseconds. Stored as a number so the row survives a structured clone anywhere. */
  downloadedAt: number;
  /** Deepest zoom the corridor actually reached. Below the requested depth means it was capped. */
  coveredMaxZoom: number;
  /** True when the cap dropped a zoom level. Surfaced as "sharp to z13" rather than hidden. */
  truncated: boolean;
  /** Measured, not estimated — the sum of every response body actually stored. */
  bytes: number;
  tileUrls: string[];
  pageUrls: string[];
  mediaUrls: string[];
  /**
   * The full trail payload.
   *
   * Redundant with the cached HTML page, deliberately. The page is what a reader sees, and
   * it is one `Cache.match` away from being served — but it is also HTML built by a
   * particular deployment, and a redeploy invalidates every hashed asset it references. This
   * is the durable copy: plain JSON that any future build can render.
   */
  detail: TrailDetail;
}

export function listOfflineTrails(): Promise<OfflineTrail[]> {
  return run<OfflineTrail[]>(
    TRAILS_STORE,
    'readonly',
    (store) => store.getAll() as IDBRequest<OfflineTrail[]>,
  ).then((rows) => rows.sort((a, b) => b.downloadedAt - a.downloadedAt));
}

export function getOfflineTrail(trailId: string): Promise<OfflineTrail | null> {
  return run<OfflineTrail | undefined>(
    TRAILS_STORE,
    'readonly',
    (store) => store.get(trailId) as IDBRequest<OfflineTrail | undefined>,
  ).then((row) => row ?? null);
}

export function putOfflineTrail(row: OfflineTrail): Promise<void> {
  return run(TRAILS_STORE, 'readwrite', (store) => store.put(row)).then(() => undefined);
}

export function deleteOfflineTrail(trailId: string): Promise<void> {
  return run(TRAILS_STORE, 'readwrite', (store) => store.delete(trailId)).then(() => undefined);
}

/**
 * Every URL still spoken for by a download other than the ones named.
 *
 * The input to eviction. Anything cached and *not* in this set is unreferenced and can go;
 * anything in it is load-bearing for a trail somebody still has.
 */
export async function referencedUrls(exceptTrailIds: readonly string[]): Promise<Set<string>> {
  const excluded = new Set(exceptTrailIds);
  const rows = await listOfflineTrails();
  const urls = new Set<string>();
  for (const row of rows) {
    if (excluded.has(row.trailId)) continue;
    for (const url of row.tileUrls) urls.add(url);
    for (const url of row.pageUrls) urls.add(url);
    for (const url of row.mediaUrls) urls.add(url);
  }
  return urls;
}
