/**
 * Photographs: the limits, the vocabulary, and the shapes both ends agree on. The limits live
 * here because browser, API and object store must agree — a mismatch fails after the bytes have
 * been sent.
 */
import { z } from 'zod';

/**
 * What we accept, and the extension each becomes in the key — browsers, CDNs and `curl -O` read
 * the suffix even though the store serves the signed `Content-Type`. HEIC is deliberately
 * absent: no browser but Safari decodes it, so the uploader re-encodes on the taking device.
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
 * 12 MB full, 512 kB thumbnail. Generous by design: `PHOTO_MAX_EDGE` controls the upload, and
 * the ceiling must clear a phone's raw output because a browser that cannot decode the source
 * falls back to sending it untouched.
 */
export const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
export const MAX_THUMB_BYTES = 512 * 1024;

/** Longest edge of the stored image. Enough for a full-bleed hero on a 2× laptop display. */
export const PHOTO_MAX_EDGE = 2560;
/** Longest edge of the thumbnail — the gallery strip and every card read this one. */
export const PHOTO_THUMB_EDGE = 480;
/** Buffer the BlurHash is computed from. The hash holds 4×3 terms; above ~32 px is wasted work. */
export const BLURHASH_SAMPLE_EDGE = 32;

/** JPEG quality for the re-encode. 0.82 is the knee — above it, size climbs faster than looks. */
export const PHOTO_JPEG_QUALITY = 0.82;

/** Per-user spam bounds, counted at commit so an unused presigned URL costs nobody anything. */
export const MAX_PHOTOS_PER_TRAIL_PER_USER = 12;
export const MAX_PHOTOS_PER_DAY = 100;

export const MAX_CAPTION_LENGTH = 280;

/** How long a presigned upload URL is good for. Long enough for a slow phone on a bad signal. */
export const UPLOAD_TICKET_TTL_S = 15 * 60;

/**
 * One presigned request, replayed verbatim. `headers` is not advisory: the signature covers
 * `content-type`, so sending a different one — or letting `fetch` infer it — yields
 * `SignatureDoesNotMatch`, and signing it stops a leaked ticket putting `text/html` in a bucket
 * we serve from. `url` may be absolute or root-relative (the local driver): resolve with
 * `new URL(ticket.url, apiOrigin)`.
 */
export interface UploadTicket {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  maxBytes: number;
}

/** What `photos.presign` hands back: where to put both renditions, and proof it said so. */
export interface UploadGrant {
  /** Opaque, signed, short-lived. Carries the keys and the caller's id so `commit` needs no
   * pending-uploads table, and cannot be repointed at another user's object. */
  token: string;
  full: UploadTicket;
  thumb: UploadTicket;
  expiresAt: Date;
}

/** Measured client-side and unverifiable — the server has no image decoder, deliberately (see
 * `blurhash.ts`). Layout and placeholders only, never access control. */
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
 * A human-readable size, for upload errors and the offline storage manager. Rounds up at the
 * small end, so an error never prints a number smaller than the limit being enforced.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1024) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

/*
 * EXIF *reading* differs per client and cannot be shared — the browser walks the APP1 segment
 * itself (`apps/web/src/lib/exif.ts`), iOS gets a parsed Core Graphics dictionary. What is
 * shared is the judgement downstream, and two copies of that would quietly disagree.
 */

/**
 * `2024:09:14 07:32:10` plus an optional `+02:00`. The colons in the date half are EXIF's and no
 * `Date` constructor accepts them. With no offset tag the timestamp is local time at an unstated
 * place, so it is read as UTC rather than shifted by the *uploading* device's zone. Pre-1990 (a
 * dead camera clock) and more than a day ahead are refused.
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
 * A GPS fix, or nothing. EXIF stores an unsigned angle with the hemisphere in a separate tag, so
 * applying the ref is part of reading a coordinate. Both coordinates or neither, and an
 * origin-ish pair is Null Island — what a chip reports with no fix. Whether the fix is near the
 * trail is decided in `photos.commit`.
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
