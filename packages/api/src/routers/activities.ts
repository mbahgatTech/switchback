/**
 * Recording a hike.
 *
 * **Three procedures make a recording, and the middle one is the whole design.** `start`
 * opens a row, `append` sends fixes as they arrive, `finish` closes it. Nothing waits for
 * the end. A phone that dies on the summit, loses signal in a valley, or is closed by iOS
 * to reclaim memory has already uploaded everything up to that moment, and what is left in
 * the database is a shorter hike rather than no hike — which is the difference between an
 * inconvenience and losing the record of a day out.
 *
 * That is also why **every statistic is recomputed here, from the stored samples, on every
 * append**. The client's own running totals are never written. If they were, a recording
 * that ends by the phone dying would have a track and a distance of zero, because the number
 * was going to be sent at the end.
 *
 * **Samples are thinned before they are stored and measured before they are thinned.** In
 * that order, always. Simplification removes the fixes a stationary pause is made of, and
 * those fixes are precisely what moving time is computed from — thin first and a two-hour
 * lunch becomes two hours of hiking. `packages/geo/track.ts` holds the measurement; this
 * file only sequences it.
 *
 * **Elevation is corrected against the DEM at the end.** A phone's barometric or GNSS
 * altitude drifts by tens of metres over a few hours, and ascent computed from it is off by
 * enough to be embarrassing — a flat towpath reporting 300 m of climb. On `finish` the track
 * is sampled against the same terrain tiles the trail profiles use, so a recorded hike and
 * the trail it followed report ascent on the same terms and can honestly be compared.
 * Guarded, because a terrain fetch failing must not lose somebody's hike: the GPS
 * elevations stand, and the recording is saved either way.
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
 * How many recordings a user may have open at once.
 *
 * One, in every sane case — you are on one hike. The cap exists because a client that
 * crashes between `start` and the first `append` leaves an empty open row behind, and
 * without a limit a bad build could accumulate hundreds of them. `start` closes the
 * stragglers rather than refusing, because refusing would mean a user who force-quit the
 * app once can never record again without finding a button nobody has written.
 */
const MAX_OPEN = 1;

/**
 * A recording longer than this is a phone that never stopped, not a hike.
 *
 * Long enough for a very slow multi-day traverse to stay in one recording; short enough
 * that a forgotten session does not grow without bound. Reached, it is closed by `start`
 * rather than deleted — the fixes in it are real.
 */
const MAX_RECORDING_MS = 48 * 60 * 60 * 1000;

/** Samples we will hold for one recording, after thinning. */
const MAX_SAMPLES = 20_000;

const PAGE = 20;
const MAX_PAGE = 50;

/**
 * Heatmap densification, as a fraction of the lattice cell.
 *
 * Sixty per cent: comfortably below one cell, so a straight segment cannot step over a cell
 * without landing in it, and comfortably above a half, so we are not paying for three
 * samples where two would do. This is the Nyquist argument, applied to a grid.
 */
const SPACING_FRACTION = 0.6;

/** Floor on that spacing. Below about 20 m we are resampling GPS noise, not a route. */
const HEATMAP_MIN_SPACING_M = 20;

/** Track left after both endpoint trims for the track to be worth counting at all. */
const HEATMAP_MIN_KEEP_M = 100;

/**
 * Module-level so the tile cache survives between requests on a warm instance. Recordings
 * from the same area — which is most of them, for one user — reuse the same terrain tiles.
 */
const terrain = new TerrainSource();

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

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
    // Your own recordings do not need to tell you whose they are, and leaving the field out
    // keeps a hundred copies of your own avatar off your own list.
    owner: row.userId === viewerId ? null : { ...row.user },
  };
}

/**
 * Whether `viewer` may read this recording.
 *
 * `followers` currently resolves the same as `private` for everyone but the owner, because
 * there is no follow graph yet. That is the safe direction to be wrong in — the alternative
 * is showing a stranger a map of where somebody hikes — and it becomes correct the moment
 * following exists, with no change to any caller.
 */
function canView(row: { userId: string; visibility: string }, viewer: User | null): boolean {
  if (viewer?.id === row.userId) return true;
  return row.visibility === 'public';
}

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

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
 * Recompute the row's statistics from what is stored, and return them.
 *
 * Called after every append and again at finish. The cost is one query and one pass over
 * the samples; the benefit is that the row is never out of step with its own track, whatever
 * happened to the client between the two.
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
 * Replace GPS altitudes with DEM elevations.
 *
 * Returns the fixes unchanged on any failure. Two reasons for that rather than a retry: the
 * correction is an improvement on a number we already have, not a number we are missing, and
 * this runs on the request that ends somebody's hike, where the one unacceptable outcome is
 * an error.
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

  /*
   * `observed` accumulates a plain count while the column is named for an EWMA. That is not
   * an oversight: `blendObservations` normalises the whole surface to its own weekly peak
   * before mixing, so a count and a fixed-α EWMA produce the identical surface. Time decay
   * is the part that would actually differ, and it is worth adding when any trail has enough
   * years of recordings for staleness to be a real effect rather than a hypothetical one.
   */
  await db.busynessBucket.upsert({
    where: { trailId_dayOfWeek_hour: { trailId, dayOfWeek, hour } },
    create: { trailId, dayOfWeek, hour, observed: 1, sampleCount: 1 },
    update: { observed: { increment: 1 }, sampleCount: { increment: 1 } },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const idInput = z.object({ id: z.string().min(1).max(64) });

export const activitiesRouter = router({
  /**
   * Open a recording.
   *
   * `startedAt` comes from the client because the hike started when the user pressed the
   * button, not when the request arrived — those differ by however long the phone spent
   * looking for signal, which on a trailhead can be minutes. It is clamped to the present:
   * a clock set to 2031 would otherwise put the recording at the top of every list forever.
   *
   * **`id` comes from the client too, and that is what makes a hike startable offline.** The
   * device mints a v4 UUID before the first fix and the recording begins on the press rather
   * than on this response; this call is the confirmation. Passing the id in makes it the
   * idempotency key, which is what the retry policy on the other end rests on: a drain that
   * posted a start and lost the answer replays it and gets the same hike back rather than a
   * second one. So the id is looked up before anything is created, and a `P2002` from the
   * create — the same thing arriving twice at once — resolves the same way.
   *
   * A v4 UUID makes collision with a stranger's id cryptographically absent, and the `uuid`
   * check stops anyone squatting a short guessable one; an id that does exist and belongs to
   * somebody else is a conflict rather than an adoption.
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

      // Before the stale sweep, deliberately. A replay must change nothing at all — running
      // the sweep for it would close the very recording it is asking about.
      if (input.id) {
        const replayed = await adopt(input.id);
        if (replayed) return replayed;
      }

      // Close anything left open — a force-quit, a dead battery, a tab shut mid-hike. Closed
      // rather than deleted: whatever fixes it holds are a real hike, just an unfinished one.
      const stale = await ctx.db.activity.findMany({
        where: { userId: ctx.user.id, endedAt: null },
        orderBy: { startedAt: 'desc' },
        select: { id: true, startedAt: true },
      });
      // Only recordings that began no later than this one. A hike recorded offline yesterday
      // and backfilled today would otherwise close the hike being recorded right now, because
      // the sweep keeps the most recent `MAX_OPEN` by start time and the backfill is older.
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
        // Two copies of the same start in flight at once — a drain and a reconnecting tab,
        // say. The lookup above missed because neither had committed yet; the constraint is
        // what actually settles it, and the loser adopts the winner's row.
        const clash =
          error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
        if (!clash || !input.id) throw error;
        const replayed = await adopt(input.id);
        if (replayed) return replayed;
        throw error;
      }
    }),

  /**
   * The recording still open, if there is one.
   *
   * What a refreshed browser tab or a relaunched app asks first. Without it, closing the
   * page mid-hike means the hike is stranded: still open in the database, invisible in the
   * interface, and impossible to finish.
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
   * Send fixes.
   *
   * Idempotent by second: `t` is unique within a recording, so a batch that is retried
   * because its response was lost lands exactly once. That property is what lets the client
   * retry blindly, which is the only retry policy that works on a phone that is going in and
   * out of signal.
   *
   * `start` is now idempotent by id in service of the same policy, and `finish` is replayable,
   * so a hike recorded with no signal can be drained by posting all three blindly and in order
   * however many times it takes. See the note on `start` above.
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
       * Closed by the sweep, not by a person. Reopen it and take the fixes.
       *
       * `syncedAt` is what "the hiker finished this" means — `finish` is the only thing that
       * sets it, and `closeStale` deliberately leaves it null. Everything else that ends a
       * recording is housekeeping: `start` closes every earlier open recording, and `open`
       * closes anything past `MAX_RECORDING_MS`. Refusing an append after that turned a
       * guess about abandonment into permanent data loss, and the loss was silent — a hiker
       * who recorded three hours with no signal, finished at the car, and started a second
       * hike before the first had drained had the sweep close hike one mid-drain, so its
       * remaining fixes could never be appended and its queue row was removed as though it
       * had landed whole. A device still uploading is proof that the recording was not
       * abandoned, and it is proof that arrives at exactly the right moment.
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
   * Close a recording.
   *
   * The one place the elevation correction and the completion both happen, and the only
   * place `syncedAt` is set — which is what the interface reads to know a hike is finished
   * and its numbers are final.
   *
   * Replayable, on purpose: a hike drained from the offline queue may post this more than
   * once if a response is lost. Ending an already-ended recording is allowed, the statistics
   * recompute from the stored samples to the same answer, and the completion is guarded by a
   * unique on `activityId`. The one step that counts rather than sets is the busyness
   * observation, which is why it is gated on the row not already having ended.
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
      // Captured before the update below sets it. A replayed finish must not observe the
      // start a second time — see the note above.
      const alreadyFinished = row.endedAt !== null;

      const trailId = input.trailId === undefined ? row.trailId : input.trailId;
      const stored = await loadFixes(ctx.db, row.id);
      const corrected = await correctElevations(stored);

      // Written back only where the DEM actually changed something, and in one statement
      // rather than a thousand — a six-hour hike is ten thousand rows after thinning.
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
       * than making them remember a second button is the difference between a contact who
       * trusts the page and a contact who has learned that "Overdue" usually means nothing.
       */
      await endLifelineForActivity(ctx.db, row.id, updated.endedAt ?? new Date());

      if (trailId) {
        const wantsCompletion = input.logCompletion ?? true;
        if (wantsCompletion) await logCompletion(ctx.db, ctx.user.id, trailId, row.id, endedAt);
        const trail = await ctx.db.trail.findUnique({
          where: { id: trailId },
          select: { centroidLng: true },
        });
        // Swallowed: a busyness bucket that did not get written costs the model one sample
        // out of thousands, and must not be able to fail the request that ends a hike. Only
        // on the first finish: the bucket is a counter, and a replayed drain would inflate it.
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
   * Delete a recording and everything hanging off it.
   *
   * The completion goes with it. A completion recorded from a hike is a claim that the hike
   * happened; deleting the hike and keeping the claim would leave a date in the completed
   * list with nothing behind it and no way to correct it.
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
        // Never below zero: the counter takes contributions from the lists router too, and a
        // repair that drove it negative would quietly invert the busyness prior.
        await tx.trail.updateMany({
          where: { id: row.completion.trailId, popularity: { gte: 1 } },
          data: { popularity: { decrement: 1 } },
        });
      }
      await tx.activitySample.deleteMany({ where: { activityId: row.id } });
      await tx.activity.delete({ where: { id: row.id } });
    });

    /*
     * The Lifeline the hike was carrying, if any. `activityId` is `SetNull`, so a Lifeline
     * whose recording is deleted keeps running on its own — and goes overdue after dark for a
     * hike that was thrown away in the car park, telling somebody to worry about a person who
     * never set off. Called off rather than completed: nobody claimed to be back. Outside the
     * transaction, and total, so a failure closing it cannot block the delete.
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
        // The owner sees their own private hikes through `mine`; this procedure is the
        // public view and stays public even when the viewer happens to be the owner, so
        // that "view as others see it" is a thing that can be built.
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
        // Deliberately the same answer as a recording that does not exist. "Forbidden" would
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
   * The recording as GPX, for Garmin, Strava, or a shoebox of files.
   *
   * A query returning the document rather than a REST route serving it, so the same call
   * works from the iOS app — which has no download folder to point a browser at and wants
   * the text to hand to the share sheet.
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
   * The same recording as FIT, for a watch.
   *
   * Separate from `gpx` rather than a format parameter on it, because the two differ in what
   * they return — text against base64 bytes — and collapsing them would give every caller a
   * union to narrow for no gain. There are exactly two formats and there is no third coming.
   *
   * Base64 rather than a binary response for the same reason `gpx` returns a string: this is
   * a tRPC query, and the iOS app wants something it can hand to `expo-file-system`, which
   * takes base64 directly. On the web it costs one `atob` before the Blob.
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
      // No description field: FIT has nowhere to put free text that a device will show, so
      // the notes stay with GPX rather than being written somewhere nothing reads them.
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
   * Where people actually hike — every public recording, aggregated onto a fixed lattice.
   *
   * The one map overlay built from our own data rather than from a model or an upstream
   * feed, and the only one whose design is dominated by what it must *not* reveal. The
   * privacy argument lives in `@switchback/core`'s `heatmap` module beside the constants it
   * justifies; what follows is why the query is shaped the way it is.
   *
   * **Every control is in the SQL, not in the renderer.** k-anonymity applied client-side is
   * k-anonymity an attacker can decline by reading the response instead of the picture. No
   * row leaves this procedure that fewer than {@link HEATMAP_MIN_HIKERS} separate people
   * contributed to, and no coordinate leaves it at all — only lattice indices, which the
   * client turns back into rectangles it could have computed itself.
   *
   * **Endpoint clipping happens before viewport clipping, and the order is load-bearing.**
   * `ST_LineSubstring` takes fractions of a line, so trimming 250 m off "the part of the hike
   * you can currently see" would trim 250 m off the edge of the viewport — moving the
   * censored zone around as the reader pans, and leaving the hiker's front door uncensored
   * the moment it sits mid-screen. The trim is computed against the whole track's length,
   * once, and only then is the remainder cut down to what is on screen.
   *
   * **Viewport clipping is what bounds the work.** Without it the Pacific Crest Trail is
   * 4,265 km of line densified at 23 m intervals for a reader looking at one valley of it.
   * With it, cost tracks screen area rather than track length, which is the property that
   * makes the overlay affordable at every zoom.
   *
   * **Densification is additive and never finer than a cell.** `ST_Segmentize` inserts
   * vertices without removing any, so a straight kilometre between two GPS fixes still
   * registers in every cell it crosses; and spacing at 60 % of the cell size means a cell can
   * be missed only if the lattice is finer than the sampling, which by construction it is
   * not. Sampling finer than that would buy nothing but rows.
   */
  heatmap: publicProcedure
    .input(heatmapRequestSchema)
    .query(async ({ ctx, input }): Promise<Heatmap> => {
      const [w, s, e, n] = normaliseBox(input.bbox);
      const step = heatmapStepDeg(input.zoom);
      const spacingM = Math.max(HEATMAP_MIN_SPACING_M, heatmapCellMetres(step) * SPACING_FRACTION);
      // Anything shorter than both trims plus a usable remainder is all endpoint and nothing
      // else, so it is dropped rather than trimmed into a degenerate line.
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
      // row: a viewport where every cell was suppressed still has to be able to say so, and
      // an aggregate over an empty table would otherwise return nothing to say it with.
      const row = rows[0] ?? { tracks: 0, suppressed: 0, passing: 0, cells: [] };
      const cells = row.cells.map((cell) => ({
        // Derived here rather than in SQL: the lattice is `360 / 2^n`, which is exact in
        // binary, so client and server agree on the corners to the last bit — and keeping the
        // arithmetic in one place means the map and the query can never disagree about where
        // a cell is.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Close a recording nobody finished.
 *
 * Its statistics are recomputed on the way out, so an abandoned hike still shows the right
 * distance rather than the zeroes it was created with. `syncedAt` is left null — it means
 * "the hiker finished this", and nobody did.
 */
async function closeStale(db: PrismaClient, activityId: string): Promise<void> {
  const fixes = await loadFixes(db, activityId);
  const stats = summariseTrack(fixes);
  const row = await db.activity.findUnique({
    where: { id: activityId },
    select: { startedAt: true },
  });
  if (!row) return;

  // A recording with no fixes at all is a button pressed by accident. Nothing is lost by
  // deleting it, and leaving it behind puts an empty row at the top of the hiker's list.
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
 * Record that this hike happened, on the same table the completed list reads.
 *
 * Nothing here writes a `TrailListItem` — the completed list derives itself from this table,
 * which is the design decision documented at the top of `routers/lists.ts` and the reason
 * a hike recorded here shows up in the completed tab without either file knowing about
 * the other.
 *
 * The read is an optimisation, not the guard. `finish` is replayable by design and the client
 * drains are triggered by four independent events, so two finishes for one activity can be in
 * flight at once: both read no completion, both enter the transaction, and the loser hits
 * `Completion.activityId @unique` with a P2002 that would otherwise leave the mutation
 * returning a raw Prisma exception as a 500 — for a hike that is, by then, correctly in the
 * account. The unique constraint is the real answer, and swallowing its violation is what
 * makes it an answer rather than an error.
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
    // Somebody else logged it between the read above and the create. That is the outcome this
    // function wanted; the transaction rolled back, so the popularity increment went with it.
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
 * A viewport `getBounds` reported, turned into a box `ST_MakeEnvelope` can express.
 *
 * Two things arrive here that PostGIS will not take. A zoomed-out map reports latitudes past
 * the poles and longitudes past ±180, because Web Mercator keeps going even where the globe
 * does not. And a map straddling the antimeridian reports a west edge east of its east edge,
 * which an envelope cannot represent at all — an envelope is a rectangle in coordinate space,
 * and the box that wraps the date line is two rectangles.
 *
 * Both are widened to the whole world rather than split or clamped. Splitting would mean two
 * queries and two lattices to reconcile for a case that only happens mid-Pacific; clamping
 * would silently answer a different question than the one on screen. Widening answers a
 * larger question honestly, and the cell cap keeps the cost of that bounded.
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
