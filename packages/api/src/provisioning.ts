/**
 * Work that has to happen exactly once per new account, from whichever door they came in.
 *
 * There are two: the website's Auth.js `createUser` event, and the native token exchange.
 * Keeping this here rather than in either one is what stops the two paths from drifting —
 * an account created on the phone should be indistinguishable from one created in a
 * browser.
 */
import { ListKind, type PrismaClient } from '@switchback/db';

/**
 * The names are British and the slugs are not, and that is on purpose. The slug is in URLs
 * people have already bookmarked and in an enum the database stores; the name is text on a
 * card, and it should match the word the control beside it uses.
 */
const SYSTEM_LISTS = [
  { kind: ListKind.favorites, name: 'Favourites', slug: 'favorites' },
  { kind: ListKind.completed, name: 'Completed', slug: 'completed' },
  { kind: ListKind.want_to_do, name: 'Want to do', slug: 'want-to-do' },
] as const;

/**
 * Create the three lists every account has.
 *
 * Up front, not on first use: `trail_lists_one_system_list_per_user` is a partial unique
 * index, so two concurrent "add to favourites" taps racing to create the same list would
 * be a hard error rather than a harmless duplicate. Doing it at the one moment the user
 * provably has no lists removes the race instead of handling it.
 *
 * `skipDuplicates` makes it idempotent, so it is safe to call on an existing account.
 */
export async function ensureSystemLists(db: PrismaClient, userId: string): Promise<void> {
  await db.trailList.createMany({
    data: SYSTEM_LISTS.map((list) => ({ userId, ...list })),
    skipDuplicates: true,
  });
}
