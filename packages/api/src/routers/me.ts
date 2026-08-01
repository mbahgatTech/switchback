/**
 * The signed-in user: reading their own profile, editing it, and ending sessions.
 *
 * Anything about *other* people's profiles belongs in `routers/users.ts`; this one is
 * strictly first-person, which is what makes it safe for every procedure here to scope to
 * `ctx.user.id` and never take a user id as input.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  isReservedUsername,
  profileUpdateSchema,
  usernameSchema,
  type SelfProfile,
  type HikerStats,
} from '@switchback/core';
import type { User } from '@switchback/db';
import { Prisma } from '@switchback/db';
import { revokeAllRefreshTokens } from '../tokens';
import { protectedProcedure, publicProcedure, router } from '../trpc';
import { hikerStats } from './users';

function toSelfProfile(user: User): SelfProfile {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    image: user.image,
    bio: user.bio,
    createdAt: user.createdAt,
    email: user.email,
    units: user.units,
    theme: user.theme,
    defaultActivityVisibility: user.defaultActivityVisibility,
    isPlus: user.isPlus,
    plusUntil: user.plusUntil,
    home:
      user.homeLng !== null && user.homeLat !== null
        ? { at: [user.homeLng, user.homeLat], name: user.homeName }
        : null,
  };
}

export const meRouter = router({
  /**
   * Null when signed out rather than UNAUTHORIZED. Every client calls this on boot to
   * decide what to render, and a 401 on the happy path of a logged-out visitor makes
   * error logs useless.
   */
  get: publicProcedure.query(({ ctx }) => (ctx.user ? toSelfProfile(ctx.user) : null)),

  /**
   * Your own record, whatever your profile's visibility says.
   *
   * The same function `users.byUsername` calls, so the total on your own page and the total
   * a stranger reads cannot disagree. This exists separately because you can look at your
   * own stats before you have set a username — and until you have one, there is no
   * `/u/…` URL to look at them on.
   */
  stats: protectedProcedure.query(({ ctx }): Promise<HikerStats> =>
    hikerStats(ctx.db, ctx.user.id),
  ),

  /**
   * Advisory only. There is a unique index behind this, and the gap between the check and
   * the save is a real race — `update` handles the collision properly. This exists to
   * turn a failed submit into live feedback while typing.
   */
  usernameAvailable: protectedProcedure
    .input(z.object({ username: usernameSchema }))
    .query(async ({ ctx, input }) => {
      if (isReservedUsername(input.username)) return { available: false, reason: 'reserved' };
      const taken = await ctx.db.user.findUnique({
        where: { username: input.username },
        select: { id: true },
      });
      if (taken && taken.id !== ctx.user.id) return { available: false, reason: 'taken' };
      return { available: true, reason: null };
    }),

  update: protectedProcedure.input(profileUpdateSchema).mutation(async ({ ctx, input }) => {
    if (input.username != null && isReservedUsername(input.username)) {
      throw new TRPCError({ code: 'CONFLICT', message: 'That username is reserved.' });
    }

    // Built key by key because `undefined` and `null` mean different things across this
    // boundary: absent leaves the column alone, explicit null clears it. Spreading the
    // input wholesale would turn "did not touch bio" into "erase bio".
    const data: Prisma.UserUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.username !== undefined) data.username = input.username;
    if (input.bio !== undefined) data.bio = input.bio;
    if (input.units !== undefined) data.units = input.units;
    if (input.theme !== undefined) data.theme = input.theme;
    if (input.defaultActivityVisibility !== undefined) {
      data.defaultActivityVisibility = input.defaultActivityVisibility;
    }
    if (input.home !== undefined) {
      data.homeLng = input.home?.at[0] ?? null;
      data.homeLat = input.home?.at[1] ?? null;
      data.homeName = input.home?.name ?? null;
    }

    try {
      const user = await ctx.db.user.update({ where: { id: ctx.user.id }, data });
      return toSelfProfile(user);
    } catch (error) {
      // P2002 is the unique violation. The only unique column reachable from here is
      // `username`, so this is someone taking the handle between the check and the save.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new TRPCError({ code: 'CONFLICT', message: 'That username was just taken.' });
      }
      throw error;
    }
  }),

  /**
   * Ends every session this account has, everywhere: the native refresh tokens, the browser
   * session rows, and the access tokens already handed out.
   *
   * The browsers used to be left out, which made the name a lie. `auth.ts` picks database
   * sessions over JWT with the argument that "a session row can be deleted, so 'this account
   * was compromised' is one query" — and nothing ever deleted one, so a stolen browser cookie
   * survived the one button in the product for revoking access, for the whole thirty days it
   * was good for. Reaching for this is reaching for the compromise button; the phones are not
   * the only place an attacker could be.
   *
   * **The access tokens were the other half of the same lie.** They are JWTs and nothing
   * stores them, so deleting rows could not touch one already in a client's memory: the copy
   * on a stolen phone kept working for up to `ACCESS_TOKEN_TTL_S` — fifteen minutes of reading
   * Lifeline positions and deleting activities — while the screen said every session had
   * ended. `User.sessionsRevokedAt` is the stamp that closes it, and `createContext` refuses
   * any bearer token issued at or before it. It is set *first*, so there is no instant in
   * which the tokens are still honoured and the rows are already gone.
   *
   * **It signs out the caller's own browser too**, because that browser is one of the
   * sessions and there is no way to tell it apart from the one being taken back. The client
   * says so before the press and lands on the sign-in page after it — a page that still looks
   * signed in while every request from it fails is worse than an extra sign-in.
   *
   * **Both counts are of things that were live**, not of rows that happened to exist. They are
   * read before the delete, and they carry the same expiry filters as `devices` below, because
   * they are read out on the receipt the person lands on: an expired-but-unpruned refresh token
   * and a session row from a browser last used in March are not sessions that were ended, and
   * counting them made the receipt claim a bigger number than the device list on the screen the
   * reader had just left. Nothing prunes either kind — the drain cron takes refresh tokens and
   * auth requests, and @auth/core only deletes an expired session when that browser comes back
   * with its cookie, which a browser that never comes back never does. The deletes stay
   * unfiltered: clearing dead rows is free and it is the honest thing to do with them.
   */
  signOutEverywhere: protectedProcedure.mutation(async ({ ctx }) => {
    const now = new Date();
    const [devices, browsers] = await Promise.all([
      ctx.db.mobileRefreshToken.count({
        where: { userId: ctx.user.id, revokedAt: null, expiresAt: { gt: now } },
      }),
      ctx.db.session.count({ where: { userId: ctx.user.id, expires: { gt: now } } }),
    ]);
    // Stamped after the counts rather than with the same clock reading. It only ever moves
    // later, and later rejects strictly more tokens — the safe direction for this button.
    await ctx.db.user.update({
      where: { id: ctx.user.id },
      data: { sessionsRevokedAt: new Date() },
    });
    await revokeAllRefreshTokens(ctx.db, ctx.user.id);
    await ctx.db.session.deleteMany({ where: { userId: ctx.user.id } });
    return { devicesSignedOut: devices, browsersSignedOut: browsers };
  }),

  devices: protectedProcedure.query(({ ctx }) =>
    ctx.db.mobileRefreshToken.findMany({
      where: { userId: ctx.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, deviceName: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ),
});
