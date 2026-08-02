/**
 * The ledger of what has been downloaded: which download owns which URLs, and what it cost. Cache
 * Storage holds the bytes; the database itself is declared in `idb.ts`, which the queue shares.
 */

import type { TrailDetail } from '@switchback/core';
import { TRAILS_STORE, run } from './idb';

export interface OfflineTrail {
  trailId: string;
  slug: string;
  name: string;
  /**
   * The derived title, denormalised beside `name` like everything else on this row. Optional
   * rather than nullable because a download taken before the column existed simply has no such
   * key — `trailTitle` reads both cases as "show the OSM name".
   */
  displayName?: string | null;
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
   * The full trail payload. Redundant with the cached HTML, deliberately: the page is built by one
   * deployment and references its hashed assets, whereas this is JSON any future build can render.
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
 * Every URL still spoken for by a download other than the ones named — the input to eviction.
 * Anything cached and not in this set is unreferenced and can go.
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
