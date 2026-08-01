import { describe, expect, it } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { ActivityType, TrailCondition, UserRole } from '@switchback/core';
import {
  REPORT_REASONS,
  REPORT_SUBJECTS,
  USER_ROLES,
  canAdminister,
  canModerate,
  profileUpdateSchema,
  reportSubmitSchema,
} from '@switchback/core';
import type { User } from '@switchback/db';
import { profileUpdateData } from '../src/routers/me';
import { ORDER_BY, toReview } from '../src/routers/reviews';
import { appRouter } from '../src/root';
import { createCallerFactory } from '../src/trpc';
import type { Context } from '../src/context';

/**
 * The takedown path, and the escalation it opens if it is built carelessly.
 *
 * A `role` column is a new class of target: before it existed there was nothing on `User`
 * worth stealing beyond `isPlus`, and now there is a column that decides who may delete
 * other people's writing. Two things therefore have to be true and have to *stay* true
 * through every future edit, and neither of them throws when it is broken — a `role` that
 * leaks into a profile update is a silent total compromise, and an admin procedure that
 * checks the role in the client rather than the server looks identical in a screenshot.
 *
 * So the assertions here are deliberately structural rather than behavioural. They do not
 * ask "does this reject the attack I thought of"; they re-derive the set of columns a
 * profile edit can reach and fail if `role` is in it, and they call the real procedures
 * through the real middleware with a real member's context.
 *
 * The third group is the arithmetic: hidden content must leave the aggregates. That one is
 * not a security property, it is a correctness one, and it fails the same way — quietly,
 * permanently, and only in the direction of a number nobody said.
 */

// ---------------------------------------------------------------------------
// A context, with no database behind it
// ---------------------------------------------------------------------------

/**
 * Enough of a `User` to satisfy the middleware, and no more.
 *
 * The role checks read exactly one column, and every procedure they guard throws before
 * touching `ctx.db` — which is why these tests need no Postgres and pass on the machine
 * where the dev database is down. `db` is a proxy that throws on any property access, so a
 * regression that moves a role check *after* a query fails loudly here rather than passing
 * because the query happened to return nothing.
 */
function user(role: UserRole, id = 'usr_member'): User {
  return {
    id,
    name: 'A Hiker',
    email: 'hiker@example.test',
    emailVerified: null,
    image: null,
    username: 'hiker',
    bio: null,
    units: 'metric',
    theme: 'system',
    role,
    isPlus: false,
    plusUntil: null,
    homeLng: null,
    homeLat: null,
    homeName: null,
    defaultActivityVisibility: 'private',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    // Never pressed "sign out everywhere", which is what almost every row says. No role
    // check reads it — it is here because the fixture is a whole `User` and the type says so.
    sessionsRevokedAt: null,
  };
}

const NO_DATABASE = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(
        `The database was reached for "${String(property)}". A role check ran too late.`,
      );
    },
  },
);

function contextFor(role: UserRole | null): Context {
  return {
    db: NO_DATABASE as Context['db'],
    user: role === null ? null : user(role),
    headers: new Headers(),
    authMethod: role === null ? null : 'session',
  };
}

const caller = (role: UserRole | null) => createCallerFactory(appRouter)(contextFor(role));

/** The tRPC error code, or the thrown value itself when it was not a tRPC error. */
async function codeOf(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return 'NO_ERROR';
  } catch (error) {
    return error instanceof TRPCError ? error.code : error;
  }
}

// ---------------------------------------------------------------------------
// A normal user cannot promote themselves
// ---------------------------------------------------------------------------

describe('me.update cannot write role', () => {
  it('never puts role in the update, however the input is polluted', async () => {
    // The attack in its most direct form: post a profile edit with a role on it. Zod is the
    // first line and strips it, and this asserts the second — that even a parsed input
    // carrying extra keys cannot reach the column, because the update is an allow-list of
    // named assignments rather than a spread.
    const hostile = {
      name: 'A Hiker',
      role: 'admin',
      isPlus: true,
      plusUntil: new Date('2099-01-01T00:00:00Z'),
    };

    const parsed = await profileUpdateSchema.parseAsync(hostile);
    expect(Object.keys(parsed)).not.toContain('role');

    // Handed in as-is, extra keys and all. TypeScript permits it because `hostile` is a
    // variable rather than a fresh literal — which is precisely the shape a future refactor
    // that loosened the schema would produce, and precisely why the assertion below is on
    // the returned key set rather than on the compiler having noticed.
    const data = profileUpdateData(hostile);
    expect(Object.keys(data)).not.toContain('role');
    expect(Object.keys(data)).not.toContain('isPlus');
    expect(Object.keys(data)).not.toContain('plusUntil');
    expect(data).toEqual({ name: 'A Hiker' });
  });

  it('reaches only the columns a profile is made of', () => {
    // Re-derived rather than spot-checked. A new field added to the profile form shows up
    // here as a failure and has to be looked at once, which is the moment to notice that
    // an entitlement was about to be added to a self-service endpoint.
    const everything = profileUpdateData({
      name: 'n',
      username: 'u',
      bio: 'b',
      units: 'imperial',
      theme: 'dark',
      defaultActivityVisibility: 'public',
      home: { at: [-1, 51], name: 'Home' },
    } as never);

    expect(Object.keys(everything).sort()).toEqual([
      'bio',
      'defaultActivityVisibility',
      'homeLat',
      'homeLng',
      'homeName',
      'name',
      'theme',
      'units',
      'username',
    ]);
  });

  it('offers the client no way to name a role at all', () => {
    // The schema is the outer wall. A `role` key on it — even optional, even ignored by the
    // resolver — is the shape of the bug, because the next person to write `data: {...input}`
    // would then be one line from shipping it.
    expect(Object.keys(profileUpdateSchema.shape)).not.toContain('role');
  });
});

// ---------------------------------------------------------------------------
// A normal user cannot call an admin procedure
// ---------------------------------------------------------------------------

describe('the moderation procedures are gated on the server', () => {
  const target = { subject: 'review' as const, subjectId: 'rev_1' };

  it('refuses a signed-in member the takedown lever', async () => {
    // The case that matters. This caller is authenticated — a real session, a real row —
    // and simply is not an operator. Hiding the button in the UI is not what stops them;
    // `moderatorProcedure` is, and it runs before the resolver, which is why the throwing
    // database proxy above is never touched.
    expect(await codeOf(caller('member').moderation.hide(target))).toBe('FORBIDDEN');
    expect(await codeOf(caller('member').moderation.unhide(target))).toBe('FORBIDDEN');
    expect(await codeOf(caller('member').moderation.dismiss(target))).toBe('FORBIDDEN');
    expect(await codeOf(caller('member').moderation.queue({}))).toBe('FORBIDDEN');
    expect(await codeOf(caller('member').moderation.operators())).toBe('FORBIDDEN');
  });

  it('refuses a member the role lever', async () => {
    expect(
      await codeOf(caller('member').moderation.setRole({ userId: 'usr_other', role: 'admin' })),
    ).toBe('FORBIDDEN');
  });

  it('refuses a signed-out caller everything but the report box', async () => {
    expect(await codeOf(caller(null).moderation.hide(target))).toBe('UNAUTHORIZED');
    expect(await codeOf(caller(null).moderation.queue({}))).toBe('UNAUTHORIZED');
    expect(
      await codeOf(caller(null).moderation.setRole({ userId: 'usr_other', role: 'admin' })),
    ).toBe('UNAUTHORIZED');
  });

  it('does not let a moderator appoint anybody', async () => {
    // The separation the two tiers exist for. A moderator who can grant roles is an
    // administrator, and the column would then be documenting a distinction the code does
    // not keep — the first operator could quietly become the only one.
    expect(
      await codeOf(caller('moderator').moderation.setRole({ userId: 'usr_other', role: 'admin' })),
    ).toBe('FORBIDDEN');
  });

  it('does not let an administrator change their own role', async () => {
    // Removes the one-call path from "an admin session was taken" to "there are no admins
    // left", and makes the last-administrator problem unreachable by accident.
    const admin = createCallerFactory(appRouter)({
      ...contextFor('admin'),
      user: user('admin', 'usr_admin'),
    });
    expect(await codeOf(admin.moderation.setRole({ userId: 'usr_admin', role: 'member' }))).toBe(
      'FORBIDDEN',
    );
  });
});

describe('canModerate and canAdminister', () => {
  it('grants the takedown lever to exactly two roles', () => {
    expect(USER_ROLES.filter(canModerate)).toEqual(['moderator', 'admin']);
  });

  it('grants the role lever to exactly one', () => {
    expect(USER_ROLES.filter(canAdminister)).toEqual(['admin']);
  });

  it('treats an absent role as a member', () => {
    // The signed-out and not-yet-loaded cases. A helper that answered `undefined` with
    // anything but `false` would hand the lever to every visitor during a null window.
    expect(canModerate(null)).toBe(false);
    expect(canModerate(undefined)).toBe(false);
    expect(canAdminister(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hidden content renders as removed, and leaves the arithmetic
// ---------------------------------------------------------------------------

const REVIEW_ROW = {
  id: 'rev_1',
  trailId: 'trl_1',
  userId: 'usr_ivy',
  rating: 1,
  body: 'The libellous bit.' as string | null,
  hikedOn: new Date('2026-03-14T00:00:00Z') as Date | null,
  conditions: ['muddy'] as TrailCondition[],
  activityType: 'hiking' as ActivityType | null,
  helpfulCount: 3,
  createdAt: new Date('2026-03-15T09:04:00Z'),
  updatedAt: new Date('2026-03-15T09:04:00Z'),
  hiddenAt: null as Date | null,
  user: { id: 'usr_ivy', username: 'ivy', name: 'Ivy Calder', image: null },
  photos: [
    {
      id: 'pho_1',
      url: 'https://photos.example.test/a.webp',
      thumbUrl: null,
      width: 1600,
      height: 1200,
      blurhash: null,
      caption: null,
    },
  ],
};

describe('a hidden review is a tombstone', () => {
  it('still comes back, so the page can say it was removed', () => {
    // Not a 404 and not a silent disappearance. Dropped from the list instead, the report
    // vanishes from under its own author, which reads as a bug rather than as a decision
    // somebody made and can be argued with.
    const shape = toReview({ ...REVIEW_ROW, hiddenAt: new Date() }, 'usr_ivy');
    expect(shape.id).toBe('rev_1');
    expect(shape.hidden).toBe(true);
    expect(shape.isMine).toBe(true);
  });

  it('carries none of what was reported', () => {
    const shape = toReview({ ...REVIEW_ROW, hiddenAt: new Date() }, null);
    expect(shape.body).toBeNull();
    expect(shape.photos).toEqual([]);
    expect(shape.conditions).toEqual([]);
    expect(shape.activityType).toBeNull();

    // The whole row, serialised, must not contain the text somebody complained about — a
    // renderer that forgets to branch on `hidden` should show an empty report, never the
    // prose. This catches a field added to the shape later and not stripped.
    expect(JSON.stringify(shape)).not.toContain('libellous');
  });

  it('carries none of its numbers either', () => {
    /*
     * The half the first pass missed, and the reason the fixture above now has a non-zero
     * `helpfulCount` — pinned at 0 it asserted nothing, and roughly eight in nine seeded
     * reviews carry a real one.
     *
     * `helpfulCount` was not merely published, it was *drawn*: with `activityType` nulled,
     * the footer's `activityType !== null || helpfulCount > 0` condition collapses to the
     * count alone, so a removed report printed "3 found this useful" directly under its own
     * tombstone — the page endorsing the report it had just withdrawn.
     *
     * `rating` was published without being drawn, which is not better. Both renderers
     * declined to draw it, and it still shipped in every `reviews.list` response and still
     * ordered the list, so a tombstone standing first under "Highest rated" announced the
     * withdrawn number to anybody who can count — while `ratingCounts` excluded that same
     * row from the average.
     */
    const shape = toReview({ ...REVIEW_ROW, hiddenAt: new Date() }, null);
    expect(shape.rating).toBeNull();
    expect(shape.helpfulCount).toBe(0);
  });

  it('leaves a visible review completely alone', () => {
    const shape = toReview(REVIEW_ROW, null);
    expect(shape.hidden).toBe(false);
    expect(shape.body).toBe('The libellous bit.');
    expect(shape.photos).toHaveLength(1);
    expect(shape.conditions).toEqual(['muddy']);
    expect(shape.rating).toBe(1);
    expect(shape.helpfulCount).toBe(3);
  });

  it('does not let a sort key rank a tombstone by a number it no longer carries', () => {
    /*
     * Stripping the shape closes half the leak. `toReview` runs after Postgres has sorted,
     * so nulling `rating` changes what the row says and nothing about where it stands — and
     * position is readable without opening the network tab. The three sorts that key on a
     * withdrawn column therefore have to push the tombstones into one block first.
     *
     * `recent` is deliberately exempt: it keys on `createdAt`, which the tombstone prints on
     * its own face, and holding a removed report in its chronological place is the entire
     * point of keeping the row.
     */
    for (const sort of ['rating_desc', 'rating_asc', 'helpful'] as const) {
      expect(Object.keys(ORDER_BY[sort][0]!)).toEqual(['hiddenAt']);
    }
    expect(Object.keys(ORDER_BY.recent[0]!)).toEqual(['createdAt']);
  });
});

// ---------------------------------------------------------------------------
// The report box
// ---------------------------------------------------------------------------

describe('reportSubmitSchema', () => {
  it('takes no reporter id from the wire', () => {
    // A reporter id on the input is a way to file a complaint in somebody else's name. The
    // server reads it from the session and from nowhere else, which is only true as long
    // as there is no field here for it.
    expect(Object.keys(reportSubmitSchema.shape)).not.toContain('reporterId');
    expect(Object.keys(reportSubmitSchema.shape).sort()).toEqual([
      'contactEmail',
      'detail',
      'reason',
      'subject',
      'subjectId',
    ]);
  });

  it('accepts a complaint from somebody with no account and no email', () => {
    // Notice-and-takedown means being able to receive a complaint from the person who found
    // their own front door in a photograph, who is not going to make an account to say so.
    const parsed = reportSubmitSchema.parse({
      subject: 'photo',
      subjectId: 'pho_1',
      reason: 'personal_information',
    });
    expect(parsed.reason).toBe('personal_information');
  });

  it('refuses an address that could not be replied to', () => {
    expect(() =>
      reportSubmitSchema.parse({
        subject: 'photo',
        subjectId: 'pho_1',
        reason: 'other',
        contactEmail: 'not-an-address',
      }),
    ).toThrow();
  });

  it('covers both things a stranger can publish, and nothing else', () => {
    expect([...REPORT_SUBJECTS].sort()).toEqual(['photo', 'review']);
  });

  it('offers a reason for every kind of complaint the queue sorts by', () => {
    expect(REPORT_REASONS).toContain('copyright');
    expect(REPORT_REASONS).toContain('personal_information');
    expect(REPORT_REASONS).toContain('other');
  });
});

// ---------------------------------------------------------------------------
// A takedown survives its own author
// ---------------------------------------------------------------------------

/**
 * A database that answers, rather than one that throws.
 *
 * The proxy above exists to prove role checks run before any query. These four cases are the
 * opposite kind of assertion — they are about what the *resolver* does with what the database
 * says — so they need a stub that returns rows. Still no Postgres: every path under test
 * refuses before it writes anything, which is the property being tested.
 *
 * `$transaction` runs the callback against the same stub, which is what Prisma's interactive
 * transaction does, so a guard that moved inside the transaction would still be caught here.
 */
function dbReturning(answers: Record<string, unknown>): Context['db'] {
  const stub: Record<string, unknown> = {
    $transaction: (work: (tx: unknown) => unknown) => work(stub),
    ...answers,
  };
  return stub as unknown as Context['db'];
}

function callerWith(db: Context['db'], role: UserRole | null = 'member') {
  return createCallerFactory(appRouter)({ ...contextFor(role), db });
}

describe('a moderated author cannot delete their way back to publishing', () => {
  it('refuses to delete a hidden review, and says why', async () => {
    /*
     * The hole this closes. `upsert` refuses to edit a hidden review — but the row is keyed
     * `(trailId, userId)`, so deleting the tombstone frees the key and the very next upsert
     * creates a fresh row with the same prose, no `hiddenAt`, no `hiddenById`, and no reports
     * pointing at it. Two calls, and the takedown is undone by the person it was made about.
     */
    const db = dbReturning({
      review: {
        // The delete carries `hiddenAt: null`, so a hidden row matches nothing.
        deleteMany: () => Promise.resolve({ count: 0 }),
        findUnique: () => Promise.resolve({ hiddenAt: new Date('2026-03-20T00:00:00Z') }),
      },
    });

    expect(await codeOf(callerWith(db).reviews.remove({ trailId: 'trl_1' }))).toBe('FORBIDDEN');
  });

  it('still lets somebody withdraw a review nobody has touched', async () => {
    // The guard must not cost the ordinary case. A visible review deletes, and the aggregate
    // refresh runs on the way out exactly as it always did.
    const db = dbReturning({
      review: {
        deleteMany: () => Promise.resolve({ count: 1 }),
        groupBy: () => Promise.resolve([]),
      },
      trail: { update: () => Promise.resolve({}) },
    });

    await expect(callerWith(db).reviews.remove({ trailId: 'trl_1' })).resolves.toEqual({
      removed: true,
    });
  });

  it('refuses to delete a hidden photograph', async () => {
    /*
     * Same shape, and one more reason: `assertWithinQuota` deliberately counts hidden
     * photographs against the uploader's daily and per-trail allowance, so a delete that went
     * through would hand back the slot and make "upload the taken-down frame again" a single
     * call. The refusal is what keeps the cap a limit rather than a refill.
     */
    const db = dbReturning({
      photo: {
        findUnique: () =>
          Promise.resolve({
            id: 'pho_1',
            userId: 'usr_member',
            trailId: 'trl_1',
            url: 'https://photos.example.test/a.webp',
            thumbUrl: null,
            sourceId: 'abc',
            hiddenAt: new Date('2026-03-20T00:00:00Z'),
          }),
      },
    });

    expect(await codeOf(callerWith(db).photos.remove({ photoId: 'pho_1' }))).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
// The one role check on the read path
// ---------------------------------------------------------------------------

/**
 * `includeHidden` is a request, not a permission.
 *
 * Every other role check in this file guards a *write* and throws when it fails, which makes
 * it loud. This one guards a read, defaults quietly to the public answer, and is the sole
 * expression separating an operator from the public on every trail page render — because
 * `apps/web/app/trails/[slug]/page.tsx` sends `includeHidden: true` on every render for every
 * visitor, signed in or not, and lets the server decide what that means.
 *
 * A review of this PR mutation-tested the branch and found this the only guard the suite did
 * not kill: replacing `input.includeHidden && canModerate(ctx.user?.role)` with
 * `input.includeHidden` left all 1,444 tests green. If that conjunct were ever dropped, every
 * anonymous visitor would get a "Removed" tile per hidden photograph on every trail page,
 * carrying the author's name and username, the coordinates, the distance along the route and
 * the capture date — the fields `toPhoto` does not blank. Repeating the accusation is half of
 * publishing it, which is the whole reason the takedown exists.
 *
 * So the assertion is on the `where` clause rather than on the rows: what matters is that the
 * filter was asked for, and a stub that returns nothing cannot accidentally satisfy it.
 */
describe('includeHidden is honoured for operators and ignored for everybody else', () => {
  function spyingDb(): { seen: Record<string, unknown>[]; db: Context['db'] } {
    const seen: Record<string, unknown>[] = [];
    const db = dbReturning({
      photo: {
        findMany: (args: Record<string, unknown>) => {
          seen.push(args);
          return Promise.resolve([]);
        },
      },
    });
    return { seen, db };
  }

  async function whereFor(role: UserRole | null): Promise<Record<string, unknown>> {
    const { seen, db } = spyingDb();
    await callerWith(db, role).trails.photos({ trailId: 'trl_1', includeHidden: true });
    return (seen.at(-1)?.where ?? {}) as Record<string, unknown>;
  }

  it('filters hidden photographs out for a signed-out caller who asks for them', async () => {
    expect(await whereFor(null)).toMatchObject({ trailId: 'trl_1', hiddenAt: null });
  });

  it('filters them out for an ordinary member who asks for them', async () => {
    // The interesting caller: authenticated, a real row, a real session — and still the
    // public answer. Nothing about being signed in is permission to see a takedown.
    expect(await whereFor('member')).toMatchObject({ trailId: 'trl_1', hiddenAt: null });
  });

  it('lets a moderator through, because unhide lives in that strip', async () => {
    // The other direction, and it is not optional: the photograph strip is where the only
    // `unhide` control is, so a moderator who cannot see a hidden frame cannot put it back —
    // which is the thing /terms promises we do when we got it wrong.
    const where = await whereFor('moderator');
    expect(where).toMatchObject({ trailId: 'trl_1' });
    expect(where).not.toHaveProperty('hiddenAt');
  });

  it('gives an admin the same reach as a moderator', async () => {
    expect(await whereFor('admin')).not.toHaveProperty('hiddenAt');
  });

  it('still filters for a moderator who did not ask', async () => {
    // The flag has to be doing work in both directions. A moderator reading an ordinary
    // trail page gets the ordinary gallery; the hidden rows arrive only where the queue is.
    const { seen, db } = spyingDb();
    await callerWith(db, 'moderator').trails.photos({ trailId: 'trl_1' });
    expect(seen.at(-1)?.where).toMatchObject({ hiddenAt: null });
  });
});

// ---------------------------------------------------------------------------
// The report box has bounds that do not depend on having an account
// ---------------------------------------------------------------------------

describe('moderation.report is bounded for a signed-out caller', () => {
  const complaint = { subject: 'review' as const, subjectId: 'rev_1', reason: 'spam' as const };

  function reportDb(openOnSubject: number, openAnonymous: number, created: string[]) {
    return dbReturning({
      review: { findUnique: () => Promise.resolve({ trailId: 'trl_1' }) },
      contentReport: {
        // First call counts the item's open complaints, second counts the anonymous queue.
        count: ({ where }: { where: { reporterId?: null; subjectId?: string } }) =>
          Promise.resolve(where.subjectId === undefined ? openAnonymous : openOnSubject),
        findFirst: () => Promise.resolve(null),
        create: ({ data }: { data: { subjectId: string } }) => {
          created.push(data.subjectId);
          return Promise.resolve({});
        },
      },
    });
  }

  it('absorbs the fourth open complaint about one item, without writing a row', async () => {
    /*
     * The bound that replaces the one signing out used to skip. Three open complaints about a
     * photograph is already more than an operator needs; the fourth adds a row to read and no
     * information. It answers `{ filed: true }` rather than an error, because "this has been
     * reported three times already" is information about a queue the reporter cannot see.
     */
    const written: string[] = [];
    const anonymous = callerWith(reportDb(3, 0, written), null);

    await expect(anonymous.moderation.report(complaint)).resolves.toEqual({ filed: true });
    expect(written).toEqual([]);
  });

  it('accepts the first three', async () => {
    const written: string[] = [];
    const anonymous = callerWith(reportDb(2, 0, written), null);

    await expect(anonymous.moderation.report(complaint)).resolves.toEqual({ filed: true });
    expect(written).toEqual(['rev_1']);
  });

  it('stops accepting anonymous reports once the queue is deeper than a moderator can read', async () => {
    // The second identity-free bound: a flood spread thinly across many scraped subject ids
    // never reaches the per-item cap, so the anonymous half of the queue has a ceiling of its
    // own. Signed-in reports are counted separately and are never refused by it.
    const written: string[] = [];
    const anonymous = callerWith(reportDb(0, 500, written), null);

    expect(await codeOf(anonymous.moderation.report(complaint))).toBe('TOO_MANY_REQUESTS');
    expect(written).toEqual([]);
  });
});
