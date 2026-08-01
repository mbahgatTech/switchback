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
  type ProfileUpdate,
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
    // Read from the row the context loaded, so the client can decide whether to draw a
    // moderator's controls. Not an authorisation — `moderatorProcedure` is.
    role: user.role,
    home:
      user.homeLng !== null && user.homeLat !== null
        ? { at: [user.homeLng, user.homeLat], name: user.homeName }
        : null,
  };
}

/**
 * The columns a profile edit is allowed to touch, and only those. **This is the allow-list that
 * stops `me.update` being a privilege-escalation endpoint**, and a named function so a test can
 * hold it to that: `data: { ...input }` would let anybody who can POST a profile edit send
 * `role: "admin"` and be one forgotten `.strict()` away from getting it.
 *
 * Built key by key rather than spread, which also keeps `undefined` and `null` distinct: absent
 * leaves the column alone, explicit null clears it.
 *
 * The rule for extending it: one named line per column, and an entitlement — `role`, `isPlus`,
 * `plusUntil` — does not belong in this procedure at all. `test/moderation.test.ts` re-derives
 * the key set from a deliberately polluted input and fails the build if any of those appears.
 */
export function profileUpdateData(input: ProfileUpdate): Prisma.UserUpdateInput {
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
  return data;
}

export const meRouter = router({
  /**
   * Null when signed out rather than UNAUTHORIZED. Every client calls this on boot to decide
   * what to render, and a 401 on the happy path of a logged-out visitor makes error logs
   * useless.
   */
  get: publicProcedure.query(({ ctx }) => (ctx.user ? toSelfProfile(ctx.user) : null)),

  /**
   * Your own record, whatever your profile's visibility says. The same function
   * `users.byUsername` calls, so the two totals cannot disagree; separate because you can look
   * at your own stats before you have a username, and so before there is a `/u/…` URL.
   */
  stats: protectedProcedure.query(({ ctx }): Promise<HikerStats> =>
    hikerStats(ctx.db, ctx.user.id),
  ),

  /**
   * Advisory only. There is a unique index behind this and the gap between check and save is a
   * real race, which `update` handles; this turns a failed submit into feedback while typing.
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

    const data = profileUpdateData(input);

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
   * Ends every session this account has: the native refresh tokens, the browser session rows,
   * and the access tokens already handed out. All three, because a stolen browser cookie or an
   * access JWT already in a client's memory outlives a row delete — `User.sessionsRevokedAt` is
   * the stamp that closes the JWT half, and `createContext` refuses any bearer token issued at
   * or before it. It is set **first**, so there is no instant in which the tokens are still
   * honoured and the rows are already gone.
   *
   * This signs out the caller's own browser too; there is no way to tell it apart from the one
   * being taken back.
   *
   * **Both counts are of things that were live**, read before the delete and carrying the same
   * expiry filters as `devices` below, because the receipt is shown next to that list. Nothing
   * prunes either kind — @auth/core only deletes an expired session when that browser comes
   * back. The deletes themselves stay unfiltered: clearing dead rows is free.
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
