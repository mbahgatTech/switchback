import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import superjson from 'superjson';
import type { RouterOutputs } from '@switchback/api';

/**
 * Trails saved onto the phone. A module rather than a hook, like `@/record/store`: the trail
 * screen, the download control and the storage manager all read the same index.
 *
 * Two files per trail plus one small index. `manifest.json` is read synchronously at launch;
 * the payload — thousands of elevation points on a long route — lives in `<trailId>/trail.json`
 * and is read only when that trail is opened.
 *
 * The payload is superjson, not `JSON.stringify`: photos and reports carry real `Date`s over the
 * superjson tRPC link, and plain JSON would hand back strings that break *only* offline. The
 * index stays plain JSON so it stays readable when a payload from an older build is not.
 *
 * Documents, not Caches: iOS empties Caches under storage pressure, and a download made the
 * night before a signal-less hike is exactly the file it would take. The cost is device backup.
 */

/** Bumped when the shape of a stored payload changes. Old copies are dropped, not migrated. */
const PAYLOAD_VERSION = 1;

export type OfflineDetail = RouterOutputs['trails']['bySlug'];
export type OfflinePhotos = RouterOutputs['trails']['photos'];
export type OfflineReviewSummary = RouterOutputs['reviews']['summary'];
export type OfflineReviewPage = RouterOutputs['reviews']['list'];

/** One line of the index: enough to draw a row and open the trail, and nothing more. */
export interface OfflineTrailSummary {
  trailId: string;
  slug: string;
  name: string;
  /**
   * The derived title, or nothing. Optional and un-versioned deliberately: an index written
   * before this field still reads, and dropping every download to gain a title is a bad trade.
   */
  displayName?: string | null;
  regionName: string | null;
  lengthM: number;
  gainM: number;
  /** Frames held on the phone, which is at most `OFFLINE_PHOTO_LIMIT` and often fewer. */
  photos: number;
  /** Epoch milliseconds. A number so the index survives a plain `JSON.parse`. */
  savedAt: number;
  bytes: number;
}

/**
 * Everything one saved trail can answer without a network. No size and no save time: both are
 * measurements *of* this file, so they live in the index, which is written after the payload.
 */
export interface OfflineTrail {
  version: number;
  trailId: string;
  slug: string;
  detail: OfflineDetail;
  photos: OfflinePhotos;
  reviewSummary: OfflineReviewSummary | null;
  reviewPage: OfflineReviewPage | null;
}

export interface OfflineIndex {
  /** False only before the first read of disk, which happens on the first render that asks. */
  ready: boolean;
  /** Newest save first — the order somebody thinks about their downloads in. */
  trails: readonly OfflineTrailSummary[];
  bytes: number;
}

const listeners = new Set<() => void>();

/**
 * One cached object, replaced only when something in it changes. `useSyncExternalStore`
 * compares with `Object.is`, so returning a fresh literal per read would re-render forever.
 */
let index: OfflineIndex = { ready: false, trails: [], bytes: 0 };

function root(): Directory {
  return new Directory(Paths.document, 'offline');
}

function manifestFile(): File {
  return new File(root(), 'manifest.json');
}

/**
 * A trail id is a cuid, so this is belt and braces — but it is the one server string
 * concatenated into a filesystem path, and a `../` would write outside the offline directory.
 */
function safeId(trailId: string): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(trailId)) throw new Error('Bad trail id.');
  return trailId;
}

/** The directory holding one trail's payload and its frames. */
export function trailDirectory(trailId: string): Directory {
  return new Directory(root(), safeId(trailId));
}

export function photosDirectory(trailId: string): Directory {
  return new Directory(trailDirectory(trailId), 'photos');
}

function payloadFile(trailId: string): File {
  return new File(trailDirectory(trailId), 'trail.json');
}

function isSummary(value: unknown): value is OfflineTrailSummary {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<OfflineTrailSummary>;
  return typeof row.trailId === 'string' && typeof row.slug === 'string';
}

function readManifest(): OfflineTrailSummary[] {
  const file = manifestFile();
  if (!file.exists) return [];
  try {
    const parsed: unknown = JSON.parse(file.textSync());
    if (typeof parsed !== 'object' || parsed === null) return [];
    const rows = (parsed as { trails?: unknown }).trails;
    if (!Array.isArray(rows)) return [];
    return rows.filter(isSummary);
  } catch {
    // A truncated index is a save that died mid-write. Everything on disk is still there and
    // reconcilable below; losing the index costs one re-download, not a crash.
    return [];
  }
}

function writeManifest(trails: readonly OfflineTrailSummary[]): void {
  const file = manifestFile();
  if (file.exists) file.delete();
  file.create();
  file.write(JSON.stringify({ version: PAYLOAD_VERSION, trails }));
}

/**
 * Read disk and reconcile the index against it, which is what makes an interrupted save
 * harmless. A download writes its directory first and its index entry last, so a crash between
 * the two leaves an orphan directory — deleted here. An index entry whose payload is gone is
 * dropped for the mirror reason: it would offer a download that cannot open.
 */
function reload(): void {
  let trails: OfflineTrailSummary[] = [];
  try {
    const dir = root();
    if (!dir.exists) dir.create({ intermediates: true, idempotent: true });

    const onDisk = new Set(
      dir.list().flatMap((entry) => (entry instanceof Directory ? [entry.name] : [])),
    );

    trails = readManifest().filter(
      (row) => onDisk.has(row.trailId) && payloadFile(row.trailId).exists,
    );

    const known = new Set(trails.map((row) => row.trailId));
    for (const name of onDisk) {
      if (known.has(name)) continue;
      try {
        new Directory(dir, name).delete();
      } catch {
        // A directory we cannot remove is not a reason to fail hydration.
      }
    }

    trails.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    // No document directory, no downloads. The app works; this feature does not.
    trails = [];
  }

  index = {
    ready: true,
    trails,
    bytes: trails.reduce((sum, row) => sum + row.bytes, 0),
  };
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Hydrated on first read rather than from a bridge at the app root: the work is a directory
 * listing and one small `JSON.parse`, so a launch that never opens a trail never touches disk.
 */
function getIndex(): OfflineIndex {
  if (!index.ready) reload();
  return index;
}

/** Re-read disk. Called after any write, and safe to call at any time. */
export function refreshOfflineIndex(): void {
  reload();
  emit();
}

/** What is saved on this phone. */
export function useOfflineIndex(): OfflineIndex {
  return useSyncExternalStore(subscribe, getIndex, getIndex);
}

/** The index line for one trail, or nothing if it is not saved. */
export function useOfflineSaved(slug: string | null | undefined): OfflineTrailSummary | null {
  const saved = useOfflineIndex();
  return useMemo(
    () => (slug ? (saved.trails.find((row) => row.slug === slug) ?? null) : null),
    [saved, slug],
  );
}

/** What `useOfflineCopy` knows about one trail's stored payload. */
export interface OfflineCopy {
  /** The payload, or null when there is none. */
  trail: OfflineTrail | null;
  /**
   * False only while the read is still in flight. Screens need it to tell "no copy" from "not
   * looked yet" — without it a trail opened out of signal races its own disk read and reports
   * that it cannot be found, on a phone holding all of it.
   */
  settled: boolean;
}

/**
 * The stored payload for one trail, read off disk in the background. Re-reads when `savedAt`
 * moves, which is how an "Update" repaints the screen with what it has just fetched.
 */
export function useOfflineCopy(slug: string | null | undefined): OfflineCopy {
  const saved = useOfflineSaved(slug);
  const trailId = saved?.trailId ?? null;
  const savedAt = saved?.savedAt ?? null;
  const [read, setRead] = useState<{ key: string; trail: OfflineTrail | null } | null>(null);

  useEffect(() => {
    if (trailId === null || savedAt === null) {
      setRead(null);
      return;
    }
    const key = `${trailId}:${savedAt}`;
    let live = true;
    void readTrail(trailId).then((row) => {
      if (live) setRead({ key, trail: row });
    });
    return () => {
      live = false;
    };
  }, [trailId, savedAt]);

  if (trailId === null || savedAt === null) return { trail: null, settled: true };

  // Keyed on the save, so a read belonging to the previous trail — or to the copy this one just
  // replaced — counts as not-yet-read rather than as an answer.
  if (read === null || read.key !== `${trailId}:${savedAt}`) return { trail: null, settled: false };
  return { trail: read.trail?.slug === slug ? read.trail : null, settled: true };
}

/** The payload for one saved trail, or null if it is missing or was written by an old build. */
export async function readTrail(trailId: string): Promise<OfflineTrail | null> {
  try {
    const file = payloadFile(trailId);
    if (!file.exists) return null;
    const row = superjson.parse<OfflineTrail>(await file.text());
    return row.version === PAYLOAD_VERSION ? row : null;
  } catch {
    return null;
  }
}

/**
 * Clear the ground for a save. A download always starts from an empty directory: an update
 * fetching eleven frames where the last fetched twelve would otherwise leave the twelfth
 * behind, charged to the download and referenced by nothing.
 */
export function resetTrailDirectory(trailId: string): Directory {
  const dir = trailDirectory(trailId);
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true, idempotent: true });
  photosDirectory(trailId).create({ intermediates: true, idempotent: true });
  return dir;
}

/** Write the payload. The index is not touched — see `recordTrail`. */
export function writePayload(row: OfflineTrail): void {
  const file = payloadFile(row.trailId);
  if (file.exists) file.delete();
  file.create();
  file.write(superjson.stringify(row));
}

/** Total bytes under a directory, counted rather than estimated. */
export function directoryBytes(dir: Directory): number {
  if (!dir.exists) return 0;
  let total = 0;
  for (const entry of dir.list()) {
    total += entry instanceof Directory ? directoryBytes(entry) : entry.size;
  }
  return total;
}

/**
 * Put a trail in the index, replacing any earlier entry. Written last on purpose: until it
 * returns the download does not exist to any screen, and a crash before it leaves an orphan
 * hydration cleans up.
 */
export function recordTrail(summary: OfflineTrailSummary): void {
  const trails = [summary, ...getIndex().trails.filter((row) => row.trailId !== summary.trailId)];
  trails.sort((a, b) => b.savedAt - a.savedAt);
  writeManifest(trails);
  refreshOfflineIndex();
}

/** Remove one trail from the phone: its frames, its payload and its index entry. */
export function forgetTrail(trailId: string): void {
  const dir = trailDirectory(trailId);
  if (dir.exists) dir.delete();
  writeManifest(getIndex().trails.filter((row) => row.trailId !== trailId));
  refreshOfflineIndex();
}

/** Remove every download. The storage manager's one destructive control. */
export function forgetEverything(): void {
  const dir = root();
  if (dir.exists) dir.delete();
  dir.create({ intermediates: true, idempotent: true });
  writeManifest([]);
  refreshOfflineIndex();
}

/** Free space on the device, or null where it cannot be read. Shown beside the total. */
export function availableBytes(): number | null {
  try {
    const free = Paths.availableDiskSpace;
    return Number.isFinite(free) && free > 0 ? free : null;
  } catch {
    return null;
  }
}
