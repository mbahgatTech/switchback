import { z } from 'zod';
import { publicProfileSchema } from './profile';
import { hikedOnSchema } from './reviews';
import { slugify } from './text';
import { trailSummarySchema } from './types';

/**
 * Lists, favourites and completions — the three ways a trail attaches to a person.
 *
 * They look like one feature and are not, and the distinction is worth stating because
 * getting it wrong is how these products end up with a "Saved" tab nobody understands:
 *
 * **A list is a place to put things.** Favourites and Want to do are lists with the name
 * already filled in; a custom list is one where the user filled it in. There is no
 * behavioural difference beyond that, which is why they are all `TrailList` rows and why
 * the UI can render every tab with the same component.
 *
 * **A completion is a fact about the past.** It has a date, it can happen more than once,
 * and it is not something you can un-save — you can only correct it. That is why it is its
 * own table rather than a fourth list, and why the API for it is `record`/`forget` rather
 * than a toggle.
 *
 * The `completed` list row exists anyway, because every account is provisioned with one and
 * the UI wants a stable id and slug to route to. Its *contents* are read from `Completion`,
 * never from `TrailListItem`. One source of truth, no projection to keep in sync, and a
 * completion logged from a recorded activity in Phase 4 shows up in the list for free.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The lists every account is given, in the order they are always shown.
 *
 * Favourites first because it is the one with a control on every card. Want to do next,
 * because it is the same gesture pointed at the future. Completed last, because it is the
 * only one the user does not put things into directly.
 */
export const SYSTEM_LIST_KINDS = ['favorites', 'want_to_do', 'completed'] as const;
export type SystemListKind = (typeof SYSTEM_LIST_KINDS)[number];

export const LIST_KINDS = [...SYSTEM_LIST_KINDS, 'custom'] as const;
export type ListKind = (typeof LIST_KINDS)[number];

/**
 * The empty-state line for each system list.
 *
 * Written as an instruction, not an apology. An empty screen is the one place a product can
 * say what the feature is for while the user is already looking for that answer.
 */
export const SYSTEM_LIST_EMPTY: Readonly<Record<SystemListKind, string>> = {
  favorites: 'Ring a trail — on a card or on its own page — and it is kept here.',
  want_to_do: 'Somewhere you mean to get to. Add trails as you find them.',
  completed: 'Mark a trail done and it lands here, with the date you hiked it.',
};

/** True when a list is one of the three provisioned per account and cannot be deleted. */
export function isSystemList(kind: ListKind): kind is SystemListKind {
  return kind !== 'custom';
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const LIST_NAME_MAX = 80;
export const LIST_DESCRIPTION_MAX = 600;
/** A note on why *this* trail is in *this* list. A sentence, not a trip report. */
export const LIST_NOTE_MAX = 280;

/**
 * Ceilings, so one account cannot become an ingestion problem for everyone else.
 *
 * Set where a real user will never meet them: a thousand trails is more hiking than a
 * lifetime, and two hundred lists is more than anyone has ever organised anything into.
 * They exist to bound a script, not to shape behaviour.
 */
export const MAX_CUSTOM_LISTS = 200;
export const MAX_ITEMS_PER_LIST = 1_000;

/**
 * How many trail lengths a list card carries for its tally rule.
 *
 * The rule is a picture, not a manifest. Past sixty divisions the hairlines merge into a
 * solid bar and every extra number is bytes on the wire buying nothing, so the card sends
 * the first sixty and the totals beside it stay complete regardless.
 */
export const LIST_TALLY_MAX = 60;

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export const listNameSchema = z
  .string()
  .trim()
  .min(1, 'Give the list a name.')
  .max(LIST_NAME_MAX, `Keep the name under ${LIST_NAME_MAX} characters.`);

export const listCreateSchema = z.object({
  name: listNameSchema,
  description: z.string().trim().max(LIST_DESCRIPTION_MAX).nullish(),
  /**
   * Private by default, and deliberately not a "share" toggle in disguise. Someone building
   * a list of places to take their children has not asked to publish an itinerary.
   */
  isPublic: z.boolean().default(false),
});
export type ListCreate = z.infer<typeof listCreateSchema>;

/**
 * Every field optional, because this backs an inline rename as well as a full edit form.
 *
 * `undefined` leaves a column alone and explicit `null` clears it — the same contract as
 * `profileUpdateSchema`, kept identical on purpose so the two forms behave the same way.
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

/**
 * Logging a hike that already happened.
 *
 * The date is required and is the review's own `hikedOn` schema, unchanged — same format,
 * the same "that date does not exist", the same 1970 floor, and the same one day of slack at
 * the top so a hiker in Auckland can log today's hike while our clock still says yesterday.
 * The two dates mean the identical thing, and a completion that validated differently from
 * the review written about the same hike would be a bug waiting for someone to file it.
 *
 * A completion with no date would be indistinguishable from a favourite, which is the whole
 * point of it having one.
 */
export const completionWriteSchema = z.object({
  trailId: z.string().min(1).max(64),
  completedAt: hikedOnSchema,
});
export type CompletionWrite = z.infer<typeof completionWriteSchema>;

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * Whose list it is.
 *
 * The same four fields a review carries its author by, picked from the public profile for
 * the same reason: a field that stops being public stops appearing here without anyone
 * having to remember this file exists.
 */
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
  /**
   * The first trail's photo, so a list of lists is not a list of grey rectangles. Null when
   * the list is empty or nothing in it has been photographed yet.
   */
  coverPhotoUrl: z.string().url().nullable(),
  /** Total distance of everything in it — the one number that says what kind of list it is. */
  totalLengthM: z.number().nonnegative(),
  totalGainM: z.number().nonnegative(),
  /**
   * Each trail's length, in the order the list shows them, capped at `LIST_TALLY_MAX`.
   *
   * This is what the tally rule is drawn from. It is sent alongside the totals rather than
   * derived from them because the totals cannot say whether a list is one long hike or ten
   * short ones, and that is the thing a reader is actually deciding between.
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
   * For a completed list this is the day they hiked it, and there is one entry per hike —
   * the same trail done three times is three entries, which is the record being honest.
   */
  completedAt: z.string().nullable(),
  /**
   * Which hike this row *is*, on a completed list. Null everywhere else.
   *
   * Without it a row on the completed list has nothing to be removed by: the trail id names
   * three hikes when the reader is trying to correct one of them, and "delete the hike I got
   * the date wrong on" becomes "delete every hike on this trail".
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
 * Everything a trail page needs to draw its save controls in one round trip.
 *
 * One query rather than three, because these render together on every card and every
 * detail page. Three booleans fetched separately is three waterfalls and three chances for
 * the heart to fill in after the button next to it.
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
 * Every trail the caller has marked, as three flat id sets.
 *
 * The index draws a mark on thirty cards at once, and asking `saveState` per card is thirty
 * queries to answer one question. This is the same question asked once: the ids are small,
 * they change only when the person taps something, and one cached copy serves every card on
 * the page — including cards for trails that stream in later from a tile that just landed.
 */
export const savedTrailIdsSchema = z.object({
  favorites: z.array(z.string()),
  wantToDo: z.array(z.string()),
  /** Distinct trails, not hikes. A card shows *whether*; the count belongs on the trail. */
  completed: z.array(z.string()),
});
export type SavedTrailIds = z.infer<typeof savedTrailIdsSchema>;

export const EMPTY_SAVED_IDS: SavedTrailIds = { favorites: [], wantToDo: [], completed: [] };

/**
 * How many ids each set carries.
 *
 * Past this the mark is wrong on a card somewhere far down a very long index, which is a
 * cosmetic miss on the rarest possible account. Sending an unbounded array to every visitor
 * to avoid it is not the better trade.
 */
export const SAVED_IDS_MAX = 5_000;

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

/**
 * A list's URL segment, derived from its name.
 *
 * Deliberately not the trail slugifier from `@switchback/ingest`: that one folds in a
 * region and is tuned for names that came out of OSM. This one runs on text a person just
 * typed, which means it has to survive emoji, a name that is entirely punctuation, and a
 * name in a script with no ASCII at all — hence the fallback rather than an empty string,
 * which would collide with the list route itself.
 */
export function listSlug(name: string): string {
  return slugify(name, 'list');
}
