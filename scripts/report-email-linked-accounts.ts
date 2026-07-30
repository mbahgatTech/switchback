/**
 * How many accounts were reached by linking on an email address, and are therefore at risk
 * from removing that branch.
 *
 * Context. `app/api/auth/mobile/exchange/route.ts` links a provider identity onto an existing
 * user when the email matches and the provider vouches for the address. Until now
 * `auth-native.ts` said Entra vouched for every address it sent, which was wrong — Entra's
 * `email` claim is a tenant-mutable directory attribute, we sign against `/common`, and a
 * free tenant is minutes of work. So the guard that was supposed to stop silent linking was
 * unreachable for the only provider production has enabled, and anybody could have been
 * merged onto anybody's account. That is closed: Entra is now never verified.
 *
 * What is *not* closed is the branch itself, and it must not be closed blind. Any account
 * that was reached through it would, on removal, stop resolving — the next sign-in would
 * create a fresh empty user, and the person would appear to have lost every activity, review
 * and list they had. So: count first, delete later. This script is the count.
 *
 *   npx tsx --env-file-if-exists=.env scripts/report-email-linked-accounts.ts
 *
 * Read-only. It writes nothing and takes no flags.
 *
 * **How a linked account is recognised.** There is no column that records it, so it is read
 * off the shape of the rows. The native exchange route creates its `Account` with four fields
 * and no tokens; the Auth.js Prisma adapter, which is the only other thing that writes this
 * table, always stores the provider's token set. So a `type = 'oidc'` account with every
 * token column null was written by the exchange route. Of those:
 *
 * - one sitting **beside another account on the same user** is a link. The user already
 *   existed under a different identity, and this row was bolted on by email.
 * - one that is **the user's only account** is an ordinary first sign-in: the same call that
 *   wrote it created the user.
 *
 * The first number is the one that blocks removal. The second is noise and is printed only so
 * the two are not confused with each other.
 */
import { prisma } from '@switchback/db';

/** Written by `exchange/route.ts`: four fields, no tokens. */
const NATIVE_ACCOUNT = {
  type: 'oidc',
  refresh_token: null,
  access_token: null,
  id_token: null,
  scope: null,
} as const;

async function main(): Promise<void> {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://unset/').host;
  console.log(`reading ${host}\n`);

  const native = await prisma.account.findMany({
    where: NATIVE_ACCOUNT,
    select: { id: true, userId: true, provider: true },
  });

  if (native.length === 0) {
    console.log('No accounts were created by the native exchange route.');
    console.log('Nothing can have been linked by email. The branch is safe to remove.');
    return;
  }

  /*
   * One query for the sibling count rather than one per account: this table is small today
   * and would still be small at a hundred times the size, but a per-row query here is the
   * kind of thing that gets copied into somewhere it is not.
   */
  const userIds = [...new Set(native.map((account) => account.userId))];
  const siblings = await prisma.account.groupBy({
    by: ['userId'],
    where: { userId: { in: userIds } },
    _count: { _all: true },
  });
  const accountsPerUser = new Map(siblings.map((row) => [row.userId, row._count._all]));

  const linked = native.filter((account) => (accountsPerUser.get(account.userId) ?? 1) > 1);
  const fresh = native.length - linked.length;

  const byProvider = new Map<string, number>();
  for (const account of linked) {
    byProvider.set(account.provider, (byProvider.get(account.provider) ?? 0) + 1);
  }

  console.log(`native accounts:        ${native.length}`);
  console.log(`  first sign-ins:       ${fresh}  (created their own user — not a link)`);
  console.log(`  linked by email:      ${linked.length}`);
  for (const [provider, count] of [...byProvider].sort()) {
    console.log(`    ${provider.padEnd(18)}${count}`);
  }

  if (linked.length === 0) {
    console.log('\nNobody is relying on the email-linking branch. It can be removed.');
    return;
  }

  /*
   * The ids, not the addresses. This is a report an operator reads out of a terminal and may
   * paste into an issue; a list of users' email addresses does not belong in either.
   */
  const affected = [...new Set(linked.map((account) => account.userId))];
  console.log(`\n${affected.length} user${affected.length === 1 ? '' : 's'} would be affected:`);
  for (const id of affected) console.log(`  ${id}`);
  console.log(
    '\nEach of these has a provider identity that only resolves through the email-linking\n' +
      'branch. Removing it without migrating them first turns their next sign-in into a new,\n' +
      'empty account. Migrate by writing the second identity onto the user deliberately, or\n' +
      'by asking them to re-link from the web, before the branch goes.',
  );
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
