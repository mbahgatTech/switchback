import { cache } from 'react';
import type { UnitSystem } from '@switchback/core';
import { caller } from '@/trpc/server';

/**
 * The reader's unit system, for server components.
 *
 * `useUnits()` in `components/units.tsx` answers the same question for the client tree.
 * Server components have no context, so they need a function — and they had one already, in
 * the form of `viewer?.units ?? 'metric'` written out at each call site. That worked exactly
 * as well as remembering to write it, which is to say: about forty places across the app
 * rendered `'metric'` as a literal, and changing the setting on the profile page moved a
 * column in the database and nothing on the screen.
 *
 * So the fallback lives here once. `cache()` means the underlying session read happens at
 * most once per request no matter how many components ask, which is what makes it cheap
 * enough to call from a leaf rather than thread down as a prop.
 *
 * Metric when signed out, matching every formatter's own default — a missing preference is
 * one reader seeing kilometres, not an error.
 */
export const viewerUnits = cache(async (): Promise<UnitSystem> => {
  const viewer = await caller.me.get();
  return viewer?.units ?? 'metric';
});
