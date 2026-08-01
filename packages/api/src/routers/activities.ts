/**
 * Recording a hike: `start` opens a row, `append` sends fixes as they arrive, `finish` closes
 * it. Nothing waits for the end, so a phone that dies mid-hike leaves a shorter hike rather
 * than none.
 *
 * Three properties hold that up. Every statistic is recomputed here from the stored samples
 * on every append — the client's running totals are never written, or a recording cut short
 * would report a distance of zero. Samples are **measured before they are thinned**, always:
 * simplification removes the fixes a stationary pause is made of, and those are exactly what
 * moving time is computed from. And elevation is corrected against the DEM on `finish`, so a
 * recorded hike and the trail it followed report ascent on the same terms; guarded, because a
 * terrain fetch failing must not lose somebody's hike.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  ACTIVITY_NAME_MAX,
  ACTIVITY_NOTES_MAX,
  ACTIVITY_TYPES,
  HEATMAP_CLIP_M,
  HEATMAP_MAX_CELLS,
  HEATMAP_MAX_TRACKS,
  HEATMAP_MIN_HIKERS,
  SAMPLE_BATCH,
  VISIBILITIES,
  defaultActivityName,
  heatmapCellMetres,
  heatmapRequestSchema,
  heatmapStepDeg,
  trackFixSchema,
} from '@switchback/core';
import type {
  ActivityDetail,
  ActivitySummary,
  BBox,
  Heatmap,
  LngLat,
  TrackFix,
} from '@switchback/core';
import { Prisma } from '@switchback/db';
import type { PrismaClient, User } from '@switchback/db';
import { writeActivityGeometry, writeSampleElevations } from '@switchback/db';
import { sampleElevations } from '@switchback/geo';
import {
  computeSplits,
  encodeBase64,
  simplifyTrack,
  summariseTrack,
  toFitActivity,
  toGeoJsonLine,
  toGpx,
  toTrackTuples,
} from '@switchback/geo';
import { TerrainSource, fillGaps } from '@switchback/ingest';
import { decodeCursor, encodeCursor } from '../cursor';
import { cancelLifelineForActivity, endLifelineForActivity } from '../lifeline';
import { summarySelect, toSummary as toTrailSummary } from '../trail-shape';
import { guessOffsetS } from './busyness';
import { protectedProcedure, publicProcedure, router } from '../trpc';

/**
 * How many recordings a user may have open at once. `start` closes the stragglers rather than
 * refusing — refusing would leave anyone who force-quit the app unable to record again.
 */
const MAX_OPEN = 1;

/**
 * A recording longer than this is a phone that never stopped, not a hike. Closed by `start`
 * rather than deleted: the fixes in it are real.
 */
const MAX_RECORDING_MS = 48 * 60 * 60 * 1000;

/** Samples we will hold for one recording, after thinning. */
const MAX_SAMPLES = 20_000;

const PAGE = 20;
const MAX_PAGE = 50;

/**
 * Heatmap densification, as a fraction of the lattice cell. Nyquist applied to a grid: below
 * one cell so a straight segment cannot step over a cell without landing in it, above a half
 * so we are not paying for three samples where two would do.
 */
const SPACING_FRACTION = 0.6;

/** Floor on that spacing. Below about 20 m we are resampling GPS noise, not a route. */
const HEATMAP_MIN_SPACING_M = 20;

/** Track left after both endpoint trims for the track to be worth counting at all. */
const HEATMAP_MIN_KEEP_M = 100;

/** Module-level so the tile cache survives between requests on a warm instance. */
const terrain = new TerrainSource();

const activitySelect = {
  id: true,
  userId: true,
  name: true,
  activityType: true,
  visibility: true,
  notes: true,
  device: true,
  startedAt: true,
  endedAt: true,
  syncedAt: true,
  distanceM: true,
  gainM: true,
  lossM: true,
  minEleM: true,
  maxEleM: true,
  movingTimeS: true,
  elapsedTimeS: true,
  avgSpeedMps: true,
  maxSpeedMps: true,
  trail: { select: summarySelect },
  user: { select: { id: true, username: true, name: true, image: true } },
  _count: { select: { photos: true } },
} satisfies Prisma.ActivitySelect;

type ActivityRow = Prisma.ActivityGetPayload<{ select: typeof activitySelect }>;

function toSummary(row: ActivityRow, viewerId: string | null): ActivitySummary {
  return {
    id: row.id,
    name: row.name,
    activityType: row.activityType,
    visibility: row.visibility,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    syncedAt: row.syncedAt,
    distanceM: row.distanceM,
    gainM: row.gainM,
    lossM: row.lossM,
    minEleM: row.minEleM,
    maxEleM: row.maxEleM,
    movingTimeS: row.movingTimeS,
    elapsedTimeS: row.elapsedTimeS,
    avgSpeedMps: row.avgSpeedMps,
    maxSpeedMps: row.maxSpeedMps,
    trail: row.trail ? toTrailSummary(row.trail) : null,
    photoCount: row._count.photos,
    // Omitted for your own recordings, which keeps a hundred copies of your own avatar off
    // your own list.
    owner: row.userId === viewerId ? null : { ...row.user },
  };
}

/**
 * Whether `viewer` may read this recording. `followers` resolves the same as `private` for
 * everyone but the owner until a follow graph exists — the safe direction to be wrong in.
 */
function canView(row: { userId: string; visibility: string }, viewer: User | null): boolean {
  if (viewer?.id === row.userId) return true;
  return row.visibility === 'public';
}

async function loadFixes(db: PrismaClient, activityId: string): Promise<TrackFix[]> {
  const rows = await db.activitySample.findMany({
    where: { activityId },
    orderBy: { t: 'asc' },
    select: {
      t: true,
      lng: true,
      lat: true,
      eleM: true,
      accuracyM: true,
      speedMps: true,
      heartRate: true,
      cadence: true,
    },
  });
  return rows;
}

/**
 * Recompute the row's statistics from what is stored. Called after every append and again at
 * finish, so the row is never out of step with its own track whatever happened to the client.
 */
async function restat(
  db: PrismaClient,
  activityId: string,
  fixes: readonly TrackFix[],
): Promise<ActivityRow> {
  const stats = summariseTrack(fixes);
  return db.activity.update({
    where: { id: activityId },
    data: stats,
    select: activitySelect,
  });
}

/**
 * Replace GPS altitudes with DEM elevations, returning the fixes unchanged on any failure —
 * this runs on the request that ends somebody's hike, where an error is the one unacceptable
 * outcome, and the correction improves a number we already have rather than supplying one.
 */
async function correctElevations(fixes: readonly TrackFix[]): Promise<TrackFix[]> {
  if (fixes.length === 0) return [...fixes];
  try {
    const coords: LngLat[] = fixes.map((fix) => [fix.lng, fix.lat]);
    const tiles = await terrain.tilesFor(coords);
    const raw = sampleElevations(coords, tiles);
    const { filled, gapCount } = fillGaps(raw);
    // A track that is entirely gap is over ocean or off the DEM's edge; sea level everywhere
    // would be a confident lie, so the recorded altitudes stand.
    if (gapCount >= coords.length) return [...fixes];
    return fixes.map((fix, i) => ({ ...fix, eleM: Math.round(filled[i]! * 10) / 10 }));
  } catch {
    return [...fixes];
  }
}

/** The busyness observation a finished recording contributes. See `packages/busyness/observe.ts`. */
async function observeStart(
  db: PrismaClient,
  trailId: string,
  startedAt: Date,
  lngDeg: number,
): Promise<void> {
  // Local to the trail, not to the server or the hiker's phone. A 07:00 start in the
  // Cascades is an early start wherever the request came from.
  const local = new Date(startedAt.getTime() + guessOffsetS(lngDeg) * 1000);
  const dayOfWeek = local.getUTCDay();
  const hour = local.getUTCHours();

  // `observed` accumulates a plain count though the column is named for an EWMA:
  // `blendObservations` normalises to its own weekly peak before mixing, so the two produce
  // the identical surface. Time decay is the part that would differ.
  await db.busynessBucket.upsert({
    where: { trailId_dayOfWeek_hour: { trailId, dayOfWeek, hour } },
    create: { trailId, dayOfWeek, hour, observed: 1, sampleCount: 1 },
    update: { observed: { increment: 1 }, sampleCount: { increment: 1 } },
  });
}

const idInput = z.object({ id: z.string().min(1).max(64) });

export const activitiesRouter = router({
  /**
   * Open a recording. `startedAt` comes from the client because the hike started when the
   * button was pressed, not when the request arrived, and is clamped to the present so a
   * wrong clock cannot pin a recording to the top of every list.
   *
   * `id` comes from the client too, which is what makes a hike startable offline: the device
   * mints a v4 UUID before the first fix, so this call is a confirmation and the id is the
   * idempotency key a blind retry rests on. The id is looked up before anything is created,
   * and a `P2002` from the create resolves the same way; an id belonging to somebody else is
   * a conflict rather than an adoption.
   */
  start: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid().optional(),
        activityType: z.enum(ACTIVITY_TYPES).default('hiking'),
        trailId: z.string().min(1).max(64).nullish(),
        name: z.string().trim().min(1).max(ACTIVITY_NAME_MAX).nullish(),
        device: z.string().trim().max(120).nullish(),
        startedAt: z.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const now = new Date();
      const startedAt =
        input.startedAt && input.startedAt.getTime() <= now.getTime() ? input.startedAt : now;

      /** A replay: hand back the row that already exists, or refuse if it is not theirs. */
      const adopt = async (id: string): Promise<ActivitySummary | null> => {
        const existing = await ctx.db.activity.findUnique({
          where: { id },
          select: activitySelect,
        });
        if (!existing) return null;
        if (existing.userId !== ctx.user.id) {
          throw new TRPCError({ code: 'CONFLICT', message: 'That recording is not yours.' });
        }
        return toSummary(existing, ctx.user.id);
      };

      // Before the stale sweep, deliberately: a replay must change nothing, and the sweep
      // would close the very recording it is asking about.
      if (input.id) {
        const replayed = await adopt(input.id);
        if (replayed) return replayed;
      }

      // Closed rather than deleted: whatever fixes an abandoned recording holds are a real
      // hike, just an unfinished one.
      const stale = await ctx.db.activity.findMany({
        where: { userId: ctx.user.id, endedAt: null },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true },
      });
      // Only recordings that began no later than this one. The sweep keeps the most recent
      // `MAX_OPEN` by start time, so a hike recorded offline yesterday and backfilled today
      // would otherwise close the hike being recorded right now.
      for (const row of stale.filter((r) => r.startedAt <= startedAt).slice(MAX_OPEN - 1)) {
        await closeStale(ctx.db, row.id);
      }

      const trail = input.trailId
        ? await ctx.db.trail.findUnique({ where: { id: input.trailId }, select: { name: true } })
        : null;

      const data = {
        userId: ctx.user.id,
        activityType: input.activityType,
        trailId: trail ? input.trailId : null,
        name: input.name ?? defaultActivityName(input.activityType, startedAt, trail?.name),
        device: input.device ?? null,
        visibility: ctx.user.defaultActivityVisibility,
        startedAt,
        distanceM: 0,
        gainM: 0,
        lossM: 0,
      };

      try {
        const row = await ctx.db.activity.create({
          data: { ...data, ...(input.id ? { id: input.id } : {}) },
          select: activitySelect,
        });
        return toSummary(row, ctx.user.id);
      } catch (error) {
        // Two copies of the same start in flight at once — a drain and a reconnecting tab.
        // Neither had committed when the lookup ran, so the constraint settles it and the
        // loser adopts the winner's row.
        const clash =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!clash || !input.id) throw error;
        const replayed = await adopt(input.id);
        if (replayed) return replayed;
        throw error;
      }
    }),

  /**
   * The recording still open, if there is one. What a refreshed tab or a relaunched app asks
   * first; without it, closing the page mid-hike strands the hike — open in the database,
   * invisible in the interface, impossible to finish.
   */
  open: protectedProcedure.query(async ({ ctx }) => {
    const row = await ctx.db.activity.findFirst({
      where: { userId: ctx.user.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
      select: activitySelect,
    });
    if (!row) return null;
    if (Date.now() - row.startedAt.getTime() > MAX_RECORDING_MS) {
      await closeStale(ctx.db, row.id);
      return null;
    }
    return toSummary(row, ctx.user.id);
  }),

  /**
   * Send fixes. Idempotent by second — `t` is unique within a recording — so a client on a
   * phone going in and out of signal can retry blindly. `start` is idempotent by id and
   * `finish` is replayable in service of the same policy.
   */
  append: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        fixes: z.array(trackFixSchema).min(1).max(SAMPLE_BATCH),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.activity.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true, endedAt: true, syncedAt: true },
      });
      if (!row || row.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such recording.' });
      }
      if (row.endedAt && row.syncedAt) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'That recording is already finished.',
        });
      }
      /*
       * Closed by the sweep, not by a person — reopen it and take the fixes. `syncedAt` is
       * what "the hiker finished this" means: `finish` alone sets it, and `closeStale`
       * deliberately leaves it null. A device still uploading is proof the recording was not
       * abandoned, so refusing here would turn a guess about abandonment into silent data
       * loss.
       */
      if (row.endedAt) {
        await ctx.db.activity.update({ where: { id: row.id }, data: { endedAt: null } });
      }

      const stored = await ctx.db.activitySample.count({ where: { activityId: row.id } });
      if (stored >= MAX_SAMPLES) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This recording has reached its maximum length. Finish it and start another.',
        });
      }

      // Thinned per batch. Endpoints survive simplification, so the joins between batches
      // are exact and the thinning cannot cut a corner across a gap in the uploads.
      const thinned = simplifyTrack(input.fixes);
      await ctx.db.activitySample.createMany({
        data: thinned.map((fix) => ({
          activityId: row.id,
          t: fix.t,
          lng: fix.lng,
          lat: fix.lat,
          eleM: fix.eleM ?? null,
          accuracyM: fix.accuracyM ?? null,
          speedMps: fix.speedMps ?? null,
          heartRate: fix.heartRate ?? null,
          cadence: fix.cadence ?? null,
        })),
        skipDuplicates: true,
      });

      const fixes = await loadFixes(ctx.db, row.id);
      const updated = await restat(ctx.db, row.id, fixes);
      return {
        accepted: thinned.length,
        stored: fixes.length,
        activity: toSummary(updated, ctx.user.id),
      };
    }),

  /**
   * Close a recording: the one place the elevation correction happens and the only place
   * `syncedAt` is set. Replayable on purpose, because a hike drained from the offline queue
   * may post it more than once — the statistics recompute to the same answer and the
   * completion is guarded by a unique on `activityId`. The busyness observation counts rather
   * than sets, which is why it is gated on the row not already having ended.
   */
  finish: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().trim().min(1).max(ACTIVITY_NAME_MAX).nullish(),
        notes: z.string().trim().max(ACTIVITY_NOTES_MAX).nullish(),
        visibility: z.enum(VISIBILITIES).optional(),
        trailId: z.string().min(1).max(64).nullish(),
        /** Add this hike to the hiker's completed list. Defaults on when there is a trail. */
        logCompletion: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.activity.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true, endedAt: true, trailId: true, startedAt: true },
      });
      if (!row || row.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such recording.' });
      }
      // Captured before the update below sets it: a replayed finish must not observe the
      // start a second time.
      const alreadyFinished = row.endedAt !== null;

      const trailId = input.trailId === undefined ? row.trailId : input.trailId;
      const stored = await loadFixes(ctx.db, row.id);
      const corrected = await correctElevations(stored);

      // Only where the DEM changed something, and in one statement rather than a thousand —
      // a six-hour hike is ten thousand rows after thinning.
      const moved = corrected.filter((fix, i) => fix.eleM !== stored[i]?.eleM);
      if (moved.length > 0) {
        await writeSampleElevations(
          ctx.db,
          row.id,
          moved.map((fix) => ({ t: fix.t, eleM: fix.eleM ?? null })),
        );
      }

      const stats = summariseTrack(corrected);
      const endedAt = new Date(row.startedAt.getTime() + stats.elapsedTimeS * 1000);

      const updated = await ctx.db.activity.update({
        where: { id: row.id },
        data: {
          ...stats,
          ...(input.name !== undefined && input.name !== null ? { name: input.name } : {}),
          ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.trailId !== undefined ? { trailId: input.trailId ?? null } : {}),
          // A recording with no fixes at all still has to end somewhere, and "now" is the
          // only honest answer for it.
          endedAt: stats.elapsedTimeS > 0 ? endedAt : new Date(),
          syncedAt: new Date(),
          geometryJson: corrected.length >= 2 ? toGeoJsonLine(corrected) : Prisma.DbNull,
        },
        select: activitySelect,
      });

      if (corrected.length >= 2) {
        await writeActivityGeometry(ctx.db, row.id, toGeoJsonLine(corrected));
      }

      /*
       * Somebody who has finished a recording has got back. Closing the Lifeline here rather
       * than making them remember a second button is what keeps "Overdue" meaningful.
       */
      await endLifelineForActivity(ctx.db, row.id, updated.endedAt ?? new Date());

      if (trailId) {
        const wantsCompletion = input.logCompletion ?? true;
        if (wantsCompletion) await logCompletion(ctx.db, ctx.user.id, trailId, row.id, endedAt);
        const trail = await ctx.db.trail.findUnique({
          where: { id: trailId },
          select: { centroidLng: true },
        });
        // Swallowed: one lost sample out of thousands must not fail the request that ends a
        // hike. First finish only — the bucket is a counter, and a replayed drain inflates it.
        if (trail && !alreadyFinished) {
          await observeStart(ctx.db, trailId, row.startedAt, trail.centroidLng).catch(
            () => undefined,
          );
        }
      }

      return toSummary(updated, ctx.user.id);
    }),

  /** Rename, re-describe, re-scope or re-attach a finished recording. */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().min(1).max(64),
        name: z.string().trim().min(1).max(ACTIVITY_NAME_MAX).optional(),
        notes: z.string().trim().max(ACTIVITY_NOTES_MAX).nullish(),
        visibility: z.enum(VISIBILITIES).optional(),
        activityType: z.enum(ACTIVITY_TYPES).optional(),
        trailId: z.string().min(1).max(64).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const row = await ctx.db.activity.findUnique({
        where: { id: input.id },
        select: { id: true, userId: true },
      });
      if (!row || row.userId !== ctx.user.id) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such recording.' });
      }
      const updated = await ctx.db.activity.update({
        where: { id: row.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
          ...(input.visibility ? { visibility: input.visibility } : {}),
          ...(input.activityType ? { activityType: input.activityType } : {}),
          ...(input.trailId !== undefined ? { trailId: input.trailId ?? null } : {}),
        },
        select: activitySelect,
      });
      return toSummary(updated, ctx.user.id);
    }),

  /**
   * Delete a recording and everything hanging off it. The completion goes with it: a
   * completion recorded from a hike is a claim that the hike happened, and keeping it would
   * leave a date in the completed list with nothing behind it and no way to correct it.
   */
  remove: protectedProcedure.input(idInput).mutation(async ({ ctx, input }) => {
    const row = await ctx.db.activity.findUnique({
      where: { id: input.id },
      select: { id: true, userId: true, completion: { select: { id: true, trailId: true } } },
    });
    if (!row || row.userId !== ctx.user.id) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No such recording.' });
    }

    await ctx.db.$transaction(async (tx) => {
      if (row.completion) {
        await tx.completion.delete({ where: { id: row.completion.id } });
        // Never below zero: the lists router contributes to this counter too, and a repair
        // that drove it negative would quietly invert the busyness prior.
        await tx.trail.updateMany({
          where: { id: row.completion.trailId, popularity: { gte: 1 } },
          data: { popularity: { decrement: 1 } },
        });
      }
      await tx.activitySample.deleteMany({ where: { activityId: row.id } });
      await tx.activity.delete({ where: { id: row.id } });
    });

    /*
     * `activityId` is `SetNull`, so a Lifeline whose recording is deleted keeps running and
     * goes overdue for a hike that was thrown away in the car park. Cancelled rather than
     * completed — nobody claimed to be back. Outside the transaction, and total, so a failure
     * closing it cannot block the delete.
     */
    await cancelLifelineForActivity(ctx.db, row.id);
    return { removed: true };
  }),

  /** The signed-in hiker's own recordings, newest first. */
  mine: protectedProcedure
    .input(
      z
        .object({
          cursor: z.string().optional(),
          limit: z.number().int().min(1).max(MAX_PAGE).optional(),
          trailId: z.string().min(1).max(64).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const limit = input?.limit ?? PAGE;
      const offset = decodeCursor(input?.cursor);
      const where: Prisma.ActivityWhereInput = {
        userId: ctx.user.id,
        ...(input?.trailId ? { trailId: input.trailId } : {}),
      };
      const [rows, total] = await Promise.all([
        ctx.db.activity.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          skip: offset,
          take: limit + 1,
          select: activitySelect,
        }),
        ctx.db.activity.count({ where }),
      ]);
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => toSummary(row, ctx.user.id)),
        total,
        nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
      };
    }),

  /** Somebody else's recordings — only the ones they made public. */
  byUser: publicProcedure
    .input(
      z.object({
        username: z.string().min(1).max(30),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_PAGE).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const owner = await ctx.db.user.findUnique({
        where: { username: input.username },
        select: { id: true },
      });
      if (!owner) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such hiker.' });

      const limit = input.limit ?? PAGE;
      const offset = decodeCursor(input.cursor);
      const where: Prisma.ActivityWhereInput = {
        userId: owner.id,
        endedAt: { not: null },
        // The owner sees their own private hikes through `mine`; this stays the public view
        // even when the viewer is the owner, so "view as others see it" can be built.
        visibility: 'public',
      };
      const [rows, total] = await Promise.all([
        ctx.db.activity.findMany({
          where,
          orderBy: { startedAt: 'desc' },
          skip: offset,
          take: limit + 1,
          select: activitySelect,
        }),
        ctx.db.activity.count({ where }),
      ]);
      const page = rows.slice(0, limit);
      return {
        items: page.map((row) => toSummary(row, ctx.user?.id ?? null)),
        total,
        nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
      };
    }),

  /** One recording, with its track and splits. */
  get: publicProcedure
    .input(idInput.extend({ units: z.enum(['metric', 'imperial']).optional() }))
    .query(async ({ ctx, input }): Promise<ActivityDetail> => {
      const row = await ctx.db.activity.findUnique({
        where: { id: input.id },
        select: activitySelect,
      });
      if (!row || !canView(row, ctx.user)) {
        // Deliberately the same answer as a recording that does not exist: "Forbidden" would
        // confirm that a private hike with this id is there to be found.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'No such recording.' });
      }

      const fixes = await loadFixes(ctx.db, row.id);
      const units = input.units ?? ctx.user?.units ?? 'metric';
      return {
        ...toSummary(row, ctx.user?.id ?? null),
        notes: row.notes,
        device: row.device,
        track: toTrackTuples(fixes),
        splits: computeSplits(fixes, units),
        isMine: ctx.user?.id === row.userId,
      };
    }),

  /**
   * The recording as GPX. A query returning the document rather than a REST route serving it,
   * so the same call works from the iOS app, which wants text for the share sheet.
   */
  gpx: publicProcedure.input(idInput).query(async ({ ctx, input }) => {
    const row = await ctx.db.activity.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        userId: true,
        name: true,
        notes: true,
        visibility: true,
        activityType: true,
        startedAt: true,
      },
    });
    if (!row || !canView(row, ctx.user)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No such recording.' });
    }
    const fixes = await loadFixes(ctx.db, row.id);
    const name = row.name ?? defaultActivityName(row.activityType, row.startedAt);
    return {
      filename: `${slugForFile(name)}-${row.startedAt.toISOString().slice(0, 10)}.gpx`,
      xml: toGpx(fixes, {
        name,
        startedAt: row.startedAt,
        description: row.notes,
        activityType: row.activityType,
      }),
    };
  }),

  /**
   * The same recording as FIT, for a watch. Separate from `gpx` rather than a format
   * parameter because the two return different things — text against base64 bytes — and
   * `expo-file-system` takes base64 directly.
   */
  fit: publicProcedure.input(idInput).query(async ({ ctx, input }) => {
    const row = await ctx.db.activity.findUnique({
      where: { id: input.id },
      select: {
        id: true,
        userId: true,
        name: true,
        visibility: true,
        activityType: true,
        startedAt: true,
      },
    });
    if (!row || !canView(row, ctx.user)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No such recording.' });
    }
    const fixes = await loadFixes(ctx.db, row.id);
    const name = row.name ?? defaultActivityName(row.activityType, row.startedAt);
    return {
      filename: `${slugForFile(name)}-${row.startedAt.toISOString().slice(0, 10)}.fit`,
      // No description field: FIT has nowhere to put free text a device will show, so the
      // notes stay with GPX.
      base64: encodeBase64(
        toFitActivity(fixes, {
          name,
          startedAt: row.startedAt,
          activityType: row.activityType,
        }),
      ),
    };
  }),

  /**
   * Every public recording, aggregated onto a fixed lattice. The privacy argument lives in
   * `@switchback/core`'s `heatmap` module beside the constants it justifies; four properties
   * of the query below carry it.
   *
   * Every control is in the SQL, not the renderer — k-anonymity applied client-side is
   * k-anonymity an attacker declines by reading the response. No row leaves with fewer than
   * {@link HEATMAP_MIN_HIKERS} contributors, and no coordinate leaves at all, only lattice
   * indices. **Endpoint clipping runs before viewport clipping and the order is
   * load-bearing:** `ST_LineSubstring` takes fractions of a line, so trimming the visible
   * part would move the censored zone as the reader pans and uncensor a front door the moment
   * it sits mid-screen. Viewport clipping is what bounds the work, making cost track screen
   * area rather than track length. And densification is additive (`ST_Segmentize` inserts
   * without removing) and never finer than a cell.
   */
  heatmap: publicProcedure
    .input(heatmapRequestSchema)
    .query(async ({ ctx, input }): Promise<Heatmap> => {
      const [w, s, e, n] = normaliseBox(input.bbox);
      const step = heatmapStepDeg(input.zoom);
      const spacingM = Math.max(HEATMAP_MIN_SPACING_M, heatmapCellMetres(step) * SPACING_FRACTION);
      // Anything shorter than both trims plus a usable remainder is all endpoint, so it is
      // dropped rather than trimmed into a degenerate line.
      const minLenM = HEATMAP_CLIP_M * 2 + HEATMAP_MIN_KEEP_M;

      const rows = await ctx.db.$queryRaw<HeatmapRow[]>`
        WITH bounds AS (
          SELECT ST_MakeEnvelope(${w}::float8, ${s}::float8, ${e}::float8, ${n}::float8, 4326) AS box
        ),
        tracks AS (
          SELECT a.id, a."userId", a.geom
            FROM activities a, bounds b
           WHERE a.visibility = 'public'
             AND a."syncedAt" IS NOT NULL
             AND a.geom IS NOT NULL
             AND a.geom && b.box
           ORDER BY a."startedAt" DESC
           LIMIT ${HEATMAP_MAX_TRACKS}
        ),
        measured AS (
          SELECT id, "userId", geom, ST_Length(geom::geography) AS len FROM tracks
        ),
        trimmed AS (
          SELECT id, "userId",
                 ST_LineSubstring(geom,
                                  ${HEATMAP_CLIP_M}::float8 / len,
                                  1 - ${HEATMAP_CLIP_M}::float8 / len) AS geom
            FROM measured
           WHERE len > ${minLenM}::float8
        ),
        clipped AS (
          SELECT t.id, t."userId",
                 ST_CollectionExtract(ST_Intersection(t.geom, b.box), 2) AS geom
            FROM trimmed t, bounds b
        ),
        pts AS (
          SELECT id, "userId",
                 (ST_DumpPoints(ST_Segmentize(geom::geography, ${spacingM}::float8)::geometry)).geom AS p
            FROM clipped
           WHERE geom IS NOT NULL AND NOT ST_IsEmpty(geom)
        ),
        grouped AS (
          SELECT floor(ST_X(p) / ${step}::float8)::int AS cx,
                 floor(ST_Y(p) / ${step}::float8)::int AS cy,
                 count(DISTINCT id)::int AS visits,
                 count(DISTINCT "userId")::int AS hikers
            FROM pts
           GROUP BY 1, 2
        ),
        kept AS (
          SELECT cx, cy, visits, hikers
            FROM grouped
           WHERE hikers >= ${HEATMAP_MIN_HIKERS}::int
           ORDER BY visits DESC, cx ASC, cy ASC
           LIMIT ${HEATMAP_MAX_CELLS}
        )
        SELECT
          (SELECT count(*)::int FROM tracks) AS tracks,
          (SELECT count(*)::int FROM grouped WHERE hikers < ${HEATMAP_MIN_HIKERS}::int) AS suppressed,
          (SELECT count(*)::int FROM grouped WHERE hikers >= ${HEATMAP_MIN_HIKERS}::int) AS passing,
          COALESCE(
            (SELECT json_agg(json_build_object('cx', cx, 'cy', cy, 'visits', visits, 'hikers', hikers))
               FROM kept),
            '[]'::json
          ) AS cells
      `;

      // The final SELECT is built from scalar subqueries precisely so it always returns one
      // row: a viewport where every cell was suppressed still has to be able to say so.
      const row = rows[0] ?? { tracks: 0, suppressed: 0, passing: 0, cells: [] };
      const cells = row.cells.map((cell) => ({
        // Derived here rather than in SQL: the lattice is `360 / 2^n`, exact in binary, so
        // client and server agree on the corners to the last bit.
        bbox: [cell.cx * step, cell.cy * step, (cell.cx + 1) * step, (cell.cy + 1) * step] as [
          number,
          number,
          number,
          number,
        ],
        visits: cell.visits,
        hikers: cell.hikers,
      }));

      return {
        cells,
        stepDeg: step,
        minHikers: HEATMAP_MIN_HIKERS,
        tracks: row.tracks,
        suppressed: row.suppressed,
        truncated: row.passing > cells.length,
      };
    }),
});

/**
 * Close a recording nobody finished. Its statistics are recomputed on the way out, so an
 * abandoned hike shows the right distance rather than the zeroes it was created with.
 * `syncedAt` is left null — it means "the hiker finished this", and nobody did.
 */
async function closeStale(db: PrismaClient, activityId: string): Promise<void> {
  const fixes = await loadFixes(db, activityId);
  const stats = summariseTrack(fixes);
  const row = await db.activity.findUnique({
    where: { id: activityId },
    select: { startedAt: true },
  });
  if (!row) return;

  // A recording with no fixes at all is a button pressed by accident; leaving it behind puts
  // an empty row at the top of the hiker's list.
  if (fixes.length === 0) {
    await db.activity.delete({ where: { id: activityId } });
    return;
  }

  await db.activity.update({
    where: { id: activityId },
    data: {
      ...stats,
      endedAt: new Date(row.startedAt.getTime() + stats.elapsedTimeS * 1000),
      geometryJson: fixes.length >= 2 ? toGeoJsonLine(fixes) : Prisma.DbNull,
    },
  });
  if (fixes.length >= 2) await writeActivityGeometry(db, activityId, toGeoJsonLine(fixes));
}

/**
 * Record that this hike happened, on the same table the completed list reads — nothing here
 * writes a `TrailListItem`; see the note at the top of `routers/lists.ts`.
 *
 * The read is an optimisation, not the guard: `finish` is replayable, so two finishes can be
 * in flight at once and both read no completion. `Completion.activityId @unique` is what
 * actually settles it, and swallowing its violation is what makes it an answer.
 */
async function logCompletion(
  db: PrismaClient,
  userId: string,
  trailId: string,
  activityId: string,
  completedAt: Date,
): Promise<void> {
  const existing = await db.completion.findUnique({
    where: { activityId },
    select: { id: true },
  });
  if (existing) return;

  const day = new Date(
    Date.UTC(completedAt.getUTCFullYear(), completedAt.getUTCMonth(), completedAt.getUTCDate()),
  );
  try {
    await db.$transaction(async (tx) => {
      await tx.completion.create({ data: { userId, trailId, activityId, completedAt: day } });
      await tx.trail.update({ where: { id: trailId }, data: { popularity: { increment: 1 } } });
    });
  } catch (error) {
    // Somebody else logged it between the read above and the create — the outcome this
    // function wanted. The transaction rolled back, so the popularity increment went with it.
    const clash = error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
    if (!clash) throw error;
  }
}

/** A filename someone can find again, out of a name someone typed. */
function slugForFile(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 60);
  return slug || 'activity';
}

/** One row, always exactly one, from the heatmap aggregate. */
interface HeatmapRow {
  tracks: number;
  suppressed: number;
  passing: number;
  cells: Array<{ cx: number; cy: number; visits: number; hikers: number }>;
}

/**
 * A viewport `getBounds` reported, turned into a box `ST_MakeEnvelope` can express. Two shapes
 * arrive that PostGIS will not take: coordinates past the poles and ±180, and a west edge east
 * of its east edge, which an envelope cannot represent at all. Both widen to the whole world
 * rather than split or clamp — clamping would silently answer a different question, and the
 * cell cap bounds the cost of widening.
 */
function normaliseBox(bbox: BBox | readonly [number, number, number, number]): BBox {
  const [w0, s0, e0, n0] = bbox;
  const s = Math.max(-90, Math.min(90, Math.min(s0, n0)));
  const n = Math.max(-90, Math.min(90, Math.max(s0, n0)));
  if (!(Math.abs(e0 - w0) < 360)) return [-180, s, 180, n];

  const w = wrapLng(Math.min(w0, e0));
  const e = wrapLng(Math.max(w0, e0));
  // Wrapping a box that crossed the date line puts its edges the wrong way round, which is
  // how we detect the crossing after the fact.
  return w > e ? [-180, s, 180, n] : [w, s, e, n];
}

/** A longitude folded back into [-180, 180], the range PostGIS and the lattice both use. */
function wrapLng(lng: number): number {
  if (lng >= -180 && lng <= 180) return lng;
  return ((((lng + 180) % 360) + 360) % 360) - 180;
}
