import { useMemo, useSyncExternalStore } from 'react';
import { File } from 'expo-file-system';
import { displayNameOf } from '@switchback/core';
import { GALLERY_LIMIT, REVIEW_PAGE_SIZE } from '@/api/pages';
import type { useTRPCClient } from '@/api/trpc';
import {
  type OfflinePhotos,
  type OfflineReviewPage,
  type OfflineReviewSummary,
  type OfflineTrail,
  type OfflineTrailSummary,
  directoryBytes,
  photosDirectory,
  recordTrail,
  resetTrailDirectory,
  trailDirectory,
  writePayload,
} from '@/offline/store';

/**
 * Saving one trail onto the phone.
 *
 * **A download cannot include the basemap.** The map is MapLibre inside a web view, and under
 * Expo Go there is no way to get between that web view and its tile requests — the control that
 * starts a download says so.
 *
 * What it does include is everything the trail screen draws from data, fetched with the same
 * procedures and arguments the screen uses so `@/offline/hydrate` can put them back under
 * exactly the keys it looks in. Frames are saved at both sizes — the strip reads `thumbUrl`,
 * the viewer reads `url` — and both fields are rewritten to `file://` before the payload lands.
 */

/**
 * Frames per download: twelve rather than the gallery's twenty-four. A full frame is a 2,560 px
 * edge and about a megabyte, and storage is the resource this feature spends.
 */
export const OFFLINE_PHOTO_LIMIT = 12;

/** How many frames are pulled at once. Three keeps a slow link busy without swamping it. */
const PHOTO_CONCURRENCY = 3;

export type DownloadPhase = 'data' | 'photos' | 'saving';

export interface DownloadProgress {
  phase: DownloadPhase;
  /** Frames finished, during `photos`. Zero in the other phases. */
  done: number;
  total: number;
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

/** Thrown when the hiker stops a download. Callers show nothing rather than an error. */
export class DownloadCancelled extends Error {
  constructor() {
    super('Download stopped.');
    this.name = 'DownloadCancelled';
  }
}

type Client = ReturnType<typeof useTRPCClient>;

/**
 * Fetch a trail and everything around it, write it to the phone, and return its index line.
 * Throws only when the trail itself cannot be fetched; reports and frames are best effort.
 */
export async function downloadTrail(
  client: Client,
  slug: string,
  options: DownloadOptions = {},
): Promise<OfflineTrailSummary> {
  const { onProgress, signal } = options;
  const stop = (): void => {
    if (signal?.aborted) throw new DownloadCancelled();
  };

  stop();
  onProgress?.({ phase: 'data', done: 0, total: 0 });

  const detail = await client.trails.bySlug.query({ slug }, { signal });
  const trailId = detail.id;
  stop();

  const [photos, reviewSummary, reviewPage] = await Promise.all([
    optional<OfflinePhotos>(
      () => client.trails.photos.query({ trailId, limit: GALLERY_LIMIT }, { signal }),
      [],
    ),
    optional<OfflineReviewSummary | null>(
      () => client.reviews.summary.query({ trailId }, { signal }),
      null,
    ),
    optional<OfflineReviewPage | null>(
      () =>
        client.reviews.list.query({ trailId, sort: 'recent', limit: REVIEW_PAGE_SIZE }, { signal }),
      null,
    ),
  ]);
  stop();

  /*
   * Everything above this line is network; everything below is disk. The directory is cleared
   * here rather than at the top so a download that never reaches the server leaves whatever was
   * already saved untouched — "Update" out of signal keeps the copy you had.
   */
  resetTrailDirectory(trailId);

  const wanted = photos.slice(0, OFFLINE_PHOTO_LIMIT);
  onProgress?.({ phase: 'photos', done: 0, total: wanted.length });

  const local = new Array<{ url: string | null; thumbUrl: string | null }>(wanted.length);
  let done = 0;

  await pool(wanted.length, PHOTO_CONCURRENCY, async (i) => {
    const photo = wanted[i];
    if (!photo) return;
    stop();
    // A photograph a moderator took down comes back with no URL, so nothing is stored — a
    // bundle carried down a valley must not become the last place a removed image survives.
    const [full, thumb] = await Promise.all([
      photo.url ? pull(photo.url, trailId, `${i}-full`) : Promise.resolve(null),
      photo.thumbUrl ? pull(photo.thumbUrl, trailId, `${i}-thumb`) : Promise.resolve(null),
    ]);
    local[i] = { url: full, thumbUrl: thumb };
    done += 1;
    onProgress?.({ phase: 'photos', done, total: wanted.length });
  });
  stop();

  const stored: OfflinePhotos = wanted.map((photo, i) => {
    const saved = local[i];
    return {
      ...photo,
      // The thumb standing in for a full frame that would not come is a soft picture rather
      // than a blank one — the same fallback the website's downloader makes.
      url: saved?.url ?? saved?.thumbUrl ?? photo.url,
      thumbUrl: saved?.thumbUrl ?? saved?.url ?? photo.thumbUrl,
    };
  });

  onProgress?.({ phase: 'saving', done: wanted.length, total: wanted.length });

  const payload: OfflineTrail = {
    version: 1,
    trailId,
    slug: detail.slug,
    detail,
    photos: stored,
    reviewSummary,
    reviewPage,
  };
  writePayload(payload);

  const summary: OfflineTrailSummary = {
    trailId,
    slug: detail.slug,
    name: detail.name,
    // Both, not one resolved title: the index stays a record of what the server said, and the
    // downloads screen falls back through `trailTitle` exactly as every other screen does.
    displayName: displayNameOf(detail),
    regionName: detail.regionName ?? null,
    lengthM: detail.stats.lengthM,
    gainM: detail.stats.gainM,
    photos: stored.length,
    savedAt: Date.now(),
    bytes: directoryBytes(trailDirectory(trailId)),
  };
  recordTrail(summary);
  return summary;
}

/**
 * One frame onto the phone, or nothing. `downloadFileAsync` moves the file into place only
 * after the transfer completes, so a failure leaves no half-written picture behind.
 */
async function pull(url: string, trailId: string, name: string): Promise<string | null> {
  try {
    const target = new File(photosDirectory(trailId), `${name}${extensionFor(url)}`);
    const saved = await File.downloadFileAsync(url, target, { idempotent: true });
    return saved.uri;
  } catch {
    return null;
  }
}

/** The extension the URL claims, or a neutral one. Cosmetic — iOS reads an image by its bytes. */
function extensionFor(url: string): string {
  const match = /\.(jpe?g|png|webp|heic|avif)(?:$|[?#])/i.exec(url);
  const found = match?.[1];
  return found ? `.${found.toLowerCase()}` : '.img';
}

/** Run `worker` over indices `0..count-1`, at most `limit` at a time, in order of demand. */
async function pool(
  count: number,
  limit: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, count) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= count) return;
      await worker(i);
    }
  });
  await Promise.all(runners);
}

/**
 * Run a fetch whose failure is not worth losing the download over. A stopped download arrives
 * here as an abort and is swallowed like any other failure — the `stop()` after the fetches is
 * what actually ends the run, before anything is written.
 */
async function optional<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof DownloadCancelled) throw cause;
    return fallback;
  }
}

/**
 * Which saves are running, held in the module rather than in the screen that started one: a
 * download in component state dies when somebody backs out of the trail, and a remounted
 * control could start a second `downloadTrail` that clears the ground under the first.
 */
export interface DownloadState {
  /** Slug → how far along, for every save currently running. */
  running: ReadonlyMap<string, DownloadProgress>;
  /** Slug → what stopped it. Cleared when that trail is tried again. */
  failed: ReadonlyMap<string, string>;
}

const listeners = new Set<() => void>();
const running = new Map<string, DownloadProgress>();
const failed = new Map<string, string>();
const controllers = new Map<string, AbortController>();

/** Replaced only when something changes; `useSyncExternalStore` compares with `Object.is`. */
let snapshot: DownloadState = { running: new Map(), failed: new Map() };

function emit(): void {
  snapshot = { running: new Map(running), failed: new Map(failed) };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): DownloadState {
  return snapshot;
}

/** Every save in flight. The storage manager uses this; a trail screen wants `useDownload`. */
export function useDownloads(): DownloadState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** How one trail's save is going, if it is going at all. */
export function useDownload(slug: string): {
  progress: DownloadProgress | null;
  error: string | null;
} {
  const state = useDownloads();
  return useMemo(
    () => ({
      progress: state.running.get(slug) ?? null,
      error: state.failed.get(slug) ?? null,
    }),
    [state, slug],
  );
}

/** Start saving a trail. A second call while the first is running does nothing. */
export function startDownload(client: Client, slug: string): void {
  if (controllers.has(slug)) return;

  const controller = new AbortController();
  controllers.set(slug, controller);
  failed.delete(slug);
  running.set(slug, { phase: 'data', done: 0, total: 0 });
  emit();

  // Every callback checks that it is still the current run before touching shared state: a
  // stopped download whose last frame lands late must not write over its replacement.
  const current = (): boolean => controllers.get(slug) === controller;

  void downloadTrail(client, slug, {
    signal: controller.signal,
    onProgress: (next) => {
      if (!current()) return;
      running.set(slug, next);
      emit();
    },
  })
    .catch((cause: unknown) => {
      if (!current() || controller.signal.aborted) return;
      failed.set(slug, cause instanceof Error ? cause.message : 'Could not save this trail.');
    })
    .finally(() => {
      if (!current()) return;
      controllers.delete(slug);
      running.delete(slug);
      emit();
    });
}

/** Stop a save. What has already been written is cleaned up on the next launch. */
export function stopDownload(slug: string): void {
  controllers.get(slug)?.abort();
}

/** Clear a failure the reader has seen. */
export function dismissDownloadError(slug: string): void {
  if (!failed.delete(slug)) return;
  emit();
}
