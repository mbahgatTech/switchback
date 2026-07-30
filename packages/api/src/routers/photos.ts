/**
 * Photographs from our users.
 *
 * The upload is a three-step handshake, and the shape of it is forced by one constraint:
 * the bytes must not pass through our API. Vercel caps a request body at 4.5 MB, a phone's
 * uplink holds a serverless invocation open for as long as it takes, and we would pay for
 * the same megabytes twice. So:
 *
 * 1. **`presign`** — the client says what it is about to upload. We check the caller's quota,
 *    mint two presigned `PUT` URLs (full and thumbnail), and hand back a signed grant that
 *    records what we authorised.
 * 2. The client `PUT`s straight to the object store. We are not involved.
 * 3. **`commit`** — the client returns the grant. We verify it, confirm the objects really
 *    arrived and are the size they claimed, and only then write the row.
 *
 * **Nothing exists until `commit`.** A photograph that was uploaded and never committed is
 * bytes in a bucket with no row pointing at them: invisible to every query, and swept up by
 * the orphan sweeper in the drain cron. That ordering is deliberate — the alternative, a row
 * written at presign and marked complete later, means every reader has to filter out rows for
 * uploads that were abandoned, forever, in every query.
 *
 * **The grant is the pending-uploads table.** A short-lived HS256 token carrying the caller's
 * id and the two keys, so `commit` can trust its destination without a table to write, sweep,
 * and race against. Same reasoning as the mobile auth handshake next door.
 *
 * **We never decode an image.** Width, height and BlurHash are measured by the client, in the
 * canvas pass that already produced the thumbnail, and taken on trust. That is a real
 * decision with a real cost — a liar can make their own photograph render at the wrong aspect
 * ratio — bought in exchange for keeping `sharp`, a native module needing a per-platform
 * build, out of a repository that has no build step.
 */
import { TRPCError } from '@trpc/server';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import {
  MAX_PHOTOS_PER_DAY,
  MAX_PHOTOS_PER_TRAIL_PER_USER,
  MAX_PHOTO_BYTES,
  MAX_THUMB_BYTES,
  UPLOAD_TICKET_TTL_S,
  formatBytes,
  isBlurhash,
  photoCommitSchema,
  photoContentTypeSchema,
} from '@switchback/core';
import type { PhotoContentType, UploadGrant } from '@switchback/core';
import { PhotoSource } from '@switchback/db';
import type { Prisma } from '@switchback/db';
import { photoKeys, storage } from '../storage';
import { protectedProcedure, publicProcedure, router } from '../trpc';

// ---------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------

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
 * Verify a grant against the caller.
 *
 * The subject check is the one that matters. Without it a grant is a bearer token for a
 * *destination*, and anyone who obtained one could commit a row pointing at another user's
 * object — attributing a stranger's photograph to themselves, or worse, to a trail.
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

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

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
  /*
   * **A hidden photograph leaves here with no URL.**
   *
   * Every public query already filters `hiddenAt: null`, so in practice the only caller
   * that ever sees one is `mine` — where the uploader is shown that their photograph was
   * removed rather than left to notice it is gone. Blanking the URL here anyway is the
   * belt: hiding an image means the bytes must not reach a browser, and a shape that still
   * carries a live object URL has not taken anything down, however carefully the `where`
   * clauses are written today. A `where` can be forgotten in a query added next year;
   * this cannot.
   *
   * The caption goes too. It is text the reporter may well have been complaining about.
   */
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

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

/**
 * Recompute `photoCount` and settle the hero, from the photographs that actually exist.
 *
 * Recomputed rather than incremented for the same reason `reviews.refreshAggregates` is: an
 * increment has to know whether this was an add or a replace, and every branch is a way for
 * the count on a card to drift permanently from the strip below it. One `COUNT` on an indexed
 * column is cheap and self-heals a row that drifted for any other reason.
 *
 * The hero rule is the one `packages/ingest`'s `chooseHero` already established, restated
 * here because the two paths must not disagree: **a photograph a user took outranks anything
 * we scraped.** Within user photographs it is the oldest that holds the spot, so uploading is
 * not a way to take the top of somebody else's trail page away from them — the first person
 * to contribute keeps it, and everyone after adds to the strip.
 *
 * `primaryPhotoId` is `@unique`, so a candidate another trail is already flying has to be
 * stepped over rather than claimed; taking it would abort the whole update on a constraint
 * violation and lose the count alongside the hero.
 */
export async function refreshTrailPhotos(
  db: Prisma.TransactionClient,
  trailId: string,
): Promise<void> {
  const [count, candidates, trail] = await Promise.all([
    // Both carry `hiddenAt: null`, and both have to. A count that includes a photograph the
    // gallery will not show puts "14 photographs" over a strip of thirteen; a hero chosen
    // from the hidden ones flies the taken-down image at the top of the trail page, which
    // is the single most visible place it could possibly land.
    db.photo.count({ where: { trailId, hiddenAt: null } }),
    db.photo.findMany({
      where: { trailId, hiddenAt: null },
      // `source` ascending puts `user` first: the enum is declared user, wikimedia, mapillary,
      // and Postgres sorts an enum by declaration order, which is why that order was chosen.
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
 * How far a coordinate may sit outside the trail's own bounding box and still be believed.
 *
 * Roughly 2 km. Wide enough for the trailhead car park and the lay-by half a kilometre before
 * it, which is where a good number of the photographs on any trail page are actually taken,
 * and narrow enough that a photograph from another valley is not quietly filed here.
 */
const PHOTO_BBOX_PAD_DEG = 0.02;

interface TrailBox {
  bboxW: number;
  bboxS: number;
  bboxE: number;
  bboxN: number;
}

/**
 * Decide what to do with a coordinate that came out of a photograph's EXIF.
 *
 * Two jobs, and the privacy one is the reason this is not simply stored as sent. Phones write
 * GPS into every frame they take, including the ones taken at home, and a person adding a
 * picture of their boots by the door has not decided to publish their address. So a coordinate
 * is kept only if it falls near the trail it is being attached to — which is the same test that
 * keeps a mistagged photograph from putting a pin in the wrong county, so one check buys both.
 *
 * `distM` is where along the trail it lands, so the gallery can pin a photograph to a point on
 * the elevation profile: *this is the summit block at 6.1 km*, not just *this is somewhere on
 * Vesper Peak*. `ST_LineLocatePoint` returns a fraction of the line's length, measured on the
 * spheroid so the metres are metres rather than degrees.
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
    // The coordinate passed the box test, so it is worth keeping even if the projection failed
    // — a trail with no geometry yet is the ordinary cause, and it will have some later.
    return { lng, lat, distM: null };
  }
}

/**
 * Both quota checks, run before we hand out a ticket and again before we write a row.
 *
 * **Neither filters `hiddenAt`, and that is deliberate.** A photograph a moderator removed
 * still counts against the uploader's daily allowance and against their twelve on this
 * trail. Discounting it would hand somebody whose upload was taken down a fresh slot to put
 * it straight back in, which turns the per-trail cap from a limit into a refill.
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const photosRouter = router({
  /**
   * Which driver is behind the uploader, so the client can say something true.
   *
   * Public because the sign-in page shows the same chrome as everything else, and because the
   * answer is a deployment fact rather than a secret. In development this reads `local`, and
   * the uploader shows a quiet note saying photographs are being written to disk rather than
   * to a bucket — which is exactly the sort of thing that should be visible rather than
   * discovered later by someone wondering where their files went.
   */
  storage: publicProcedure.query(() => ({ kind: storage().kind })),

  /**
   * Authorise one upload. Two objects: the image and its thumbnail.
   *
   * The size is declared, not proven — `commit` checks what actually landed. Declaring it
   * anyway means a 40 MB file is refused before the phone starts sending it, which is the
   * difference between an instant error and two minutes of progress bar followed by one.
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
   * The bytes are up. Write the row.
   *
   * `stat` before `create`, always. Without it a client could commit a grant it never used
   * and put a row on a trail page whose `url` 404s, which is worse than no photograph: it is
   * a broken image in a gallery with no way for anyone but us to remove it.
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
        // Sweep it rather than leave it: the client lied about the size at presign, the row is
        // not going to exist, and bytes with no row are bytes nobody will ever look for.
        await Promise.all([driver.remove(grant.full), driver.remove(grant.thumb)]).catch(() => {});
        throw new TRPCError({
          code: 'PAYLOAD_TOO_LARGE',
          message: `That photograph is ${formatBytes(full.size)}. The limit is ${formatBytes(MAX_PHOTO_BYTES)}.`,
        });
      }

      // A thumbnail is an optimisation, not a requirement. If the client could not make one —
      // an old browser, a format its canvas would not encode — the gallery falls back to the
      // full image, which is slower and correct. A *malformed* one is dropped for the same
      // reason: better no thumbnail than a broken one.
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
            // that tries to parse it, and this is the one place it can be caught cheaply.
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
   * Link photographs to a review that has just been saved.
   *
   * Separate from `reviews.upsert` because the two happen at different times: the photographs
   * are uploaded while the person is still writing, and the review does not have an id until
   * they press publish. Committing the photographs against the trail immediately and adopting
   * them here means an abandoned draft leaves photographs on the trail rather than orphaned
   * bytes — which is the better of the two failure modes, since that is what the person
   * pressed "add" intending to do.
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

      // Scoped by owner *and* trail. Adopting a photograph from another trail would put a
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
      // `hiddenAt: null` in the predicate, not a separate check: re-captioning a photograph
      // a moderator took down is a write to removed content, and the caption is often the
      // part that was reported. A hidden row simply matches nothing and reads as "no such
      // photograph", which is what the owner's gallery already says about it.
      const { count } = await ctx.db.photo.updateMany({
        where: { id: input.photoId, userId: ctx.user.id, hiddenAt: null },
        data: { caption: input.caption?.trim() ? input.caption.trim() : null },
      });
      if (count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such photograph.' });
      return { updated: true };
    }),

  /**
   * Withdraw your own photograph, bytes and all.
   *
   * The row goes first and the objects after. If the delete of the objects fails we have
   * orphaned bytes, which the sweeper collects; if it went the other way round and the row
   * delete failed we would have a gallery entry pointing at a 404, which nothing collects.
   * Given one of the two has to be able to fail, this is the one to leave failing.
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
        },
      });
      if (!photo || photo.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such photograph.' });
      }

      await ctx.db.$transaction(async (tx) => {
        // `Trail.primaryPhotoId` is a nullable foreign key, so the database drops the pointer
        // on its own; `refreshTrailPhotos` is what promotes a replacement into the empty spot.
        await tx.photo.delete({ where: { id: photo.id } });
        if (photo.trailId) await refreshTrailPhotos(tx, photo.trailId);
      });

      const driver = storage();
      const keys = photoKeys(ctx.user.id, photo.sourceId, 'image/jpeg');
      await Promise.all([
        // Derived from the stored URL rather than re-derived from the id, because the
        // extension depends on the format that was uploaded and only the URL still knows it.
        driver.remove(keyFromUrl(photo.url) ?? keys.full),
        photo.thumbUrl
          ? driver.remove(keyFromUrl(photo.thumbUrl) ?? keys.thumb)
          : Promise.resolve(),
      ]).catch(() => {});

      return { removed: true };
    }),

  /**
   * Everything the caller has contributed, newest first. The gallery on their own profile.
   *
   * **Hidden photographs are included here and nowhere else.** Every public gallery filters
   * them out; this one keeps them so the person who uploaded one is told it was removed
   * rather than left to notice a gap. `toPhoto` has already blanked the URL, so the row
   * carries the fact and not the image.
   */
  mine: protectedProcedure
    .input(z.object({ limit: z.number().int().min(1).max(60).default(24) }))
    .query(async ({ ctx, input }): Promise<TrailPhoto[]> => {
      const rows = await ctx.db.photo.findMany({
        where: { userId: ctx.user.id },
        orderBy: [{ createdAt: 'desc' }],
        take: input.limit,
        select: photoSelect,
      });
      return rows.map((row) => toPhoto(row, ctx.user.id));
    }),
});

/**
 * Recover the object key from a stored URL.
 *
 * Both drivers build their URLs by appending an escaped key to a fixed prefix, so the key is
 * everything after `photos/` — which is stable across a move from the local driver to R2, and
 * across a change of public domain. Returns null for a URL that does not look like ours, so
 * an old row written by some other means is skipped rather than turned into a delete of
 * whatever `photos/…` that path happens to resolve to.
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
