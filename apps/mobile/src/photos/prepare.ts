/**
 * Turn a photograph somebody picked into the three things the upload needs.
 *
 * The web's counterpart (`apps/web/src/lib/photo-prepare.ts`) does this with a canvas. There
 * is no canvas here, so the work goes to `expo-image-manipulator`, which hands the decode and
 * the resample to the platform's own image pipeline on a background thread. The shape of the
 * result is deliberately the same on both clients, because `photos.presign` and
 * `photos.commit` cannot tell them apart and should not have to.
 *
 * Three things the phone gets that the browser does not:
 *
 * - **HEIC stops being a problem.** Every iPhone shoots it; no browser but Safari decodes it.
 *   Core Graphics decodes it natively, and everything leaves here as JPEG, so the format
 *   never reaches a device that cannot read it and `contentType` is a constant.
 * - **EXIF is already parsed.** `expo-image-picker` flattens the `{Exif}` and `{GPS}`
 *   dictionaries Core Graphics produced into one object with decimal-degree coordinates, so
 *   there is no byte-hiking to do — only the judgement about what is believable, which is
 *   shared with the browser in `@switchback/core` so the two cannot drift.
 * - **The bytes never pass through JavaScript.** Both renditions stay on disk as files and
 *   are streamed by the native uploader. A 4 MB `Blob` in a Hermes heap on a three-year-old
 *   phone is how a picker crashes on the sixth photograph.
 *
 * The re-encode strips the metadata on its way out, exactly as the canvas does — so the
 * camera serial, the owner's name and the coordinates do not reach the bucket. What we want
 * from that metadata is read first, deliberately, and sent as ordinary fields the server can
 * reason about. `photos.commit` then keeps a coordinate only if it falls on the trail.
 */
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { ImageRef } from 'expo-image-manipulator';
import type { ImagePickerAsset } from 'expo-image-picker';
import {
  MAX_PHOTO_BYTES,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_EDGE,
  PHOTO_THUMB_EDGE,
  exifCoordinate,
  formatBytes,
  parseExifDateTime,
} from '@switchback/core';
import type { PhotoContentType } from '@switchback/core';

export interface PreparedPhoto {
  /** The full image, on disk. Streamed straight to the store by the native uploader. */
  full: File;
  /** Always JPEG. The manipulator saves what we ask for, and we always ask for one thing. */
  contentType: PhotoContentType;
  /** Null only if the thumbnail pass failed. The gallery falls back to `full`. */
  thumb: File | null;
  width: number;
  height: number;
  /**
   * Always null on the phone, for now.
   *
   * BlurHash needs raw RGBA, and nothing in Expo Go will hand over a decoded pixel buffer —
   * `ImageRef` is a native handle, not an array. The gallery's placeholder is the average
   * colour of a hash, so its absence costs a plain grey rectangle for the few hundred
   * milliseconds before the thumbnail paints. Not worth a development build.
   */
  blurhash: null;
  capturedAt: Date | null;
  lng: number | null;
  lat: number | null;
  /** What to show in the queue while it uploads. A local file URI — nothing to revoke. */
  previewUri: string;
}

/** Thrown with a message written to be shown to a person, not logged. */
export class PhotoPrepareError extends Error {}

/** Quality for the thumbnail. Lower than the full image; it is rendered at a sixth the size. */
const THUMB_QUALITY = 0.78;

/**
 * The two facts worth reading, out of the dictionary the picker handed us.
 *
 * iOS flattens the EXIF block before it crosses the bridge: the `{Exif}` dictionary becomes
 * the root object, `{TIFF}` is merged into it, and every `{GPS}` key is copied across with a
 * `GPS` prefix. Core Graphics has already turned the DMS rationals into a decimal degree, so
 * unlike the browser there is nothing to hike — the whole job here is pulling four values out
 * of an untyped bag and checking they are the type they should be.
 *
 * Everything downstream of the read — what counts as a believable date, which way is south,
 * what counts as a real fix — is `@switchback/core`'s, shared with the browser's byte-hiker
 * so the two clients cannot drift apart about the same photograph.
 */
export function readExifFacts(exif: Record<string, unknown> | null | undefined): {
  capturedAt: Date | null;
  lat: number | null;
  lng: number | null;
} {
  const nothing = { capturedAt: null, lat: null, lng: null };
  if (!exif) return nothing;

  const capturedAt = parseExifDateTime(
    text(exif.DateTimeOriginal) ?? text(exif.DateTime),
    text(exif.OffsetTimeOriginal) ?? text(exif.OffsetTime),
  );

  const fix = exifCoordinate(
    number(exif.GPSLatitude),
    text(exif.GPSLatitudeRef),
    number(exif.GPSLongitude),
    text(exif.GPSLongitudeRef),
  );

  return { capturedAt, lat: fix?.lat ?? null, lng: fix?.lng ?? null };
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The longer edge, or nothing.
 *
 * `resize` derives the missing axis from the ratio, so passing one number is both shorter and
 * safer than computing both and rounding them apart. Null means the image is already inside
 * the limit and re-sampling it would only cost quality.
 */
function resizeTo(
  width: number,
  height: number,
  edge: number,
): { width: number } | { height: number } | null {
  if (Math.max(width, height) <= edge) return null;
  return width >= height ? { width: edge } : { height: edge };
}

/**
 * Prepare one picked asset.
 *
 * Rendered twice, not decoded twice. The first render exists to learn the natural size —
 * `ImagePickerAsset.width` and `.height` are documented as possibly zero, and a resize
 * decision made on a zero is a resize to nothing. The thumbnail is then derived from the
 * already-downscaled full image rather than from the original, which is both faster and
 * exactly what the browser does when it draws both from one decoded bitmap.
 */
export async function preparePhoto(asset: ImagePickerAsset): Promise<PreparedPhoto> {
  // `exif` is `Record<string, any>`; the parameter is `Record<string, unknown>`. That widening
  // is the one assignment the unsafe-assignment rule allows, and it is the right one here.
  const facts = readExifFacts(asset.exif);

  const source = await ImageManipulator.manipulate(asset.uri)
    .renderAsync()
    .catch(() => {
      throw new PhotoPrepareError('That photograph could not be read.');
    });

  try {
    const { width: naturalW, height: naturalH } = source;
    if (naturalW < 1 || naturalH < 1) {
      throw new PhotoPrepareError('That photograph could not be read.');
    }

    const fullSize = resizeTo(naturalW, naturalH, PHOTO_MAX_EDGE);
    const fullRef = fullSize
      ? await ImageManipulator.manipulate(source).resize(fullSize).renderAsync()
      : source;

    try {
      const full = await fullRef.saveAsync({
        compress: PHOTO_JPEG_QUALITY,
        format: SaveFormat.JPEG,
      });
      const fullFile = new File(full.uri);

      // Checked here rather than left to `presign`, so the refusal names a file the person
      // still has in mind instead of arriving as an HTTP status a minute later. A JPEG at
      // 2560 px is 400–900 kB, so anything near the ceiling means something went wrong
      // upstream of the compressor.
      const bytes = fullFile.size;
      if (bytes !== null && bytes > MAX_PHOTO_BYTES) {
        fullFile.delete();
        throw new PhotoPrepareError(
          `That photograph is ${formatBytes(bytes)}. The limit is ${formatBytes(MAX_PHOTO_BYTES)}.`,
        );
      }

      const thumbFile = await renderThumb(fullRef);

      return {
        full: fullFile,
        contentType: 'image/jpeg',
        thumb: thumbFile,
        width: full.width,
        height: full.height,
        blurhash: null,
        previewUri: (thumbFile ?? fullFile).uri,
        ...facts,
      };
    } finally {
      // Only when we made it. `fullRef === source` when the image was already small enough,
      // and releasing it here would pull the handle out from under the `finally` below.
      if (fullRef !== source) fullRef.release();
    }
  } finally {
    source.release();
  }
}

/**
 * The thumbnail, or nothing at all.
 *
 * Always JPEG, because the key ends `_t.jpg` and the server signs `image/jpeg` for that object
 * without knowing what the full image became. Failure here is swallowed on purpose: a missing
 * thumbnail costs a larger image in the gallery strip, and throwing over one costs the
 * photograph.
 */
async function renderThumb(full: ImageRef): Promise<File | null> {
  try {
    const size = resizeTo(full.width, full.height, PHOTO_THUMB_EDGE);
    const ref = size ? await ImageManipulator.manipulate(full).resize(size).renderAsync() : full;
    try {
      const saved = await ref.saveAsync({ compress: THUMB_QUALITY, format: SaveFormat.JPEG });
      return new File(saved.uri);
    } finally {
      if (ref !== full) ref.release();
    }
  } catch {
    return null;
  }
}

/**
 * Drop the temporary files.
 *
 * Both renditions live in the cache directory, so the system will reclaim them eventually —
 * but "eventually" on a phone with 200 photographs uploaded over a season is a few hundred
 * megabytes of duplicates sitting in the way of an offline map. Called once an upload has
 * either landed or failed for good.
 */
export function discard(prepared: PreparedPhoto): void {
  for (const file of [prepared.full, prepared.thumb]) {
    try {
      if (file?.exists) file.delete();
    } catch {
      // A file the system already reclaimed is the outcome we wanted.
    }
  }
}
