/**
 * Photographs: the limits, the vocabulary, and the shapes both ends agree on.
 *
 * Upload is a three-party handshake — browser, our API, and the object store — and the three
 * of them have to agree on the same numbers or the failure lands in the worst possible place:
 * after the bytes have been sent. A client that downscales to a longer edge than the server
 * will accept produces a 12 MB upload that succeeds against R2 and is then rejected at commit,
 * having spent the user's mobile data to do it. So the limits live here, in the one package
 * both sides import, rather than as a constant on each side that agrees today.
 */
import { z } from 'zod';

/**
 * What we accept, and the extension each becomes in the key.
 *
 * The extension is not cosmetic — the object store serves `Content-Type` from what we sign,
 * but browsers, CDNs and `curl -O` all read the suffix, and a `.bin` full of JPEG is the kind
 * of thing that works everywhere until it doesn't.
 *
 * HEIC is deliberately absent. Every iPhone shoots it, and no browser except Safari can
 * decode it, so accepting the format would mean storing photographs that most of our users
 * cannot see. The uploader converts on the way out instead — `canvas` can read whatever the
 * *taking* device can, so an iPhone re-encodes its own HEIC to JPEG locally and everyone
 * downstream gets a format they can render.
 */
export const PHOTO_CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
} as const;

export type PhotoContentType = keyof typeof PHOTO_CONTENT_TYPES;

export const photoContentTypeSchema = z.enum(
  Object.keys(PHOTO_CONTENT_TYPES) as [PhotoContentType, ...PhotoContentType[]],
);

/**
 * 12 MB for the full image, 512 kB for the thumbnail.
 *
 * Generous rather than tight, because the number that actually controls the upload is
 * `PHOTO_MAX_EDGE` below: a 2560 px JPEG at quality 0.82 is 400–900 kB, and anything
 * approaching 12 MB means the client's re-encode did not happen — a browser that could not
 * decode the source and fell back to sending it untouched. That fallback is worth keeping,
 * so the ceiling has to clear a modern phone's raw output rather than a re-encoded one.
 */
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_THUMB_BYTES = 512 * 1024;

/** Longest edge of the stored image. Enough for a full-bleed hero on a 2× laptop display. */
export const PHOTO_MAX_EDGE = 2560;
/** Longest edge of the thumbnail — the gallery strip and every card read this one. */
export const PHOTO_THUMB_EDGE = 480;
/**
 * Longest edge of the buffer the BlurHash is computed from.
 *
 * The hash holds 4×3 cosine terms, so it cannot represent anything finer than a quarter of
 * the frame. Sampling above ~32 px spends real time on the main thread computing detail the
 * format then discards.
 */
export const BLURHASH_SAMPLE_EDGE = 32;

/** JPEG quality for the re-encode. 0.82 is the knee — above it, size climbs faster than looks. */
export const PHOTO_JPEG_QUALITY = 0.82;

/**
 * Per-user ceilings.
 *
 * Not a monetisation lever — a spam bound. Twelve photographs of one trail is more than
 * anybody needs to show what it looks like, and a hundred in a day is not a hiker. Both are
 * counted at commit, where the row is written, rather than at presign: a presigned URL that
 * is never used should not count against anybody.
 */
export const MAX_PHOTOS_PER_TRAIL_PER_USER = 12;
export const MAX_PHOTOS_PER_DAY = 100;

export const MAX_CAPTION_LENGTH = 280;

/** How long a presigned upload URL is good for. Long enough for a slow phone on a bad signal. */
export const UPLOAD_TICKET_TTL_S = 15 * 60;

/**
 * One presigned request, ready to be replayed verbatim.
 *
 * `headers` is not advisory. The signature covers `content-type`, so sending a different one
 * — or letting `fetch` infer it from the blob — produces a `SignatureDoesNotMatch` from the
 * object store rather than a helpful error. Signing it is the point: without it, a leaked
 * ticket could put `text/html` in a bucket we serve from, which is a stored-XSS hole with a
 * CDN in front of it.
 *
 * `url` may be absolute (the object store) or root-relative (the local development driver,
 * which routes uploads back through our own API because there is no bucket). Resolve it with
 * `new URL(ticket.url, apiOrigin)` and both cases work — an absolute URL ignores the base.
 */
export interface UploadTicket {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  maxBytes: number;
}

/** What `photos.presign` hands back: where to put both renditions, and proof it said so. */
export interface UploadGrant {
  /**
   * Opaque, signed, short-lived. Carries the keys and the caller's id, so `commit` can trust
   * the destination without a pending-uploads table — the same trick the mobile auth handshake
   * uses. A client cannot point a commit at somebody else's object by editing a field.
   */
  token: string;
  full: UploadTicket;
  thumb: UploadTicket;
  expiresAt: Date;
}

/**
 * Dimensions and hash, measured by the client while it had the decoded image in hand.
 *
 * Self-reported, and that is fine. The server has no image decoder — deliberately, see
 * `blurhash.ts` — so these cannot be verified, and the damage a liar can do is bounded at
 * "their own photograph renders with the wrong aspect ratio". The values are used for layout
 * and placeholders, never for access control or billing.
 */
export const photoMeasurementSchema = z.object({
  width: z.number().int().min(1).max(30_000),
  height: z.number().int().min(1).max(30_000),
  blurhash: z.string().min(6).max(200).nullable().default(null),
});

export const photoCommitSchema = photoMeasurementSchema.extend({
  token: z.string().min(1),
  trailId: z.string().min(1).max(64),
  caption: z.string().max(MAX_CAPTION_LENGTH).nullable().default(null),
  /** Where it was taken, if the client could read it from the file or the device. */
  lng: z.number().min(-180).max(180).nullable().default(null),
  lat: z.number().min(-90).max(90).nullable().default(null),
  capturedAt: z.date().nullable().default(null),
});

export type PhotoCommitInput = z.infer<typeof photoCommitSchema>;

/**
 * A human-readable size.
 *
 * Two callers: the error telling somebody their photograph is too big — `12 MB` beats
 * `12582912 bytes` — and the offline storage manager, which counts in hundreds of megabytes
 * and occasionally in gigabytes. Rounding up at the small end means the number printed in an
 * error is never smaller than the limit being enforced.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// EXIF — the two facts worth reading, and the judgement about them
// ---------------------------------------------------------------------------

/*
 * The *reading* of EXIF differs completely between the two clients and cannot be shared: the
 * browser gets a `File` and has to hike the APP1 segment itself (`apps/web/src/lib/exif.ts`),
 * while iOS hands `expo-image-picker` a dictionary that Core Graphics already parsed. What is
 * shared is everything downstream of the read — which timestamps are believable, and which
 * coordinates are a real fix rather than a chip reporting nothing. Those are judgements about
 * the world, not about a file format, and two copies of them would quietly disagree about
 * whether a 1980 photograph counts.
 */

/**
 * `2024:09:14 07:32:10` plus an optional `+02:00`.
 *
 * The colons in the date half are EXIF's, not a typo, and no `Date` constructor accepts them.
 * When there is no offset tag the timestamp is local time at an unstated place — which is
 * genuinely all the file says — so it is read as UTC and left as an approximation rather than
 * silently shifted by whatever zone the *uploading device* happens to be in. That would be a
 * different kind of wrong, and a less honest one.
 *
 * A camera with a dead clock reports 1980, and a phone that has never had a signal reports the
 * epoch. Neither is a date worth captioning a photograph with, so both are refused, along with
 * anything more than a day in the future.
 */
export function parseExifDateTime(value: string | null, offset: string | null): Date | null {
  if (!value) return null;
  const match = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/u.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const zone = offset && /^[+-]\d{2}:\d{2}$/u.test(offset) ? offset : 'Z';
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`);
  if (Number.isNaN(date.getTime())) return null;

  if (date.getUTCFullYear() < 1990 || date.getTime() > Date.now() + 86_400_000) return null;
  return date;
}

/**
 * A GPS fix, or nothing at all.
 *
 * The angle EXIF stores is unsigned — the hemisphere lives in a separate one-character tag —
 * so applying the sign is part of reading a coordinate rather than something a caller does
 * afterwards. It is done here, once, because the alternative is the same three lines at each
 * of the two call sites that get the tags out of their own kind of container, and a parser
 * that forgets the ref puts every southern-hemisphere photograph in the north and every
 * western one in Asia. That is a bug worth having exactly one copy of.
 *
 * Both coordinates or neither: half a fix places a photograph on the prime meridian, which is
 * worse than placing it nowhere. Null Island is what a GPS chip reports when it has *no* fix,
 * not a place anyone hikes, so an origin-ish pair is treated as the absence it actually is.
 *
 * Whether the fix is anywhere near the trail is decided on the server, not here —
 * `photos.commit` keeps a coordinate only when it falls inside the trail's own bounding box,
 * so a photograph taken at home and captioned from memory contributes no location.
 */
export function exifCoordinate(
  lat: number | null,
  latRef: string | null,
  lng: number | null,
  lngRef: string | null,
): { lat: number; lng: number } | null {
  if (lat === null || lng === null) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const signed = {
    lat: latRef?.trim().toUpperCase() === 'S' ? -lat : lat,
    lng: lngRef?.trim().toUpperCase() === 'W' ? -lng : lng,
  };

  if (Math.abs(signed.lat) > 90 || Math.abs(signed.lng) > 180) return null;
  if (Math.abs(signed.lat) < 0.0001 && Math.abs(signed.lng) < 0.0001) return null;
  return signed;
}
