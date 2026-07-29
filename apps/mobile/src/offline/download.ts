import { useMemo, useSyncExternalStore } from 'react';
import { File } from 'expo-file-system';
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
 * The website does this by caching its own server-rendered page plus a corridor of map
 * tiles, and none of that ports. The map on this phone is MapLibre GL JS inside a web view,
 * and under Expo Go there is no way to put ourselves between that web view and its tile
 * requests — so a download cannot include the basemap, and the control that starts one says
 * so in as many words rather than letting somebody find out on a col.
 *
 * What it can include is everything the trail screen draws from data: the line, the
 * elevation pass, the waypoints, the description, the access facts, the reports, and the
 * frames — fetched with the same procedures and the same arguments the screen uses, so that
 * `@/offline/hydrate` can put them back under exactly the keys the screen looks in.
 *
 * **Frames are downloaded at both sizes.** The strip reads `thumbUrl` and the viewer reads
 * `url`, and a download that saved only one of them would give somebody a gallery that
 * opens into nothing. Both fields are rewritten to `file://` paths before the payload is
 * written, which is what makes the components work offline without knowing they are.
 */

/**
 * Frames per download.
 *
 * Twelve rather than the gallery's twenty-four. A full frame is a 2,560 px edge and runs to
 * a megabyte or so; the difference between twelve and twenty-four is a dozen megabytes for
 * pictures nobody scrolls to on a phone, and storage is the resource this feature spends.
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
 *
 * Throws only when the trail itself cannot be fetched. Reports and frames are best effort:
 * a trail saved without its photos is a trail somebody can still hike, and failing the
 * whole download over one 404 on a picture would be the wrong trade on a station platform.
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
   * Everything above this line is network; everything below is disk. The directory is
   * cleared here rather than at the top so that a download which never reaches the server —
   * airplane mode, a dead trailhead — leaves whatever was already saved untouched. Somebody
   * tapping "Update" out of signal range keeps the copy they had.
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
    const [full, thumb] = await Promise.all([
      pull(photo.url, trailId, `${i}-full`),
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
      // The thumb standing in for a full frame that would not come is a soft picture
      // instead of a blank one — the same fallback the website's downloader makes.
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
 * One frame onto the phone, or nothing.
 *
 * `downloadFileAsync` moves the file into place only after the transfer completes, so a
 * failure here leaves no half-written picture behind — which is what lets the caller treat
 * a missing frame as a missing frame rather than as a corrupt download.
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

/**
 * The extension the URL claims, or a neutral one.
 *
 * Cosmetic — iOS reads an image by its bytes, not its name — but a downloads directory that
 * can be read in a file browser is worth the six lines.
 */
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
 * Run a fetch whose failure is not worth losing the download over.
 *
 * A stopped download reaches here as an abort rather than as `DownloadCancelled`, and is
 * swallowed like any other failure — the `stop()` on the line after the fetches is what
 * actually ends the run, before anything is written. The explicit check is for the case
 * where our own cancellation is already in flight.
 */
async function optional<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    if (cause instanceof DownloadCancelled) throw cause;
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Downloads in flight                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Which saves are running, held in the module rather than in the screen that started one.
 *
 * A download that lived in component state would be a download that dies when somebody
 * backs out of the trail to check something — and worse, one that could be started twice,
 * because a remounted control has no memory of the save already writing into that
 * directory. Two `downloadTrail` calls for one trail would clear the ground under each
 * other. Keeping the controllers here makes a second press a no-op, which is the correct
 * behaviour and also the one people expect from a button that already says "Saving…".
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
