import { z } from 'zod';
import { USER_ROLES } from './moderation';
import { UNIT_SYSTEMS } from './units';
import { lngLatSchema } from './types';

/** Profile shapes shared by both clients, so the web and iOS forms apply the same rules before a
 * request is made. The server re-validates with the same schema — this is a courtesy, not a
 * control. */

/** Visibility of a user's own content. Mirrors the `Visibility` enum in the schema. */
export const VISIBILITIES = ['private', 'followers', 'public'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** Light, dark, or whatever the device says. Mirrors the `ThemePreference` enum in the schema.
 * `system` is stored rather than collapsed at write time, so a reader who has never chosen keeps
 * following their device. Distinct from `Scheme` in `packages/ui`, which the page picks. */
export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];

/** Handles appear in profile URLs, so the constraints are as much about routing as taste: no
 * slashes, no dots that read as a file extension, no leading or trailing separators, and a floor
 * of three characters so `/u/a` is not a namespace of its own. */
export const usernameSchema = z
  .string()
  .min(3, 'At least 3 characters.')
  .max(30, 'At most 30 characters.')
  .regex(
    /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/,
    'Lowercase letters, numbers, hyphens and underscores; must start and end with a letter or number.',
  );

/** Handles the app itself needs, or that would be confusing to hand out. Checked
 * case-insensitively against the lowercased handle, which the schema already guarantees. */
export const RESERVED_USERNAMES = new Set([
  'about',
  'account',
  'admin',
  'api',
  'app',
  'attribution',
  'auth',
  'blog',
  'contact',
  'explore',
  'help',
  'legal',
  'list',
  'lists',
  'login',
  'logout',
  'map',
  'me',
  'new',
  'plus',
  'privacy',
  'profile',
  'root',
  'search',
  'settings',
  'signin',
  'signout',
  'signup',
  'support',
  'switchback',
  'terms',
  'trail',
  'trails',
  'u',
  'user',
  'users',
]);

export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username.toLowerCase());
}

export const profileUpdateSchema = z.object({
  name: z.string().trim().min(1).max(80).nullish(),
  username: usernameSchema.nullish(),
  bio: z.string().trim().max(500).nullish(),
  units: z.enum(UNIT_SYSTEMS).optional(),
  theme: z.enum(THEME_PREFERENCES).optional(),
  defaultActivityVisibility: z.enum(VISIBILITIES).optional(),
  /** Where "near me" points before location permission is granted. One nested object because all
   * three move together: a coordinate with no label is unrenderable, the reverse unsearchable. */
  home: z.object({ at: lngLatSchema, name: z.string().trim().min(1).max(120) }).nullish(),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/** A user as shown to other people. Deliberately excludes email and Plus status. */
export const publicProfileSchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  bio: z.string().nullable(),
  createdAt: z.date(),
});
export type PublicProfile = z.infer<typeof publicProfileSchema>;

/** The signed-in user's view of themselves, with the fields only they should see. */
export const selfProfileSchema = publicProfileSchema.extend({
  email: z.string().nullable(),
  units: z.enum(UNIT_SYSTEMS),
  theme: z.enum(THEME_PREFERENCES),
  defaultActivityVisibility: z.enum(VISIBILITIES),
  isPlus: z.boolean(),
  plusUntil: z.date().nullable(),
  /**
   * Whether this account can take content down. On the *self* profile only — who the moderators
   * are is not something a trail page publishes. Read-only in every direction:
   * `profileUpdateSchema` has no such field and the server ignores it inbound, so a client that
   * lies about it only draws itself buttons that return FORBIDDEN.
   */
  role: z.enum(USER_ROLES),
  home: z.object({ at: lngLatSchema, name: z.string().nullable() }).nullable(),
});
export type SelfProfile = z.infer<typeof selfProfileSchema>;
