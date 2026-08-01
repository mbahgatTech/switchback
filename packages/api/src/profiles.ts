/**
 * Reading a stored elevation profile. `ElevationProfile.points` is a `Json` column, parsed
 * rather than cast because everything downstream does arithmetic on these numbers — a
 * malformed row cast blindly surfaces as `NaN` metres of ascent a long way from its cause.
 * A profile that fails to parse reads as an empty one and each caller decides what that means.
 */

import { z } from 'zod';
import { elevationPointSchema } from '@switchback/core';
import type { ElevationPoint } from '@switchback/core';

const profilePointsSchema = z.array(elevationPointSchema);

export function readProfile(value: unknown): ElevationPoint[] {
  if (value === undefined || value === null) return [];
  const parsed = profilePointsSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}
