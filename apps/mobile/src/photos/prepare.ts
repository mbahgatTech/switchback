/**
 * Turn a picked photograph into the three things the upload needs. Same result shape as the
 * web's canvas version (`apps/web/src/lib/photo-prepare.ts`), because `photos.presign` and
 * `photos.commit` cannot tell the two clients apart.
 *
 * Everything leaves here as JPEG, which is what makes HEIC a non-problem and `contentType` a
 * constant. EXIF arrives already parsed by `expo-image-picker`, in decimal degrees. The bytes
 * never pass through JavaScript — both renditions stay on disk and are streamed natively, since
 * a 4 MB `Blob` in a Hermes heap is how a picker crashes on the sixth photograph.
 *
 * The re-encode strips metadata on its way out, so the camera serial, the owner's name and the
 * coordinates do not reach the bucket; what we want is read first and sent as ordinary fields.
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
   * Always null on the phone: BlurHash needs raw RGBA and nothing in Expo Go hands over a
   * decoded pixel buffer. Costs a plain grey rectangle until the thumbnail paints.
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
 * The two facts worth reading out of the dictionary the picker handed us. iOS flattens the EXIF
 * block before it crosses the bridge — `{TIFF}` merged in, `{GPS}` keys copied with a `GPS`
 * prefix and already decimal — so this is only pulling four values out of an untyped bag.
 *
 * What counts as a believable date or a real fix is `@switchback/core`'s, shared with the
 * browser's byte-walker so the two clients cannot disagree about the same photograph.
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
 * The longer edge, or nothing. `resize` derives the missing axis from the ratio; null means the
 * image is already inside the limit and re-sampling would only cost quality.
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
 * Prepare one picked asset. Rendered twice, not decoded twice: the first render exists to learn
 * the natural size, since `ImagePickerAsset.width`/`.height` are documented as possibly zero and
 * a resize decision made on a zero is a resize to nothing. The thumbnail comes from the
 * already-downscaled full image.
 */
export async function preparePhoto(asset: ImagePickerAsset): Promise<PreparedPhoto> {
  // `exif` is `Record<string, any>` widening to `Record<string, unknown>` — the one assignment
  // the unsafe-assignment rule allows.
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
      // still has in mind. A JPEG at 2560 px is 400–900 kB; anything near the ceiling means
      // something went wrong upstream of the compressor.
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
      // Only when we made it: `fullRef === source` when the image was already small enough, and
      // releasing it here would pull the handle out from under the `finally` below.
      if (fullRef !== source) fullRef.release();
    }
  } finally {
    source.release();
  }
}

/**
 * The thumbnail, or nothing at all. Always JPEG, because the key ends `_t.jpg` and the server
 * signs `image/jpeg` for that object. Failure is swallowed: a missing thumbnail costs a larger
 * image in the strip, and throwing over one costs the photograph.
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
 * Drop the temporary files. Both renditions live in the cache directory, which the system
 * reclaims eventually — but "eventually" over a season of uploads is hundreds of megabytes in
 * the way of an offline map. Called once an upload has landed or failed for good.
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
