/**
 * Work that has to happen exactly once per new account, from whichever door they came in —
 * the website's Auth.js `createUser` event or the native token exchange. Kept here rather than
 * in either one so the two paths cannot drift.
 */
import { ListKind, type PrismaClient } from '@switchback/db';

/**
 * The names are British and the slugs are not, on purpose: the slug is in bookmarked URLs and
 * in a stored enum, the name is text on a card.
 */
const SYSTEM_LISTS = [
  { kind: ListKind.favorites, name: 'Favourites', slug: 'favorites' },
  { kind: ListKind.completed, name: 'Completed', slug: 'completed' },
  { kind: ListKind.want_to_do, name: 'Want to do', slug: 'want-to-do' },
] as const;

/**
 * Create the three lists every account has, up front rather than on first use:
 * `trail_lists_one_system_list_per_user` is a partial unique index, so two concurrent "add to
 * favourites" taps racing to create the same list would be a hard error. `skipDuplicates`
 * makes this idempotent and safe to call on an existing account.
 */
export async function ensureSystemLists(db: PrismaClient, userId: string): Promise<void> {
  await db.trailList.createMany({
    data: SYSTEM_LISTS.map((list) => ({ userId, ...list })),
    skipDuplicates: true,
  });
}
