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
 * The takedown path, and the escalation it opens if it is built carelessly. Both properties
 * fail silently when broken — a `role` that leaks into a profile update is a total compromise,
 * and a role check done in the client looks identical in a screenshot — so the assertions here
 * are structural rather than behavioural: they re-derive the set of columns a profile edit can
 * reach, and they call the real procedures through the real middleware.
 */

/**
 * Enough of a `User` to satisfy the middleware, and no more. `db` is a proxy that throws on any
 * property access, so a regression that moves a role check *after* a query fails loudly here
 * rather than passing because the query returned nothing.
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
    // No role check reads this; it is here because the fixture is a whole `User`.
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

describe('me.update cannot write role', () => {
  it('never puts role in the update, however the input is polluted', async () => {
    const hostile = {
      name: 'A Hiker',
      role: 'admin',
      isPlus: true,
      plusUntil: new Date('2099-01-01T00:00:00Z'),
    };

    const parsed = await profileUpdateSchema.parseAsync(hostile);
    expect(Object.keys(parsed)).not.toContain('role');

    // Handed in as-is, extra keys and all: TypeScript permits it because `hostile` is a
    // variable rather than a fresh literal, which is the shape a refactor that loosened the
    // schema would produce — hence asserting on the returned key set, not on the compiler.
    const data = profileUpdateData(hostile);
    expect(Object.keys(data)).not.toContain('role');
    expect(Object.keys(data)).not.toContain('isPlus');
    expect(Object.keys(data)).not.toContain('plusUntil');
    expect(data).toEqual({ name: 'A Hiker' });
  });

  it('reaches only the columns a profile is made of', () => {
    // Re-derived rather than spot-checked: a new field on the profile form shows up here as a
    // failure and has to be looked at once.
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
    expect(Object.keys(profileUpdateSchema.shape)).not.toContain('role');
  });
});

describe('the moderation procedures are gated on the server', () => {
  const target = { subject: 'review' as const, subjectId: 'rev_1' };

  it('refuses a signed-in member the takedown lever', async () => {
    // `moderatorProcedure` runs before the resolver, which is why the throwing database proxy
    // is never touched.
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
    expect(
      await codeOf(caller('moderator').moderation.setRole({ userId: 'usr_other', role: 'admin' })),
    ).toBe('FORBIDDEN');
  });

  it('does not let an administrator change their own role', async () => {
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
    // The signed-out and not-yet-loaded cases: anything but `false` here hands the lever to
    // every visitor during a null window.
    expect(canModerate(null)).toBe(false);
    expect(canModerate(undefined)).toBe(false);
    expect(canAdminister(null)).toBe(false);
  });
});

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

    // The whole row serialised, so a field added to the shape later and not stripped is
    // caught even if no renderer draws it.
    expect(JSON.stringify(shape)).not.toContain('libellous');
  });

  it('carries none of its numbers either', () => {
    // A value no renderer draws is still published — `rating` ordered the list and
    // `helpfulCount` was drawn under the tombstone once `activityType` was nulled. The
    // fixture's `helpfulCount` is non-zero so this asserts something.
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
    // `toReview` runs after Postgres has sorted, so position leaks a withdrawn column even
    // when the value is nulled. `recent` is exempt: it keys on `createdAt`, which the
    // tombstone prints on its own face.
    for (const sort of ['rating_desc', 'rating_asc', 'helpful'] as const) {
      expect(Object.keys(ORDER_BY[sort][0]!)).toEqual(['hiddenAt']);
    }
    expect(Object.keys(ORDER_BY.recent[0]!)).toEqual(['createdAt']);
  });
});

describe('reportSubmitSchema', () => {
  it('takes no reporter id from the wire', () => {
    // The server reads it from the session and nowhere else, which is only true as long as
    // there is no field here for it.
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
 * A database that answers, rather than the proxy that throws: these cases are about what the
 * *resolver* does with what the database says. `$transaction` runs the callback against the
 * same stub, as Prisma's interactive transaction does, so a guard that moved inside the
 * transaction would still be caught.
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
    // `upsert` refuses to edit a hidden review, but the row is keyed `(trailId, userId)`, so
    // deleting the tombstone would free the key for a fresh row with the same prose.
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
    // Same shape, plus one more reason: `assertWithinQuota` counts hidden photographs against
    // the uploader's allowance, so a delete that went through would hand the slot back.
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

/**
 * `includeHidden` is a request, not a permission — and it is the one role check that guards a
 * read, defaulting quietly to the public answer rather than throwing. `trails/[slug]/page.tsx`
 * sends `includeHidden: true` on every render for every visitor and lets the server decide, so
 * dropping the `canModerate` conjunct would give anonymous visitors a "Removed" tile per hidden
 * photograph carrying the author's name, coordinates and capture date — the fields `toPhoto`
 * does not blank. Mutation testing found this the only guard the suite did not kill.
 *
 * The assertion is on the `where` clause rather than on the rows: what matters is that the
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
    expect(await whereFor('member')).toMatchObject({ trailId: 'trl_1', hiddenAt: null });
  });

  it('lets a moderator through, because unhide lives in that strip', async () => {
    const where = await whereFor('moderator');
    expect(where).toMatchObject({ trailId: 'trl_1' });
    expect(where).not.toHaveProperty('hiddenAt');
  });

  it('gives an admin the same reach as a moderator', async () => {
    expect(await whereFor('admin')).not.toHaveProperty('hiddenAt');
  });

  it('still filters for a moderator who did not ask', async () => {
    const { seen, db } = spyingDb();
    await callerWith(db, 'moderator').trails.photos({ trailId: 'trl_1' });
    expect(seen.at(-1)?.where).toMatchObject({ hiddenAt: null });
  });
});

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
    // `{ filed: true }` rather than an error: "this has been reported three times already" is
    // information about a queue the reporter cannot see.
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
    // never reaches the per-item cap. Signed-in reports are counted separately.
    const written: string[] = [];
    const anonymous = callerWith(reportDb(0, 500, written), null);

    expect(await codeOf(anonymous.moderation.report(complaint))).toBe('TOO_MANY_REQUESTS');
    expect(written).toEqual([]);
  });
});
