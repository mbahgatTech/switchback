/**
 * Which accounts were reached by linking on an email address, and which of those are a
 * suspected takeover.
 *
 * Context. `app/api/auth/mobile/exchange/route.ts` links a provider identity onto an existing
 * user when the email matches and the provider vouches for the address. Until now
 * `auth-native.ts` said Entra vouched for every address it sent, which was wrong — Entra's
 * `email` claim is a tenant-mutable directory attribute, we sign against `/common`, and a
 * free tenant is minutes of work. So the guard that was supposed to stop silent linking was
 * unreachable for the only provider production has enabled, and anybody could have been
 * merged onto anybody's account. That is closed: Entra is now never verified.
 *
 * **What this script is for, corrected.** It used to say that removing the branch would strand
 * the people it lists, and gate the removal on migrating them first. That was wrong, and the
 * route says so plainly: `prisma.account.create` sits after the inner if/else, inside the outer
 * `else`, so it runs on the *link* path as well as the create path. Every identity ever linked
 * by email therefore already has an `Account` row keyed on (provider, providerAccountId), and
 * its next sign-in resolves through the `existing` lookup at the top of the route and never
 * reaches the email branch again. Deleting `if (byEmail) { userId = byEmail.id }` cannot take
 * an account away from anybody. What it changes is only which *future* unknown-sub sign-ins are
 * allowed to link.
 *
 * So this is not a blocker count. It is a list of links that were already made, and the reason
 * to read it is that for one provider each of those links is the takeover the fix now prevents:
 *
 * - **`microsoft-entra-id`** — the link rested on a claim we now know is forgeable, from the
 *   provider the attack was written against. Every such row is a *suspected takeover* and
 *   wants reviewing and reversing, not cementing.
 * - **anything else** (`apple`) — the link rested on `email_verified` that Apple asserts and
 *   controls. Ordinary account linking, nothing to do.
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
 * The heuristic errs toward calling a row a link, which is the safe direction for something
 * whose output is "look at this by hand".
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

/**
 * The provider whose `email` claim was never worth trusting.
 *
 * `auth-native.ts` now sets `emailVerified: false` for it unconditionally, so no new row can
 * be created this way. The ones already here were.
 */
const FORGEABLE_EMAIL_PROVIDER = 'microsoft-entra-id';

async function main(): Promise<void> {
  const host = new URL(process.env.DATABASE_URL ?? 'postgres://unset/').host;
  console.log(`reading ${host}\n`);

  const native = await prisma.account.findMany({
    where: NATIVE_ACCOUNT,
    select: { id: true, userId: true, provider: true },
  });

  if (native.length === 0) {
    console.log('No accounts were created by the native exchange route.');
    console.log('Nothing can have been linked by email. Nothing to review.');
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

  const suspect = linked.filter((account) => account.provider === FORGEABLE_EMAIL_PROVIDER);
  const benign = linked.filter((account) => account.provider !== FORGEABLE_EMAIL_PROVIDER);

  const byProvider = new Map<string, number>();
  for (const account of linked) {
    byProvider.set(account.provider, (byProvider.get(account.provider) ?? 0) + 1);
  }

  console.log(`native accounts:        ${native.length}`);
  console.log(`  first sign-ins:       ${fresh}  (created their own user — not a link)`);
  console.log(`  linked by email:      ${linked.length}`);
  for (const [provider, count] of [...byProvider].sort()) {
    const flag = provider === FORGEABLE_EMAIL_PROVIDER ? '  ← suspected takeover' : '';
    console.log(`    ${provider.padEnd(18)}${count}${flag}`);
  }

  if (linked.length === 0) {
    console.log('\nNothing was ever linked by email. Nothing to review.');
    return;
  }

  /*
   * The ids, not the addresses. This is a report an operator reads out of a terminal and may
   * paste into an issue; a list of users' email addresses does not belong in either.
   */
  if (suspect.length > 0) {
    console.log(`\nSUSPECTED TAKEOVER — ${suspect.length} link${plural(suspect.length)} on:`);
    for (const account of suspect) console.log(`  user ${account.userId}  account ${account.id}`);
    console.log(
      `\nEach of these bolted a ${FORGEABLE_EMAIL_PROVIDER} identity onto an existing user on\n` +
        "the strength of that provider's `email` claim — the claim this branch's fix says must\n" +
        'never be trusted, from the only provider production has enabled. Treat every one as an\n' +
        'account somebody else may have joined themselves to.\n' +
        '\n' +
        'For each: confirm with the account holder that they own that Microsoft identity. If\n' +
        "they do not, delete the `Account` row above and revoke that user's refresh tokens\n" +
        "(`me.signOutEverywhere` does both halves for the user's own session; from the operator\n" +
        'side it is a delete plus a `mobileRefreshToken.updateMany({ revokedAt })`).\n' +
        '\n' +
        'Do NOT "migrate" these by writing the identity onto the user deliberately. That is what\n' +
        'an earlier version of this script said, and on these rows it makes the takeover\n' +
        'permanent instead of reversing it.',
    );
  }

  if (benign.length > 0) {
    const users = [...new Set(benign.map((account) => account.userId))];
    console.log(
      `\nOrdinary links — ${benign.length} on ${users.length} user${plural(users.length)}:`,
    );
    for (const account of benign) {
      console.log(`  user ${account.userId}  ${account.provider}`);
    }
    console.log(
      '\nThese rested on an `email_verified` the provider asserts and controls. No action.',
    );
  }

  console.log(
    '\nNone of the above blocks removing the email-linking branch. Every identity listed here\n' +
      'already has its own `Account` row and resolves through the (provider, providerAccountId)\n' +
      'lookup, so removal cannot strand anybody. What removal changes is which future sign-ins\n' +
      'with an unrecognised `sub` are allowed to link — and the forward-looking cost of that is\n' +
      'an Entra user whose browser account carries a different `sub`, who is now permanently\n' +
      '409ed with a message promising "this device will be added to it". That is the number\n' +
      'worth counting before the branch goes; this script does not count it.',
  );
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

void main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
