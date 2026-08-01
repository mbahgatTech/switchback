/**
 * Lists accounts that were reached by linking on an email address, and flags which of those
 * are a suspected takeover.
 *
 *   npx tsx --env-file-if-exists=.env scripts/report-email-linked-accounts.ts
 *
 * Read-only; writes nothing and takes no flags. A `microsoft-entra-id` link rested on a claim
 * now known to be forgeable (a tenant-mutable directory attribute, signed against `/common`)
 * and wants reviewing and reversing. Any other provider's link rested on an `email_verified`
 * that provider asserts and controls — ordinary linking, nothing to do.
 *
 * No column records that a link happened, so it is read off the shape of the rows: the native
 * exchange route writes an `Account` with four fields and no tokens, while the Auth.js Prisma
 * adapter — the only other writer of this table — always stores the provider's token set. A
 * tokenless `type = 'oidc'` row sitting *beside another account on the same user* is a link;
 * one that is the user's only account is an ordinary first sign-in. The heuristic errs toward
 * calling a row a link, which is the safe direction for a "look at this by hand" report.
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
 * `auth-native.ts` now sets `emailVerified: false` for this provider unconditionally, so no
 * new row can be created this way. The ones already here were.
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

  // One query for the sibling count rather than one per account.
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

  // Ids, not addresses: this report gets pasted into issues.
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
