/**
 * Turn a file somebody chose into the three things the upload needs.
 *
 * All of it happens in the browser, before a byte leaves the machine, and that is the whole
 * design rather than an optimisation. The server has no image decoder — no `sharp`, no native
 * module, nothing that needs a per-platform build in a repository that has no build step — so
 * the downscale, the thumbnail and the BlurHash are computed here, in one pass over an image
 * the canvas has already decoded.
 *
 * What that buys, in order of how much it matters:
 *
 * - **A 4 MB phone photograph becomes ~500 kB before it is sent.** On a trailhead's worth of
 *   signal that is the difference between an upload and an abandoned one.
 * - **EXIF is stripped.** Re-encoding through a canvas drops every tag, so the camera serial,
 *   the owner's name and the coordinates do not reach the bucket. What we *want* from that
 *   metadata is read first, deliberately, and sent as ordinary fields the server can reason
 *   about — see `exif.ts`, and the bounding-box check in `photos.commit` that decides whether
 *   a coordinate is plausible enough to keep.
 * - **HEIC works.** Every iPhone shoots it and no browser but Safari can decode it, so it is
 *   not an accepted upload format. But the phone that took the picture can always decode its
 *   own file, so it re-encodes locally and everyone downstream receives a JPEG.
 *
 * The fallback, when a browser cannot decode the file at all, is to send it untouched if the
 * format is one we accept. Rare, worse in every way, and still better than refusing.
 */
import {
  BLURHASH_SAMPLE_EDGE,
  MAX_PHOTO_BYTES,
  PHOTO_CONTENT_TYPES,
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_EDGE,
  PHOTO_THUMB_EDGE,
  encodeBlurhash,
  formatBytes,
} from '@switchback/core';
import type { PhotoContentType } from '@switchback/core';
import { readExif } from './exif';

export interface PreparedPhoto {
  /** What to send as the full image, and the type both the ticket and the `PUT` must carry. */
  full: Blob;
  contentType: PhotoContentType;
  /** Null only if the canvas would not produce one. The gallery falls back to `full`. */
  thumb: Blob | null;
  width: number;
  height: number;
  blurhash: string | null;
  capturedAt: Date | null;
  lng: number | null;
  lat: number | null;
  /** An object URL for the thumbnail. **The caller owns this and must revoke it.** */
  previewUrl: string;
}

/** Thrown with a message written to be shown to a person, not logged. */
export class PhotoPrepareError extends Error {}

const ACCEPTED = new Set<string>(Object.keys(PHOTO_CONTENT_TYPES));

/** What the file input advertises. HEIC is listed because we convert it, not because we store it. */
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif';

function fitWithin(width: number, height: number, edge: number): { w: number; h: number } {
  const longest = Math.max(width, height);
  if (longest <= edge) return { w: width, h: height };
  const scale = edge / longest;
  // At least one pixel each way — a panorama scaled to a 32 px sample would otherwise round
  // its short edge to zero, and a zero-height canvas throws on `getImageData`.
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

type Source = ImageBitmap | HTMLImageElement;

function draw(source: Source, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new PhotoPrepareError('This browser cannot process images.');

  // JPEG has no alpha, and an unpainted canvas is transparent black — so a PNG with a
  // transparent background would arrive as a photograph on a black card. White is what a
  // person expects a transparent region to look like on a page.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, w, h);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, w, h);
  return canvas;
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/**
 * Encode once, preferring WebP.
 *
 * A browser that cannot encode WebP does not say so — `toBlob` quietly hands back a PNG,
 * which for a photograph is several times larger than the JPEG we would have asked for. So
 * the result's own `type` is the test, not a feature-detect table.
 */
async function encodeBest(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<{ blob: Blob; contentType: PhotoContentType }> {
  const webp = await encode(canvas, 'image/webp', quality);
  if (webp && webp.type === 'image/webp') return { blob: webp, contentType: 'image/webp' };

  const jpeg = await encode(canvas, 'image/jpeg', quality);
  if (jpeg) return { blob: jpeg, contentType: 'image/jpeg' };

  throw new PhotoPrepareError('This browser could not process that image.');
}

/**
 * Decode the file.
 *
 * `createImageBitmap` with `imageOrientation: 'from-image'` is the path that matters: it
 * applies the EXIF orientation tag while decoding, so a photograph taken in portrait is
 * upright on the canvas. Without it, every sideways holiday photograph on the internet
 * happens again — the tag is stripped by the re-encode, and the rotation it described is lost
 * with it. The `<img>` fallback is for browsers without the option, where the element's own
 * decoder honours orientation anyway.
 */
async function decode(file: Blob): Promise<Source> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // Fall through — Safari has historically rejected the options bag rather than ignoring it.
    }
    try {
      return await createImageBitmap(file);
    } catch {
      // Fall through to the element decoder.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new PhotoPrepareError('That file is not an image we can read.'));
      image.src = url;
    });
  } finally {
    // Safe immediately: a loaded `<img>` holds its own decoded copy, and a failed one is
    // never going to need the blob again.
    URL.revokeObjectURL(url);
  }
}

function dimensionsOf(source: Source): { width: number; height: number } {
  return source instanceof HTMLImageElement
    ? { width: source.naturalWidth, height: source.naturalHeight }
    : { width: source.width, height: source.height };
}

/**
 * The last thing sent when the canvas route failed entirely.
 *
 * No dimensions, no hash, no thumbnail, full size — but the photograph reaches the trail
 * page, which is what the person was trying to do.
 */
function untouched(file: File, exif: Awaited<ReturnType<typeof readExif>>): PreparedPhoto {
  if (!ACCEPTED.has(file.type)) {
    throw new PhotoPrepareError('That file is not an image we can read. Try a JPEG or a PNG.');
  }
  return {
    full: file,
    contentType: file.type as PhotoContentType,
    thumb: null,
    width: 0,
    height: 0,
    blurhash: null,
    previewUrl: URL.createObjectURL(file),
    ...exif,
  };
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (file.size === 0) throw new PhotoPrepareError('That file is empty.');
  if (file.size > MAX_PHOTO_BYTES * 4) {
    // Checked before decoding rather than after: a 200 MB file will exhaust the tab's memory
    // on `createImageBitmap` and take the page down with it, and no amount of re-encoding is
    // going to rescue something that far past the limit. Four times the ceiling leaves room
    // for a large raw-ish JPEG that will comfortably clear it once re-encoded.
    throw new PhotoPrepareError(
      `That photograph is ${formatBytes(file.size)}, which is too large to process.`,
    );
  }

  // Before the canvas touches it — re-encoding is what strips the tags we are reading.
  const exif = await readExif(file);

  let source: Source;
  try {
    source = await decode(file);
  } catch {
    return untouched(file, exif);
  }

  try {
    const natural = dimensionsOf(source);
    if (natural.width === 0 || natural.height === 0) return untouched(file, exif);

    const fullSize = fitWithin(natural.width, natural.height, PHOTO_MAX_EDGE);
    const { blob: full, contentType } = await encodeBest(
      draw(source, fullSize.w, fullSize.h),
      PHOTO_JPEG_QUALITY,
    );

    // The thumbnail is always JPEG — it is what the key's `_t.jpg` suffix says it is, and the
    // server signs `image/jpeg` for that object without knowing what the full image became.
    const thumbSize = fitWithin(natural.width, natural.height, PHOTO_THUMB_EDGE);
    const thumb = await encode(draw(source, thumbSize.w, thumbSize.h), 'image/jpeg', 0.78);

    let blurhash: string | null = null;
    try {
      const sample = fitWithin(natural.width, natural.height, BLURHASH_SAMPLE_EDGE);
      const canvas = draw(source, sample.w, sample.h);
      const pixels = canvas.getContext('2d')?.getImageData(0, 0, sample.w, sample.h);
      if (pixels) blurhash = encodeBlurhash(pixels.data, sample.w, sample.h);
    } catch {
      // A placeholder is decoration. Losing it costs a grey rectangle for a few hundred
      // milliseconds; failing the upload over it costs the photograph.
      blurhash = null;
    }

    return {
      full,
      contentType,
      thumb,
      width: fullSize.w,
      height: fullSize.h,
      blurhash,
      previewUrl: URL.createObjectURL(thumb ?? full),
      ...exif,
    };
  } finally {
    if (!(source instanceof HTMLImageElement)) source.close();
  }
}
