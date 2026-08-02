/**
 * Photographs from our users. Bytes go straight to R2 from the browser (see
 * `docs/architecture.md`), so the upload is a three-step handshake: `presign` checks quota and
 * mints two presigned PUTs plus a signed grant, the client PUTs the objects itself, and
 * `commit` verifies the grant, confirms the objects landed, and writes the row.
 *
 * **Nothing exists until `commit`.** An abandoned upload is bytes with no row — invisible to
 * every query and swept by the orphan sweeper — where a row written at presign would make
 * every reader filter abandoned uploads forever. The grant is a short-lived HS256 token
 * carrying the caller's id and the two keys, which is the pending-uploads table.
 *
 * **We never decode an image.** Width, height and BlurHash are measured by the client and
 * taken on trust — a liar can make their own photograph render at the wrong aspect ratio — to
 * keep `sharp`, a native module needing a per-platform build, out of a repo with no build step.
 */
import { TRPCError } from '@trpc/server';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import {
  MAX_PHOTOS_PER_DAY,
  MAX_PHOTOS_PER_TRAIL_PER_USER,
  MAX_PHOTO_BYTES,
  MAX_THUMB_BYTES,
  REMOVED_NOTICE_OWN,
  UPLOAD_TICKET_TTL_S,
  formatBytes,
  isBlurhash,
  photoCommitSchema,
  photoContentTypeSchema,
  trailTitle,
} from '@switchback/core';
import type { PhotoContentType, UploadGrant } from '@switchback/core';
import { PhotoSource } from '@switchback/db';
import type { Prisma } from '@switchback/db';
import { photoKeys, storage } from '../storage';
import { protectedProcedure, publicProcedure, router } from '../trpc';

const GRANT_ISSUER = 'switchback';
const GRANT_AUDIENCE = 'switchback-upload';

interface GrantClaims {
  /** The upload id — also the `sourceId`, so a re-commit of the same grant collides. */
  uid: string;
  full: string;
  thumb: string;
  ct: PhotoContentType;
}

function grantKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('AUTH_SECRET must be set and at least 32 characters');
  }
  return new TextEncoder().encode(secret);
}

async function signGrant(userId: string, claims: GrantClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(GRANT_ISSUER)
    .setAudience(GRANT_AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + UPLOAD_TICKET_TTL_S)
    .sign(grantKey());
}

/**
 * Verify a grant against the caller. The subject check is the one that matters: without it a
 * grant is a bearer token for a *destination*, and anyone holding one could commit a row
 * pointing at another user's object.
 */
async function verifyGrant(token: string, userId: string): Promise<GrantClaims> {
  try {
    const { payload } = await jwtVerify(token, grantKey(), {
      issuer: GRANT_ISSUER,
      audience: GRANT_AUDIENCE,
      algorithms: ['HS256'],
    });
    if (payload.sub !== userId) throw new Error('grant belongs to a different user');
    const claims = payload as unknown as GrantClaims;
    if (!claims.uid || !claims.full || !claims.thumb || !claims.ct) {
      throw new Error('grant is missing claims');
    }
    return claims;
  } catch {
    // Deliberately one message for every failure — expired, forged, someone else's. A caller
    // that can tell those apart can probe for which grants exist.
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: 'That upload has expired. Choose the photograph again.',
    });
  }
}

/** 16 bytes of CSPRNG, base64url. Long enough that keys are unguessable, short enough to read. */
function uploadId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/gu, '-')
    .replace(/\//gu, '_')
    .replace(/=+$/u, '');
}

export const photoSelect = {
  id: true,
  source: true,
  url: true,
  thumbUrl: true,
  width: true,
  height: true,
  blurhash: true,
  caption: true,
  license: true,
  attribution: true,
  sourceUrl: true,
  lng: true,
  lat: true,
  distM: true,
  capturedAt: true,
  createdAt: true,
  userId: true,
  trailId: true,
  reviewId: true,
  /* Read on every row so `toPhoto` can blank the URL rather than hand out a live object. */
  hiddenAt: true,
  user: { select: { id: true, username: true, name: true, image: true } },
} satisfies Prisma.PhotoSelect;

type PhotoRow = Prisma.PhotoGetPayload<{ select: typeof photoSelect }>;

export function toPhoto(row: PhotoRow, viewerId: string | null) {
  // A hidden photograph leaves here with no URL, and no caption — the caption is often the
  // text that was reported. The public queries already filter `hiddenAt`, but hiding means the
  // bytes must not reach a browser, and a `where` can be forgotten in a query added next year.
  const hidden = row.hiddenAt !== null;

  return {
    id: row.id,
    source: row.source,
    url: hidden ? null : row.url,
    thumbUrl: hidden ? null : row.thumbUrl,
    width: row.width,
    height: row.height,
    blurhash: hidden ? null : row.blurhash,
    caption: hidden ? null : row.caption,
    license: row.license,
    attribution: row.attribution,
    sourceUrl: row.sourceUrl,
    lng: row.lng,
    lat: row.lat,
    distM: row.distM,
    capturedAt: row.capturedAt,
    createdAt: row.createdAt,
    trailId: row.trailId,
    reviewId: row.reviewId,
    author: row.user
      ? { id: row.user.id, username: row.user.username, name: row.user.name, image: row.user.image }
      : null,
    isMine: viewerId !== null && row.userId === viewerId,
    hidden,
  };
}

export type TrailPhoto = ReturnType<typeof toPhoto>;

/**
 * Recompute `photoCount` and settle the hero from the photographs that actually exist.
 * Recomputed rather than incremented, like `reviews.refreshAggregates`: one `COUNT` on an
 * indexed column self-heals a row that drifted.
 *
 * The hero rule restates `packages/ingest`'s `chooseHero`, because the two paths must not
 * disagree: a user photograph outranks anything scraped, and within user photographs the
 * oldest holds the spot, so uploading cannot take the top of somebody else's trail page.
 * `primaryPhotoId` is `@unique`, so a candidate another trail already flies is stepped over —
 * claiming it would abort the update on a constraint violation and lose the count too.
 */
export async function refreshTrailPhotos(
  db: Prisma.TransactionClient,
  trailId: string,
): Promise<void> {
  const [count, candidates, trail] = await Promise.all([
    // Both carry `hiddenAt: null`, and both must: a count including a photograph the gallery
    // will not show puts "14 photographs" over a strip of thirteen, and a hero chosen from the
    // hidden ones flies a taken-down image at the top of the trail page.
    db.photo.count({ where: { trailId, hiddenAt: null } }),
    db.photo.findMany({
      where: { trailId, hiddenAt: null },
      // `source` ascending puts `user` first: Postgres sorts an enum by declaration order, and
      // the enum is declared user, wikimedia, mapillary for exactly this reason.
      orderBy: [{ source: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, source: true },
      take: 20,
    }),
    db.trail.findUnique({ where: { id: trailId }, select: { primaryPhotoId: true } }),
  ]);

  const taken = new Set(
    (
      await db.trail.findMany({
        where: { id: { not: trailId }, primaryPhotoId: { in: candidates.map((c) => c.id) } },
        select: { primaryPhotoId: true },
      })
    ).flatMap((row) => (row.primaryPhotoId ? [row.primaryPhotoId] : [])),
  );

  const hero = candidates.find((candidate) => !taken.has(candidate.id))?.id ?? null;
  const data: Prisma.TrailUpdateInput = { photoCount: count };
  if (hero !== (trail?.primaryPhotoId ?? null)) {
    data.primaryPhoto = hero === null ? { disconnect: true } : { connect: { id: hero } };
  }
  await db.trail.update({ where: { id: trailId }, data });
}

/**
 * How far a coordinate may sit outside the trail's own bounding box and still be believed —
 * roughly 2 km, which covers the trailhead car park without filing another valley here.
 */
const PHOTO_BBOX_PAD_DEG = 0.02;

interface TrailBox {
  bboxW: number;
  bboxS: number;
  bboxE: number;
  bboxN: number;
}

/**
 * Decide what to do with a coordinate out of a photograph's EXIF. Kept only if it falls near
 * the trail it is attached to: phones write GPS into frames taken at home, and someone adding
 * a picture of their boots by the door has not decided to publish their address. The same test
 * keeps a mistagged photograph from putting a pin in the wrong county.
 *
 * `distM` is where along the trail it lands, so the gallery can pin it to a point on the
 * elevation profile. `ST_LineLocatePoint` returns a fraction of the line's length, measured on
 * the spheroid so the metres are metres.
 */
async function locatePhoto(
  db: Prisma.TransactionClient,
  trail: TrailBox & { id: string },
  lng: number | null,
  lat: number | null,
): Promise<{ lng: number | null; lat: number | null; distM: number | null }> {
  const nothing = { lng: null, lat: null, distM: null };
  if (lng === null || lat === null) return nothing;

  const inside =
    lng >= trail.bboxW - PHOTO_BBOX_PAD_DEG &&
    lng <= trail.bboxE + PHOTO_BBOX_PAD_DEG &&
    lat >= trail.bboxS - PHOTO_BBOX_PAD_DEG &&
    lat <= trail.bboxN + PHOTO_BBOX_PAD_DEG;
  if (!inside) return nothing;

  try {
    const rows = await db.$queryRaw<{ distM: number | null }[]>`
      SELECT ST_LineLocatePoint(t.geom, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326))
               * ST_Length(t.geom::geography) AS "distM"
      FROM trails t
      WHERE t.id = ${trail.id} AND t.geom IS NOT NULL
    `;
    const distM = rows[0]?.distM ?? null;
    return { lng, lat, distM: distM !== null && Number.isFinite(distM) ? Math.round(distM) : null };
  } catch {
    // The coordinate passed the box test, so it is worth keeping even if the projection
    // failed — a trail with no geometry yet is the ordinary cause.
    return { lng, lat, distM: null };
  }
}

/**
 * Both quota checks, run before we hand out a ticket and again before we write a row. Neither
 * filters `hiddenAt`, deliberately: discounting a removed photograph would hand its uploader a
 * fresh slot to put it straight back in, turning the per-trail cap into a refill.
 */
async function assertWithinQuota(
  db: Prisma.TransactionClient,
  userId: string,
  trailId: string | null,
): Promise<void> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [today, onTrail] = await Promise.all([
    db.photo.count({ where: { userId, createdAt: { gte: since } } }),
    trailId === null ? Promise.resolve(0) : db.photo.count({ where: { userId, trailId } }),
  ]);

  if (today >= MAX_PHOTOS_PER_DAY) {
    throw new TRPCError({
      code: 'TOO_MANY_REQUESTS',
      message: `That is ${MAX_PHOTOS_PER_DAY} photographs in a day. Try again tomorrow.`,
    });
  }
  if (onTrail >= MAX_PHOTOS_PER_TRAIL_PER_USER) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `You have already added ${MAX_PHOTOS_PER_TRAIL_PER_USER} photographs to this trail.`,
    });
  }
}

export const photosRouter = router({
  /**
   * Which driver is behind the uploader, so the client can say something true. Public: the
   * answer is a deployment fact, and in development it reads `local` so the uploader can note
   * that photographs are going to disk rather than to a bucket.
   */
  storage: publicProcedure.query(() => ({ kind: storage().kind })),

  /**
   * Authorise one upload — the image and its thumbnail. The size is declared, not proven;
   * `commit` checks what actually landed. Declaring it refuses a 40 MB file before the phone
   * starts sending it.
   */
  presign: protectedProcedure
    .input(
      z.object({
        contentType: photoContentTypeSchema,
        bytes: z.number().int().positive(),
        /** Checked here so the "twelve already" refusal arrives before the upload, not after. */
        trailId: z.string().min(1).max(64).nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<UploadGrant> => {
      if (input.bytes > MAX_PHOTO_BYTES) {
        throw new TRPCError({
          code: 'PAYLOAD_TOO_LARGE',
          message: `That photograph is ${formatBytes(input.bytes)}. The limit is ${formatBytes(MAX_PHOTO_BYTES)}.`,
        });
      }
      await assertWithinQuota(ctx.db, ctx.user.id, input.trailId);

      const id = uploadId();
      const keys = photoKeys(ctx.user.id, id, input.contentType);
      const driver = storage();

      const [full, thumb, token] = await Promise.all([
        driver.presignPut(keys.full, input.contentType, UPLOAD_TICKET_TTL_S),
        driver.presignPut(keys.thumb, 'image/jpeg', UPLOAD_TICKET_TTL_S),
        signGrant(ctx.user.id, {
          uid: id,
          full: keys.full,
          thumb: keys.thumb,
          ct: input.contentType,
        }),
      ]);

      return {
        token,
        full: { url: full.url, method: 'PUT', headers: full.headers, maxBytes: MAX_PHOTO_BYTES },
        thumb: { url: thumb.url, method: 'PUT', headers: thumb.headers, maxBytes: MAX_THUMB_BYTES },
        expiresAt: new Date(Date.now() + UPLOAD_TICKET_TTL_S * 1000),
      };
    }),

  /**
   * The bytes are up. Write the row. `stat` before `create`, always: without it a client could
   * commit a grant it never used and put a row on a trail page whose `url` 404s.
   */
  commit: protectedProcedure
    .input(photoCommitSchema)
    .mutation(async ({ ctx, input }): Promise<TrailPhoto> => {
      const grant = await verifyGrant(input.token, ctx.user.id);
      const driver = storage();

      const trail = await ctx.db.trail.findUnique({
        where: { id: input.trailId },
        select: { id: true, bboxW: true, bboxS: true, bboxE: true, bboxN: true },
      });
      if (!trail) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such trail.' });

      await assertWithinQuota(ctx.db, ctx.user.id, input.trailId);

      const [full, thumb] = await Promise.all([
        driver.stat(grant.full),
        driver.stat(grant.thumb).catch(() => null),
      ]);

      if (!full) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That photograph did not finish uploading. Try again.',
        });
      }
      if (full.size > MAX_PHOTO_BYTES) {
        // Swept rather than left: the client lied about the size at presign, so the row is not
        // going to exist and bytes with no row are bytes nobody will look for.
        await Promise.all([driver.remove(grant.full), driver.remove(grant.thumb)]).catch(() => {});
        throw new TRPCError({
          code: 'PAYLOAD_TOO_LARGE',
          message: `That photograph is ${formatBytes(full.size)}. The limit is ${formatBytes(MAX_PHOTO_BYTES)}.`,
        });
      }

      // A thumbnail is an optimisation, not a requirement: without a usable one the gallery
      // falls back to the full image, which is slower and correct.
      const thumbUsable = thumb !== null && thumb.size > 0 && thumb.size <= MAX_THUMB_BYTES;

      const row = await ctx.db.$transaction(async (tx) => {
        const where = await locatePhoto(tx, trail, input.lng, input.lat);
        const created = await tx.photo.create({
          data: {
            source: PhotoSource.user,
            sourceId: grant.uid,
            trailId: input.trailId,
            userId: ctx.user.id,
            url: driver.publicUrl(grant.full),
            thumbUrl: thumbUsable ? driver.publicUrl(grant.thumb) : null,
            width: input.width,
            height: input.height,
            // Validated rather than trusted: a malformed hash throws inside every renderer
            // that parses it, and this is the one place it can be caught cheaply.
            blurhash: input.blurhash && isBlurhash(input.blurhash) ? input.blurhash : null,
            caption: input.caption?.trim() ? input.caption.trim() : null,
            lng: where.lng,
            lat: where.lat,
            distM: where.distM,
            capturedAt: input.capturedAt,
          },
          select: photoSelect,
        });
        await refreshTrailPhotos(tx, input.trailId);
        return created;
      });

      return toPhoto(row, ctx.user.id);
    }),

  /**
   * Link photographs to a review that has just been saved. Separate from `reviews.upsert`
   * because the photographs are uploaded while the person is still writing and the review has
   * no id until publish; committing them against the trail immediately means an abandoned
   * draft leaves photographs on the trail rather than orphaned bytes.
   */
  attach: protectedProcedure
    .input(
      z.object({
        reviewId: z.string().min(1).max(64),
        photoIds: z.array(z.string().min(1).max(64)).max(MAX_PHOTOS_PER_TRAIL_PER_USER),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const review = await ctx.db.review.findUnique({
        where: { id: input.reviewId },
        select: { id: true, userId: true, trailId: true },
      });
      if (!review || review.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such review.' });
      }

      // Scoped by owner *and* trail: adopting a photograph from another trail would put a
      // picture of somewhere else beside a review of this one.
      const { count } = await ctx.db.photo.updateMany({
        where: { id: { in: input.photoIds }, userId: ctx.user.id, trailId: review.trailId },
        data: { reviewId: review.id },
      });
      return { attached: count };
    }),

  /** Re-caption your own photograph. The only field worth editing after the fact. */
  caption: protectedProcedure
    .input(
      z.object({
        photoId: z.string().min(1).max(64),
        caption: z.string().max(280).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // `hiddenAt: null` in the predicate, not a separate check: re-captioning a photograph a
      // moderator took down is a write to removed content, and the caption is often the part
      // that was reported. A hidden row matches nothing and reads as "no such photograph".
      const { count } = await ctx.db.photo.updateMany({
        where: { id: input.photoId, userId: ctx.user.id, hiddenAt: null },
        data: { caption: input.caption?.trim() ? input.caption.trim() : null },
      });
      if (count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such photograph.' });
      return { updated: true };
    }),

  /**
   * Withdraw your own photograph, bytes and all. The row goes first and the objects after: a
   * failed object delete leaves orphaned bytes the sweeper collects, where the other order
   * would leave a gallery entry pointing at a 404, which nothing collects.
   *
   * **A photograph a moderator took down cannot be deleted here.** Deleting the row would free
   * the quota slots `assertWithinQuota` deliberately refuses to discount, making "delete, then
   * re-upload" a one-call refill; it would also destroy the `hiddenAt`/`hiddenById`/
   * `hiddenReason` record and orphan every report filed against the id.
   */
  remove: protectedProcedure
    .input(z.object({ photoId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const photo = await ctx.db.photo.findUnique({
        where: { id: input.photoId },
        select: {
          id: true,
          userId: true,
          trailId: true,
          url: true,
          thumbUrl: true,
          sourceId: true,
          hiddenAt: true,
        },
      });
      if (!photo || photo.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such photograph.' });
      }
      if (photo.hiddenAt !== null) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: `${REMOVED_NOTICE_OWN} You cannot delete it while it is removed.`,
        });
      }

      await ctx.db.$transaction(async (tx) => {
        // `Trail.primaryPhotoId` is a nullable foreign key, so the database drops the pointer
        // itself; `refreshTrailPhotos` promotes a replacement into the empty spot.
        await tx.photo.delete({ where: { id: photo.id } });
        if (photo.trailId) await refreshTrailPhotos(tx, photo.trailId);
      });

      const driver = storage();
      const keys = photoKeys(ctx.user.id, photo.sourceId, 'image/jpeg');
      await Promise.all([
        // Derived from the stored URL rather than re-derived from the id: the extension
        // depends on the format that was uploaded, and only the URL still knows it.
        driver.remove(keyFromUrl(photo.url) ?? keys.full),
        photo.thumbUrl
          ? driver.remove(keyFromUrl(photo.thumbUrl) ?? keys.thumb)
          : Promise.resolve(),
      ]).catch(() => {});

      return { removed: true };
    }),

  /**
   * Everything the caller has contributed, newest first — the gallery on their own profile,
   * rendered by `components/profile/photographs.tsx`.
   *
   * **Hidden photographs are included here and nowhere else**, so the uploader is told one was
   * removed rather than left to notice a gap; `toPhoto` has already blanked the URL. Removed
   * frames sort first, which is what `nulls: 'last'` does: hiding does not touch `createdAt`,
   * and both callers ask for 24, so under a plain newest-first order a contributor with thirty
   * photographs would see no notice at all — and `/terms` promises they will.
   */
  mine: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(60).default(24) }))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.photo.findMany({
        where: { userId: ctx.user.id },
        orderBy: [{ hiddenAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
        take: input.limit,
        select: {
          ...photoSelect,
          trail: { select: { name: true, displayName: true, slug: true } },
        },
      });
      return rows.map((row) => ({
        ...toPhoto(row, ctx.user.id),
        // One resolved `title`, not a `name` that would be the OSM name here and the derived
        // one on a `TrailSummary`: under that key the iOS gallery put a second `trailTitle` on
        // top of this, and got away with it only because a second pass changes nothing.
        trail: row.trail === null ? null : { title: trailTitle(row.trail), slug: row.trail.slug },
      }));
    }),
});

/**
 * Recover the object key from a stored URL. Both drivers append an escaped key to a fixed
 * prefix, so the key is everything after `photos/` — stable across a move to R2 and a change
 * of public domain. Null for a URL that does not look like ours, so an old row written by some
 * other means is skipped rather than turned into a delete of whatever that path resolves to.
 */
export function keyFromUrl(url: string): string | null {
  const match = /(?:^|\/)(photos\/[^?#]+)/u.exec(url);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}
