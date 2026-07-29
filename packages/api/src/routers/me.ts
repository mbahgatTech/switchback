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
   * Ends every native session. The web session is a cookie Auth.js owns, so the caller
   * still has to sign out there — the client does both, and this returns the count so it
   * can say how many devices were affected rather than guessing.
   */
  signOutEverywhere: protectedProcedure.mutation(async ({ ctx }) => {
    const before = await ctx.db.mobileRefreshToken.count({
      where: { userId: ctx.user.id, revokedAt: null },
    });
    await revokeAllRefreshTokens(ctx.db, ctx.user.id);
    return { devicesSignedOut: before };
  }),

  devices: protectedProcedure.query(({ ctx }) =>
    ctx.db.mobileRefreshToken.findMany({
      where: { userId: ctx.user.id, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true, deviceName: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    }),
  ),
});
