/**
 * Reading a stored elevation profile.
 *
 * `ElevationProfile.points` is a `Json` column holding the resampled line ingest derived —
 * hundreds to thousands of `{ distM, eleM, lng, lat }` objects. It is parsed rather than
 * cast on the way out, because everything downstream does arithmetic on these numbers:
 * the profile chart, Tobler's integral, the weather sampler's coordinates. A malformed row
 * cast blindly surfaces as `NaN` metres of ascent, or as a forecast requested for latitude
 * `undefined`, a long way from the line that caused it.
 *
 * A profile that fails to parse reads as an empty one, and each caller decides what that
 * means — the detail page renders without a chart, the weather router answers 404. Neither
 * is a 500: the trail is fine, one derived artefact is not.
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
