import { z } from 'zod';
import { publicProfileSchema } from './profile';
import { hikedOnSchema } from './reviews';
import { slugify } from './text';
import { trailSummarySchema } from './types';

/**
 * Lists, favourites and completions. Favourites and Want to do are `TrailList` rows with the
 * name pre-filled, so every tab renders with one component. A completion is a fact about the
 * past: dated, repeatable, its own table. The `completed` list row exists only to give the UI a
 * stable id and slug — its contents come from `Completion`, never from `TrailListItem`.
 */

/** The lists every account is given, in the order they are always shown. */
export const SYSTEM_LIST_KINDS = ['favorites', 'want_to_do', 'completed'] as const;
export type SystemListKind = (typeof SYSTEM_LIST_KINDS)[number];

export const LIST_KINDS = [...SYSTEM_LIST_KINDS, 'custom'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/** The empty-state line for each system list, written as an instruction rather than an apology. */
export const SYSTEM_LIST_EMPTY: Readonly<Record<SystemListKind, string>> = {
  favorites: 'Ring a trail — on a card or on its own page — and it is kept here.',
  want_to_do: 'Somewhere you mean to get to. Add trails as you find them.',
  completed: 'Mark a trail done and it lands here, with the date you hiked it.',
};

/** True when a list is one of the three provisioned per account and cannot be deleted. */
export function isSystemList(kind: ListKind): kind is SystemListKind {
  return kind !== 'custom';
}

export const LIST_NAME_MAX = 80;
export const LIST_DESCRIPTION_MAX = 600;
/** A note on why *this* trail is in *this* list. A sentence, not a trip report. */
export const LIST_NOTE_MAX = 280;

/** Ceilings set where a real user will never meet them. They bound a script, not behaviour. */
export const MAX_CUSTOM_LISTS = 200;
export const MAX_ITEMS_PER_LIST = 1_000;

/** How many trail lengths a list card carries. Past sixty the tally rule reads as a solid bar. */
export const LIST_TALLY_MAX = 60;

export const listNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the list a name.')
  .max(LIST_NAME_MAX, `Keep the name under ${LIST_NAME_MAX} characters.`);

export const listCreateSchema = z.object({
  name: listNameSchema,
  description: z.string().trim().max(LIST_DESCRIPTION_MAX).nullish(),
  /** Private by default. Someone listing places to take their children has not asked to publish. */
  isPublic: z.boolean().default(false),
});
export type ListCreate = z.infer<typeof listCreateSchema>;

/**
 * Every field optional, so this backs an inline rename as well as a full edit form. `undefined`
 * leaves a column alone, explicit `null` clears it — the same contract as `profileUpdateSchema`.
 */
export const listUpdateSchema = z.object({
  listId: z.string().min(1).max(64),
  name: listNameSchema.optional(),
  description: z.string().trim().max(LIST_DESCRIPTION_MAX).nullish(),
  isPublic: z.boolean().optional(),
});
export type ListUpdate = z.infer<typeof listUpdateSchema>;

export const listItemWriteSchema = z.object({
  listId: z.string().min(1).max(64),
  trailId: z.string().min(1).max(64),
  note: z.string().trim().max(LIST_NOTE_MAX).nullish(),
});
export type ListItemWrite = z.infer<typeof listItemWriteSchema>;

/** Logging a past hike. The date reuses the review's `hikedOn`: the two mean the same thing. */
export const completionWriteSchema = z.object({
  trailId: z.string().min(1).max(64),
  completedAt: hikedOnSchema,
});
export type CompletionWrite = z.infer<typeof completionWriteSchema>;

/** Whose list it is. Picked from the public profile, as `reviewAuthorSchema` is. */
export const listOwnerSchema = publicProfileSchema.pick({
  id: true,
  username: true,
  name: true,
  image: true,
});
export type ListOwner = z.infer<typeof listOwnerSchema>;

export const listSummarySchema = z.object({
  id: z.string(),
  kind: z.enum(LIST_KINDS),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  isPublic: z.boolean(),
  trailCount: z.number().int().nonnegative(),
  /** The first trail's photo. Null when the list is empty or nothing in it is photographed. */
  coverPhotoUrl: z.string().url().nullable(),
  /** Total distance of everything in it — the one number that says what kind of list it is. */
  totalLengthM: z.number().nonnegative(),
  totalGainM: z.number().nonnegative(),
  /**
   * Each trail's length, in display order, capped at `LIST_TALLY_MAX`. Sent alongside the
   * totals, which cannot say whether a list is one long hike or ten short ones.
   */
  lengths: z.array(z.number().nonnegative()),
  owner: listOwnerSchema,
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type ListSummary = z.infer<typeof listSummarySchema>;

export const listItemSchema = z.object({
  trail: trailSummarySchema,
  note: z.string().nullable(),
  addedAt: z.date(),
  /**
   * On a completed list, the day they hiked it — one entry per hike, so the same trail done
   * three times is three entries.
   */
  completedAt: z.string().nullable(),
  /**
   * Which hike this row is, on a completed list. Null everywhere else. Without it the trail id
   * names three hikes when the reader is trying to correct one of them.
   */
  completionId: z.string().nullable(),
});
export type ListItem = z.infer<typeof listItemSchema>;

export const listDetailSchema = listSummarySchema.extend({
  items: z.array(listItemSchema),
  /** True when the caller owns it, which is what unlocks renaming and removal. */
  isMine: z.boolean(),
});
export type ListDetail = z.infer<typeof listDetailSchema>;

/**
 * Everything a trail page needs to draw its save controls, in one round trip. Three booleans
 * fetched separately is three waterfalls and three chances for the heart to fill in late.
 */
export const trailSaveStateSchema = z.object({
  favorite: z.boolean(),
  wantToDo: z.boolean(),
  /** How many times they have hiked it. Zero is "not completed". */
  completedCount: z.number().int().nonnegative(),
  /** `YYYY-MM-DD` of the most recent hike, or null. */
  lastCompletedAt: z.string().nullable(),
  /** Ids of the caller's *custom* lists holding this trail. */
  listIds: z.array(z.string()),
});
export type TrailSaveState = z.infer<typeof trailSaveStateSchema>;

/** Signed out, nothing is saved. Shared so the client and the server agree on the shape. */
export const EMPTY_SAVE_STATE: TrailSaveState = {
  favorite: false,
  wantToDo: false,
  completedCount: 0,
  lastCompletedAt: null,
  listIds: [],
};

/**
 * Every trail the caller has marked, as three flat id sets. The index draws a mark on thirty
 * cards at once, so one cached copy serves them all — including cards streamed in later.
 */
export const savedTrailIdsSchema = z.object({
  favorites: z.array(z.string()),
  wantToDo: z.array(z.string()),
  /** Distinct trails, not hikes. A card shows *whether*; the count belongs on the trail. */
  completed: z.array(z.string()),
});
export type SavedTrailIds = z.infer<typeof savedTrailIdsSchema>;

export const EMPTY_SAVED_IDS: SavedTrailIds = { favorites: [], wantToDo: [], completed: [] };

/** How many ids each set carries. Past this a mark is wrong far down a very long index. */
export const SAVED_IDS_MAX = 5_000;

/**
 * A list's URL segment. Not the trail slugifier from `@switchback/ingest`, which folds in a
 * region and is tuned for OSM names; this runs on text a person typed, so it needs the
 * fallback — an empty string would collide with the list route itself.
 */
export function listSlug(name: string): string {
  return slugify(name, 'list');
}
