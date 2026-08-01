/**
 * Hikers: the public profile, and what somebody's record adds up to.
 *
 * **Everything here is derived at read time.** There is no `user.totalDistanceM` column and
 * deliberately never will be — a stored total has to be kept true across a corrected completion
 * date, a deleted trail, a re-ingested length and a recording that writes a completion without
 * touching this file. The queries below are index scans on
 * `completions_userId_completedAt_idx`.
 *
 * **The privacy line runs between the aggregate and the itinerary.** Totals, records and the
 * cadence strip render for anyone; the list of individual hikes is gated on the `completed`
 * list's own `isPublic` flag, the same switch that governs it everywhere else. `hikesVisible` is
 * returned so the page can say why the hikes are absent.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import type { HikeMonth, HikeRecord, HikeRegion, HikerProfile, HikerStats } from '@switchback/core';
import { CADENCE_MONTHS, TOP_REGIONS, cadenceMonths, fillCadence } from '@switchback/core';
import { Prisma } from '@switchback/db';
import type { PrismaClient } from '@switchback/db';
import { publicProcedure, router } from '../trpc';

interface TotalsRow {
  hikes: number;
  trails: number;
  lengthM: number;
  gainM: number;
  estimatedTimeS: number;
  firstHike: Date | null;
  lastHike: Date | null;
}

interface RecordRow {
  kind: 'longest' | 'steepest' | 'highest';
  trailId: string;
  trailName: string;
  trailSlug: string;
  completedAt: Date;
  valueM: number | null;
}

interface MonthRow {
  month: string;
  hikes: number;
  lengthM: number;
  gainM: number;
}

interface RegionRow {
  region: string | null;
  hikes: number;
  lengthM: number;
}

/** `YYYY-MM-DD` in UTC, matching how `completedAt` was stored. */
function toDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function toRecord(row: RecordRow | undefined): HikeRecord | null {
  // A null measurement is a trail whose ingest never produced that figure. "The highest point
  // you have reached: 0 m" would be a claim nobody made.
  if (!row || row.valueM === null) return null;
  return {
    trailId: row.trailId,
    trailName: row.trailName,
    trailSlug: row.trailSlug,
    completedAt: toDateString(row.completedAt),
    valueM: Math.round(row.valueM),
  };
}

/**
 * Everything a hiker's record adds up to. Five queries rather than one, run concurrently:
 * Postgres would scan the same index three or four times for a single statement anyway, so only
 * the round trips are saved, and `Promise.all` saves those.
 *
 * Exported so `me.stats` and `users.byUsername` cannot drift — the number on your own profile
 * and the number a stranger reads must come from the same code.
 */
export async function hikerStats(
  db: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<HikerStats> {
  // The oldest month the cadence strip covers, as a timestamp the index can range-scan.
  const oldest = cadenceMonths(now, CADENCE_MONTHS)[0] ?? '1970-01';
  const since = new Date(`${oldest}-01T00:00:00.000Z`);

  const [totals, records, months, regions, reviews, photos] = await Promise.all([
    db.$queryRaw<TotalsRow[]>`
      SELECT COUNT(*)::int                                  AS "hikes",
             COUNT(DISTINCT c."trailId")::int               AS "trails",
             COALESCE(SUM(t."lengthM"), 0)::float8          AS "lengthM",
             COALESCE(SUM(t."gainM"), 0)::float8            AS "gainM",
             COALESCE(SUM(t."estimatedTimeS"), 0)::float8   AS "estimatedTimeS",
             MIN(c."completedAt")                           AS "firstHike",
             MAX(c."completedAt")                           AS "lastHike"
      FROM completions c
      JOIN trails t ON t.id = c."trailId"
      WHERE c."userId" = ${userId}
    `,

    // Ties break on the earlier hike, so a record keeps the date it was actually set on rather
    // than jumping to the most recent repeat of the same trail.
    db.$queryRaw<RecordRow[]>`
      (SELECT 'longest'::text AS "kind", t.id AS "trailId", t.name AS "trailName",
              t.slug AS "trailSlug", c."completedAt", t."lengthM"::float8 AS "valueM"
         FROM completions c JOIN trails t ON t.id = c."trailId"
        WHERE c."userId" = ${userId}
        ORDER BY t."lengthM" DESC NULLS LAST, c."completedAt" ASC LIMIT 1)
      UNION ALL
      (SELECT 'steepest'::text, t.id, t.name, t.slug, c."completedAt", t."gainM"::float8
         FROM completions c JOIN trails t ON t.id = c."trailId"
        WHERE c."userId" = ${userId}
        ORDER BY t."gainM" DESC NULLS LAST, c."completedAt" ASC LIMIT 1)
      UNION ALL
      (SELECT 'highest'::text, t.id, t.name, t.slug, c."completedAt", t."maxEleM"::float8
         FROM completions c JOIN trails t ON t.id = c."trailId"
        WHERE c."userId" = ${userId}
        ORDER BY t."maxEleM" DESC NULLS LAST, c."completedAt" ASC LIMIT 1)
    `,

    db.$queryRaw<MonthRow[]>`
      SELECT to_char(c."completedAt", 'YYYY-MM')     AS "month",
             COUNT(*)::int                           AS "hikes",
             COALESCE(SUM(t."lengthM"), 0)::float8   AS "lengthM",
             COALESCE(SUM(t."gainM"), 0)::float8     AS "gainM"
      FROM completions c
      JOIN trails t ON t.id = c."trailId"
      WHERE c."userId" = ${userId} AND c."completedAt" >= ${since}
      GROUP BY 1
    `,

    db.$queryRaw<RegionRow[]>`
      SELECT t."regionName"                          AS "region",
             COUNT(*)::int                           AS "hikes",
             COALESCE(SUM(t."lengthM"), 0)::float8   AS "lengthM"
      FROM completions c
      JOIN trails t ON t.id = c."trailId"
      WHERE c."userId" = ${userId}
      GROUP BY 1
      ORDER BY 2 DESC, 3 DESC
      LIMIT ${TOP_REGIONS}
    `,

    // A hiker's totals count what is still standing: content a moderator removed is not a
    // contribution any more.
    db.review.count({ where: { userId, hiddenAt: null } }),
    db.photo.count({ where: { userId, hiddenAt: null } }),
  ]);

  return shapeStats({ totals, records, months, regions, reviews, photos, now });
}

/** Everything `hikerStats` reads, before it is shaped. */
export interface StatsRows {
  totals: readonly TotalsRow[];
  records: readonly RecordRow[];
  months: readonly MonthRow[];
  regions: readonly RegionRow[];
  reviews: number;
  photos: number;
  now: Date;
}

/**
 * The rows, turned into the thing a page renders. Separated from the queries so it can be
 * tested against every awkward shape Postgres returns without a database.
 *
 * Metres are rounded here and only here: `SUM(t."lengthM")` over forty hikes carries a float
 * tail that renders as `310000.00000000006`, and rounding at the display layer would mean
 * rounding it in the web app, the iOS app, and every export.
 */
export function shapeStats({
  totals,
  records,
  months,
  regions,
  reviews,
  photos,
  now,
}: StatsRows): HikerStats {
  const row = totals[0];
  const byKind = new Map(records.map((record) => [record.kind, record]));

  const present = new Map<string, Omit<HikeMonth, 'month'>>(
    months.map((month) => [
      month.month,
      { hikes: month.hikes, lengthM: Math.round(month.lengthM), gainM: Math.round(month.gainM) },
    ]),
  );

  return {
    hikes: row?.hikes ?? 0,
    trails: row?.trails ?? 0,
    lengthM: Math.round(row?.lengthM ?? 0),
    gainM: Math.round(row?.gainM ?? 0),
    estimatedTimeS: Math.round(row?.estimatedTimeS ?? 0),

    longest: toRecord(byKind.get('longest')),
    steepest: toRecord(byKind.get('steepest')),
    highest: toRecord(byKind.get('highest')),

    firstHike: row?.firstHike ? toDateString(row.firstHike) : null,
    lastHike: row?.lastHike ? toDateString(row.lastHike) : null,

    months: fillCadence(present, now),
    regions: regions.map((region): HikeRegion => ({
      region: region.region,
      hikes: region.hikes,
      lengthM: Math.round(region.lengthM),
    })),

    reviews,
    photos,
  };
}

// ---------------------------------------------------------------------------
// Lists on a profile
// ---------------------------------------------------------------------------

interface ProfileListRow {
  id: string;
  name: string;
  slug: string;
  kind: string;
  trailCount: number;
  totalLengthM: number;
  coverPhotoUrl: string | null;
}

/**
 * The lists to show on a profile, with their totals. Published lists only for a stranger, every
 * list for the owner. The completed list is excluded whatever its flag says: its four numbers
 * are already the headline of the page.
 */
async function profileLists(
  db: PrismaClient,
  userId: string,
  isMe: boolean,
): Promise<HikerProfile['lists']> {
  const visibility = isMe ? Prisma.empty : Prisma.sql`AND l."isPublic" = true`;

  const rows = await db.$queryRaw<ProfileListRow[]>`
    SELECT l.id, l.name, l.slug, l.kind::text                     AS "kind",
           COUNT(i.id)::int                                       AS "trailCount",
           COALESCE(SUM(t."lengthM"), 0)::float8                  AS "totalLengthM",
           (array_remove(
              array_agg(COALESCE(p."thumbUrl", p."url") ORDER BY i."position", i."addedAt"),
              NULL))[1]                                           AS "coverPhotoUrl"
    FROM trail_lists l
    LEFT JOIN trail_list_items i ON i."listId" = l.id
    LEFT JOIN trails t           ON t.id = i."trailId"
    LEFT JOIN photos p           ON p.id = t."primaryPhotoId"
    WHERE l."userId" = ${userId} AND l.kind <> 'completed' ${visibility}
    GROUP BY l.id
    ORDER BY l.kind = 'custom', l."updatedAt" DESC
  `;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    trailCount: row.trailCount,
    totalLengthM: Math.round(row.totalLengthM),
    coverPhotoUrl: row.coverPhotoUrl,
  }));
}

const profileSelect = {
  id: true,
  username: true,
  name: true,
  image: true,
  bio: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

type ProfileRow = Prisma.UserGetPayload<{ select: typeof profileSelect }>;

/**
 * A profile needs a username to have a URL, so an account that has never set one has no public
 * page — the right default for an account created by clicking "Sign in with Microsoft".
 */
async function findByUsername(db: PrismaClient, username: string): Promise<ProfileRow> {
  const user = await db.user.findFirst({
    // Usernames are stored as typed and matched case-insensitively, so `/u/Coldbeck` and
    // `/u/coldbeck` are one person rather than one person and one 404.
    where: { username: { equals: username, mode: 'insensitive' } },
    select: profileSelect,
  });
  if (!user) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such hiker.' });
  return user;
}

export const usersRouter = router({
  /** One hiker's public page. Public: a profile nobody can link to is barely a profile. */
  byUsername: publicProcedure
    .input(z.object({ username: z.string().min(1).max(30) }))
    .query(async ({ ctx, input }): Promise<HikerProfile> => {
      const user = await findByUsername(ctx.db, input.username);
      const isMe = ctx.user !== null && ctx.user.id === user.id;

      const [stats, lists, completed] = await Promise.all([
        hikerStats(ctx.db, user.id),
        profileLists(ctx.db, user.id, isMe),
        ctx.db.trailList.findFirst({
          where: { userId: user.id, kind: 'completed' },
          select: { id: true, slug: true, isPublic: true },
        }),
      ]);

      const hikesVisible = isMe || (completed?.isPublic ?? false);

      return {
        profile: {
          id: user.id,
          username: user.username,
          name: user.name,
          image: user.image,
          bio: user.bio,
          createdAt: user.createdAt,
        },
        stats,
        lists,
        // An absent list means the account predates provisioning; treated as private.
        hikesVisible,
        // A list resolves by slug for its owner and by id for everyone else, so the key is
        // decided here: `/lists/completed` read by a stranger is their own completed list,
        // which is the wrong page and looks like working software.
        completedKey: hikesVisible && completed ? (isMe ? completed.slug : completed.id) : null,
        isMe,
      };
    }),
});
