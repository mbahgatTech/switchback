/**
 * Lists, favourites and completions.
 *
 * **One table backs three ideas, and one of them is derived.** Favourites, Want to do and every
 * custom list are `TrailList` rows with `TrailListItem` children. The `completed` list is a
 * `TrailList` row whose children are never written — its contents are read from the
 * `Completion` table on the way out, because a completion is dated and repeatable and because
 * `activities.finish` writes completions without going anywhere near this router. Holding its
 * own rows would mean every one of those paths remembering to keep them in step.
 *
 * **`Trail.popularity` is maintained here**, and only from completions: the reviews router
 * leaves it alone because `packages/busyness/prior.ts` counts reviews separately, and saves and
 * favourites do not touch it — wanting to go somewhere is not evidence that anyone was there.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  EMPTY_SAVED_IDS,
  EMPTY_SAVE_STATE,
  LIST_NOTE_MAX,
  LIST_TALLY_MAX,
  MAX_CUSTOM_LISTS,
  MAX_ITEMS_PER_LIST,
  SAVED_IDS_MAX,
  SYSTEM_LIST_KINDS,
  completionWriteSchema,
  listCreateSchema,
  listSlug,
  listUpdateSchema,
} from '@switchback/core';
import type {
  ListDetail,
  ListItem,
  ListSummary,
  SavedTrailIds,
  SystemListKind,
  TrailSaveState,
} from '@switchback/core';
import { Prisma } from '@switchback/db';
import type { PrismaClient, TrailList, User } from '@switchback/db';
import { ensureSystemLists } from '../provisioning';
import { summarySelect, toSummary } from '../trail-shape';
import { deliberateServerError, protectedProcedure, publicProcedure, router } from '../trpc';

/** A list, minus its items. `user` rides along because a public list is read by non-owners. */
const listSelect = {
  id: true,
  userId: true,
  kind: true,
  name: true,
  slug: true,
  description: true,
  isPublic: true,
  createdAt: true,
  updatedAt: true,
  user: { select: { id: true, username: true, name: true, image: true } },
} satisfies Prisma.TrailListSelect;

export type ListRow = Prisma.TrailListGetPayload<{ select: typeof listSelect }>;

/** The order the system lists are always shown in, as a rank for sorting. */
const SYSTEM_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  SYSTEM_LIST_KINDS.map((kind, index) => [kind, index]),
);

const listKeyInput = z.object({ key: z.string().min(1).max(80) });
const trailIdInput = z.object({ trailId: z.string().min(1).max(64) });

/** What a list card shows without opening the list. */
export interface ListAggregate {
  count: number;
  lengthM: number;
  gainM: number;
  coverPhotoUrl: string | null;
  /** Each trail's length in list order, capped — the divisions of the tally rule. */
  lengths: number[];
}

const EMPTY_AGGREGATE: ListAggregate = {
  count: 0,
  lengthM: 0,
  gainM: 0,
  coverPhotoUrl: null,
  lengths: [],
};

interface AggregateRow {
  listId: string;
  count: number;
  lengthM: number;
  gainM: number;
  cover: string | null;
  lengths: number[];
}

/**
 * The upper bound of the `lengths` array slice, spliced into SQL rather than bound: a Postgres
 * array subscript is not a value expression a parameter can fill, and this is a compile-time
 * constant, so `Prisma.raw` on it is exactly as safe as typing the number.
 */
const TALLY_SLICE = Prisma.raw(String(LIST_TALLY_MAX));

/**
 * Count, distance, ascent and a cover photo for every list at once. Raw SQL because Prisma's
 * `groupBy` cannot aggregate a column on the joined table, so the alternative loads every item
 * of every list into Node. The cover is the first photographed trail in list order —
 * `array_agg` ordered by position with nulls stripped, then its head — computed inside the same
 * aggregate to avoid a second pass over the join.
 */
async function aggregateLists(
  db: PrismaClient,
  listIds: readonly string[],
): Promise<Map<string, ListAggregate>> {
  const found = new Map<string, ListAggregate>();
  if (listIds.length === 0) return found;

  const rows = await db.$queryRaw<AggregateRow[]>`
    SELECT i."listId"                            AS "listId",
           COUNT(*)::int                         AS "count",
           COALESCE(SUM(t."lengthM"), 0)::float8 AS "lengthM",
           COALESCE(SUM(t."gainM"), 0)::float8   AS "gainM",
           (array_remove(
              array_agg(COALESCE(p."thumbUrl", p."url") ORDER BY i."position", i."addedAt"),
              NULL))[1]                          AS "cover",
           (array_agg(t."lengthM" ORDER BY i."position", i."addedAt"))[1:${TALLY_SLICE}]
                                                 AS "lengths"
    FROM trail_list_items i
    JOIN trails t ON t.id = i."trailId"
    LEFT JOIN photos p ON p.id = t."primaryPhotoId"
    WHERE i."listId" IN (${Prisma.join([...listIds])})
    GROUP BY i."listId"
  `;

  for (const row of rows) {
    found.set(row.listId, {
      count: row.count,
      lengthM: Math.round(row.lengthM),
      gainM: Math.round(row.gainM),
      coverPhotoUrl: row.cover,
      lengths: row.lengths ?? [],
    });
  }
  return found;
}

/**
 * The same four numbers for the completed list, read from `Completion`. Every hike counts, not
 * every trail: forty laps of the same 12 km loop is 480 km, and a total saying 12 is describing
 * the map rather than the person.
 */
async function aggregateCompletions(db: PrismaClient, userId: string): Promise<ListAggregate> {
  const rows = await db.$queryRaw<Omit<AggregateRow, 'listId'>[]>`
    SELECT COUNT(*)::int                         AS "count",
           COALESCE(SUM(t."lengthM"), 0)::float8 AS "lengthM",
           COALESCE(SUM(t."gainM"), 0)::float8   AS "gainM",
           (array_remove(
              array_agg(COALESCE(p."thumbUrl", p."url") ORDER BY c."completedAt" DESC),
              NULL))[1]                          AS "cover",
           (array_agg(t."lengthM" ORDER BY c."completedAt" DESC))[1:${TALLY_SLICE}]
                                                 AS "lengths"
    FROM completions c
    JOIN trails t ON t.id = c."trailId"
    LEFT JOIN photos p ON p.id = t."primaryPhotoId"
    WHERE c."userId" = ${userId}
  `;
  const row = rows[0];
  if (!row) return EMPTY_AGGREGATE;
  return {
    count: row.count,
    lengthM: Math.round(row.lengthM),
    gainM: Math.round(row.gainM),
    coverPhotoUrl: row.cover,
    lengths: row.lengths ?? [],
  };
}

export function toSummaryShape(row: ListRow, aggregate: ListAggregate): ListSummary {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    slug: row.slug,
    description: row.description,
    isPublic: row.isPublic,
    trailCount: aggregate.count,
    coverPhotoUrl: aggregate.coverPhotoUrl,
    totalLengthM: aggregate.lengthM,
    totalGainM: aggregate.gainM,
    lengths: aggregate.lengths,
    owner: {
      id: row.user.id,
      username: row.user.username,
      name: row.user.name,
      image: row.user.image,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** System lists in their fixed order, then custom lists most-recently-touched first. */
export function inDisplayOrder(rows: ListRow[]): ListRow[] {
  return [...rows].sort((a, b) => {
    const rankA = SYSTEM_RANK[a.kind] ?? Number.MAX_SAFE_INTEGER;
    const rankB = SYSTEM_RANK[b.kind] ?? Number.MAX_SAFE_INTEGER;
    if (rankA !== rankB) return rankA - rankB;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  });
}

/** A calendar date out of a `DateTime`, sliced at UTC so it survives the round trip. */
export function toDateString(value: Date): string {
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

/**
 * Resolve the URL segment a list page was opened with. `/lists/favorites` is the caller's own
 * system list by the slug every account shares; `/lists/cmxyz…` is a specific list by id, which
 * is what a shared link looks like, because a slug is only unique within one account. Slugs are
 * tried first and only for the signed-in caller, so a stranger's "favorites" cannot be reached
 * by guessing a word.
 */
async function resolveList(
  db: PrismaClient,
  key: string,
  viewer: User | null,
): Promise<ListRow | null> {
  if (viewer) {
    const own = await db.trailList.findUnique({
      where: { userId_slug: { userId: viewer.id, slug: key } },
      select: listSelect,
    });
    if (own) return own;
  }
  return db.trailList.findUnique({ where: { id: key }, select: listSelect });
}

/** The caller's own list, or a 404. Used by every write path. */
async function ownListOrThrow(
  db: PrismaClient,
  listId: string,
  userId: string,
): Promise<Pick<TrailList, 'id' | 'kind' | 'slug'>> {
  const list = await db.trailList.findUnique({
    where: { id: listId },
    select: { id: true, kind: true, slug: true, userId: true },
  });
  // A list belonging to someone else answers exactly as one that does not exist, so this
  // endpoint cannot be used to find out whether a given id is real.
  if (!list || list.userId !== userId) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'No such list.' });
  }
  return list;
}

/**
 * A slug for a new list that no other list of theirs already holds. Suffixed rather than
 * rejected: two lists both called "Lakes" is a reasonable thing to want.
 */
async function uniqueSlug(db: PrismaClient, userId: string, name: string): Promise<string> {
  const base = listSlug(name);
  const taken = new Set(
    (
      await db.trailList.findMany({
        where: { userId, slug: { startsWith: base } },
        select: { slug: true },
      })
    ).map((row) => row.slug),
  );
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  // A thousand lists sharing one name is past every cap above; fall back to something that
  // cannot collide rather than looping forever.
  return `${base}-${Date.now().toString(36)}`;
}

/** Append to the end of a list. */
async function nextPosition(db: PrismaClient, listId: string): Promise<number> {
  const last = await db.trailListItem.findFirst({
    where: { listId },
    select: { position: true },
    orderBy: { position: 'desc' },
  });
  return (last?.position ?? -1) + 1;
}

/** The trail exists — so a bad id is a 404 rather than a foreign-key 500. */
async function assertTrail(db: PrismaClient, trailId: string): Promise<void> {
  const trail = await db.trail.findUnique({ where: { id: trailId }, select: { id: true } });
  if (!trail) throw new TRPCError({ code: 'NOT_FOUND', message: 'No such trail.' });
}

export const listsRouter = router({
  /**
   * Every list the caller has. Provisioning runs first and is idempotent, so an account made
   * before system lists existed heals itself the first time someone opens the page instead of
   * showing an empty screen no button can fix.
   */
  mine: protectedProcedure.query(async ({ ctx }): Promise<ListSummary[]> => {
    await ensureSystemLists(ctx.db, ctx.user.id);

    const rows = await ctx.db.trailList.findMany({
      where: { userId: ctx.user.id },
      select: listSelect,
    });

    const itemLists = rows.filter((row) => row.kind !== 'completed').map((row) => row.id);
    const [aggregates, completed] = await Promise.all([
      aggregateLists(ctx.db, itemLists),
      aggregateCompletions(ctx.db, ctx.user.id),
    ]);

    return inDisplayOrder(rows).map((row) =>
      toSummaryShape(
        row,
        row.kind === 'completed' ? completed : (aggregates.get(row.id) ?? EMPTY_AGGREGATE),
      ),
    );
  }),

  /**
   * One list and everything in it. Public, because a public list is meant to be openable
   * without an account. A private list answers 404 rather than 403 to a stranger, as
   * `ownListOrThrow` does.
   */
  detail: publicProcedure.input(listKeyInput).query(async ({ ctx, input }): Promise<ListDetail> => {
    const row = await resolveList(ctx.db, input.key, ctx.user);
    const isMine = row !== null && ctx.user !== null && row.userId === ctx.user.id;
    if (!row || (!row.isPublic && !isMine)) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'No such list.' });
    }

    if (row.kind === 'completed') {
      const completions = await ctx.db.completion.findMany({
        where: { userId: row.userId },
        select: { id: true, completedAt: true, createdAt: true, trail: { select: summarySelect } },
        orderBy: [{ completedAt: 'desc' }, { createdAt: 'desc' }],
        take: MAX_ITEMS_PER_LIST,
      });
      const items: ListItem[] = completions.map((completion) => ({
        trail: toSummary(completion.trail),
        note: null,
        addedAt: completion.createdAt,
        completedAt: toDateString(completion.completedAt),
        completionId: completion.id,
      }));
      return {
        ...toSummaryShape(row, await aggregateCompletions(ctx.db, row.userId)),
        items,
        isMine,
      };
    }

    const [rows, aggregates] = await Promise.all([
      ctx.db.trailListItem.findMany({
        where: { listId: row.id },
        select: { note: true, addedAt: true, trail: { select: summarySelect } },
        orderBy: [{ position: 'asc' }, { addedAt: 'asc' }],
        take: MAX_ITEMS_PER_LIST,
      }),
      aggregateLists(ctx.db, [row.id]),
    ]);

    const items: ListItem[] = rows.map((item) => ({
      trail: toSummary(item.trail),
      note: item.note,
      addedAt: item.addedAt,
      completedAt: null,
      completionId: null,
    }));

    return {
      ...toSummaryShape(row, aggregates.get(row.id) ?? EMPTY_AGGREGATE),
      items,
      isMine,
    };
  }),

  /**
   * Every way one trail is attached to the caller, in a single round trip. Public, answering
   * `EMPTY_SAVE_STATE` when signed out: a card that branches on an error code to decide whether
   * to draw an empty heart is a card that flickers.
   */
  saveState: publicProcedure
    .input(trailIdInput)
    .query(async ({ ctx, input }): Promise<TrailSaveState> => {
      const viewer = ctx.user;
      if (!viewer) return EMPTY_SAVE_STATE;

      const [memberships, completions] = await Promise.all([
        ctx.db.trailListItem.findMany({
          where: { trailId: input.trailId, list: { userId: viewer.id } },
          select: { list: { select: { id: true, kind: true } } },
        }),
        ctx.db.completion.findMany({
          where: { trailId: input.trailId, userId: viewer.id },
          select: { completedAt: true },
          orderBy: { completedAt: 'desc' },
        }),
      ]);

      const first = completions[0];
      return {
        favorite: memberships.some((row) => row.list.kind === 'favorites'),
        wantToDo: memberships.some((row) => row.list.kind === 'want_to_do'),
        completedCount: completions.length,
        lastCompletedAt: first ? toDateString(first.completedAt) : null,
        listIds: memberships.filter((row) => row.list.kind === 'custom').map((row) => row.list.id),
      };
    }),

  /**
   * The same question as `saveState`, asked once for the whole index — thirty cards each
   * calling `saveState` is thirty queries arriving at thirty different moments, filling a
   * column of hearts in one by one. Public and empty when signed out, for the same reason.
   */
  savedIds: publicProcedure.query(async ({ ctx }): Promise<SavedTrailIds> => {
    const viewer = ctx.user;
    if (!viewer) return EMPTY_SAVED_IDS;

    const [memberships, completions] = await Promise.all([
      ctx.db.trailListItem.findMany({
        where: { list: { userId: viewer.id, kind: { in: ['favorites', 'want_to_do'] } } },
        select: { trailId: true, list: { select: { kind: true } } },
        take: SAVED_IDS_MAX,
      }),
      ctx.db.completion.findMany({
        where: { userId: viewer.id },
        select: { trailId: true },
        // Hikes collapse to trails here: the card says whether, the trail page says how often.
        distinct: ['trailId'],
        take: SAVED_IDS_MAX,
      }),
    ]);

    return {
      favorites: memberships
        .filter((row) => row.list.kind === 'favorites')
        .map((row) => row.trailId),
      wantToDo: memberships
        .filter((row) => row.list.kind === 'want_to_do')
        .map((row) => row.trailId),
      completed: completions.map((row) => row.trailId),
    };
  }),

  create: protectedProcedure.input(listCreateSchema).mutation(async ({ ctx, input }) => {
    const count = await ctx.db.trailList.count({
      where: { userId: ctx.user.id, kind: 'custom' },
    });
    if (count >= MAX_CUSTOM_LISTS) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `You can keep up to ${MAX_CUSTOM_LISTS} lists.`,
      });
    }

    const row = await ctx.db.trailList.create({
      data: {
        userId: ctx.user.id,
        kind: 'custom',
        name: input.name,
        slug: await uniqueSlug(ctx.db, ctx.user.id, input.name),
        description: input.description?.trim() || null,
        isPublic: input.isPublic,
      },
      select: listSelect,
    });
    return toSummaryShape(row, EMPTY_AGGREGATE);
  }),

  /**
   * Rename, describe, publish. A system list can be described and published but not renamed:
   * "Favourites" is what the ring on every card puts things into, and letting it drift makes
   * that control point at a name nobody recognises.
   */
  update: protectedProcedure.input(listUpdateSchema).mutation(async ({ ctx, input }) => {
    const list = await ownListOrThrow(ctx.db, input.listId, ctx.user.id);

    const data: Prisma.TrailListUpdateInput = {};
    if (input.name !== undefined) {
      if (list.kind !== 'custom') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This list cannot be renamed.' });
      }
      data.name = input.name;
      data.slug = await uniqueSlug(ctx.db, ctx.user.id, input.name);
    }
    if (input.description !== undefined) data.description = input.description?.trim() || null;
    if (input.isPublic !== undefined) data.isPublic = input.isPublic;

    const row = await ctx.db.trailList.update({
      where: { id: list.id },
      data,
      select: listSelect,
    });
    const aggregates =
      row.kind === 'completed'
        ? await aggregateCompletions(ctx.db, ctx.user.id)
        : ((await aggregateLists(ctx.db, [row.id])).get(row.id) ?? EMPTY_AGGREGATE);
    return toSummaryShape(row, aggregates);
  }),

  /** Delete a custom list. The three provisioned ones stay, empty. */
  remove: protectedProcedure
    .input(z.object({ listId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const list = await ownListOrThrow(ctx.db, input.listId, ctx.user.id);
      if (list.kind !== 'custom') {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'This list cannot be deleted.' });
      }
      // Items go with it: `TrailListItem.list` cascades on delete.
      await ctx.db.trailList.delete({ where: { id: list.id } });
      return { removed: true };
    }),

  /**
   * Put a trail in a list. Idempotent by way of the `(listId, trailId)` unique index — adding
   * twice updates the note and leaves the position alone, so a double tap does not reorder.
   */
  addTrail: protectedProcedure
    .input(
      z.object({
        listId: z.string().min(1).max(64),
        trailId: z.string().min(1).max(64),
        note: z.string().trim().max(LIST_NOTE_MAX).nullish(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const list = await ownListOrThrow(ctx.db, input.listId, ctx.user.id);
      if (list.kind === 'completed') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Completed is built from the hikes you log. Mark the trail done instead.',
        });
      }
      await assertTrail(ctx.db, input.trailId);

      const count = await ctx.db.trailListItem.count({ where: { listId: list.id } });
      if (count >= MAX_ITEMS_PER_LIST) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `A list holds up to ${MAX_ITEMS_PER_LIST} trails.`,
        });
      }

      const note = input.note?.trim() || null;
      await ctx.db.trailListItem.upsert({
        where: { listId_trailId: { listId: list.id, trailId: input.trailId } },
        create: {
          listId: list.id,
          trailId: input.trailId,
          position: await nextPosition(ctx.db, list.id),
          note,
        },
        update: { note },
      });
      // Touch the list so "recently updated" ordering means what it says.
      await ctx.db.trailList.update({ where: { id: list.id }, data: { updatedAt: new Date() } });
      return { added: true };
    }),

  removeTrail: protectedProcedure
    .input(z.object({ listId: z.string().min(1).max(64), trailId: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const list = await ownListOrThrow(ctx.db, input.listId, ctx.user.id);
      const { count } = await ctx.db.trailListItem.deleteMany({
        where: { listId: list.id, trailId: input.trailId },
      });
      return { removed: count > 0 };
    }),

  /**
   * The heart, and the one next to it. A single toggle rather than add/remove, so the client
   * need not know the current state to know what to send; returns where it landed so the button
   * can settle on the truth rather than on its optimistic guess.
   */
  toggle: protectedProcedure
    .input(
      z.object({
        trailId: z.string().min(1).max(64),
        kind: z.enum(['favorites', 'want_to_do']),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<{ saved: boolean }> => {
      await assertTrail(ctx.db, input.trailId);
      await ensureSystemLists(ctx.db, ctx.user.id);

      const kind: SystemListKind = input.kind;
      const list = await ctx.db.trailList.findFirst({
        where: { userId: ctx.user.id, kind },
        select: { id: true },
      });
      if (!list) {
        // Marked, so the error formatter leaves the sentence alone: `save-controls.tsx`
        // renders `error.message` raw, and the generic 500 copy says nothing about lists.
        throw deliberateServerError('Your saved lists are missing.');
      }

      const existing = await ctx.db.trailListItem.findUnique({
        where: { listId_trailId: { listId: list.id, trailId: input.trailId } },
        select: { id: true },
      });

      if (existing) {
        await ctx.db.trailListItem.delete({ where: { id: existing.id } });
        return { saved: false };
      }

      await ctx.db.trailListItem.create({
        data: {
          listId: list.id,
          trailId: input.trailId,
          position: await nextPosition(ctx.db, list.id),
        },
      });
      await ctx.db.trailList.update({ where: { id: list.id }, data: { updatedAt: new Date() } });
      return { saved: true };
    }),

  /**
   * Log a hike. Repeatable on purpose — the same trail on two dates is two rows — but the same
   * date twice is very likely a double submit, so that one case is collapsed.
   */
  recordCompletion: protectedProcedure
    .input(completionWriteSchema)
    .mutation(async ({ ctx, input }) => {
      await assertTrail(ctx.db, input.trailId);
      const completedAt = new Date(`${input.completedAt}T00:00:00Z`);

      return ctx.db.$transaction(async (tx) => {
        const duplicate = await tx.completion.findFirst({
          where: { userId: ctx.user.id, trailId: input.trailId, completedAt },
          select: { id: true },
        });
        if (duplicate) return { recorded: false, completionId: duplicate.id };

        const row = await tx.completion.create({
          data: { userId: ctx.user.id, trailId: input.trailId, completedAt },
          select: { id: true },
        });
        // Evidence that someone was actually there — see the note at the top of this file.
        await tx.trail.update({
          where: { id: input.trailId },
          data: { popularity: { increment: 1 } },
        });
        return { recorded: true, completionId: row.id };
      });
    }),

  /**
   * Take a hike back out of the record: by id when correcting one entry of several, or by trail
   * to clear the lot, which is what un-ticking "I've done this" means on a trail page.
   */
  forgetCompletion: protectedProcedure
    .input(
      z
        .object({
          completionId: z.string().min(1).max(64).optional(),
          trailId: z.string().min(1).max(64).optional(),
        })
        .refine((value) => Boolean(value.completionId ?? value.trailId), {
          message: 'Say which completion to forget.',
        }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const doomed = await tx.completion.findMany({
          where: {
            userId: ctx.user.id,
            ...(input.completionId ? { id: input.completionId } : {}),
            ...(input.trailId ? { trailId: input.trailId } : {}),
          },
          select: { id: true, trailId: true },
        });
        if (doomed.length === 0) return { removed: 0 };

        await tx.completion.deleteMany({ where: { id: { in: doomed.map((row) => row.id) } } });

        // Give the popularity back, per trail, and never below zero — the counter also takes
        // contributions from recorded activities, and a repair that drove it negative would
        // quietly invert the busyness prior for that trail.
        const perTrail = new Map<string, number>();
        for (const row of doomed) perTrail.set(row.trailId, (perTrail.get(row.trailId) ?? 0) + 1);
        for (const [trailId, n] of perTrail) {
          await tx.trail.updateMany({
            where: { id: trailId, popularity: { gte: n } },
            data: { popularity: { decrement: n } },
          });
        }
        return { removed: doomed.length };
      });
    }),
});
