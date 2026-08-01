import { z } from 'zod';

/**
 * Busy times. No official API sells this — Google's Places API (New) exposes no `popularTimes` in
 * any SKU and scraping it violates their terms — so this is *our* estimate and the UI is required
 * to say so, which is what `confidence` and `observationCount` are for. The estimate starts as a
 * parametric prior (weekly shape × seasonality × popularity × parking capacity) and is pulled
 * toward reality by recorded activities.
 */

export const BUSYNESS_CONFIDENCE = ['modeled', 'low', 'medium', 'high'] as const;
export type BusynessConfidence = (typeof BUSYNESS_CONFIDENCE)[number];

/** Buckets that map to the UI's four-step scale, matching how people actually plan. */
export const BUSYNESS_LEVELS = ['quiet', 'moderate', 'busy', 'packed'] as const;
export type BusynessLevel = (typeof BUSYNESS_LEVELS)[number];

export const busynessHourSchema = z.object({
  /** 0–23, local to the trail. */
  hour: z.number().int().min(0).max(23),
  /** Normalised 0–100 against this trail's own weekly peak, not against other trails. */
  score: z.number().min(0).max(100),
  level: z.enum(BUSYNESS_LEVELS),
});
export type BusynessHour = z.infer<typeof busynessHourSchema>;

export const busynessDaySchema = z.object({
  /** 0 = Sunday, matching JS `Date#getDay`. */
  dayOfWeek: z.number().int().min(0).max(6),
  hours: z.array(busynessHourSchema).length(24),
  /** Peak hour for this day, for the "quietest time to go" callout. */
  peakHour: z.number().int().min(0).max(23),
  quietestHour: z.number().int().min(0).max(23),
});
export type BusynessDay = z.infer<typeof busynessDaySchema>;

export const busynessForecastSchema = z.object({
  trailId: z.string(),
  timezone: z.string(),
  week: z.array(busynessDaySchema).length(7),

  confidence: z.enum(BUSYNESS_CONFIDENCE),
  /** Recorded activity starts backing this estimate. Zero means pure prior. */
  observationCount: z.number().int().nonnegative(),
  /** Where the numbers came from, so the UI never implies false authority. */
  provider: z.string(),

  /** The single best recommendation, precomputed for the summary line. */
  recommendation: z
    .object({
      dayOfWeek: z.number().int().min(0).max(6),
      hour: z.number().int().min(0).max(23),
      level: z.enum(BUSYNESS_LEVELS),
      /** Why: "clear weather and half the Saturday crowd". */
      reason: z.string(),
    })
    .nullable(),

  /** How crowded this trail's *busiest* hour is, on the same four-step scale. `score` is relative
   * to this trail alone, so every trail's peak is 100 and would read as `packed`; this carries
   * the absolute claim. `null` when we know nothing, which is not the same as knowing it is quiet. */
  peakLevel: z.enum(BUSYNESS_LEVELS).nullable(),

  /** Whether the weather forecast was folded into the estimate. */
  weatherAdjusted: z.boolean(),
  computedAt: z.string(),
});
export type BusynessForecast = z.infer<typeof busynessForecastSchema>;

export const busynessRequestSchema = z.object({
  trailId: z.string(),
  /** Fold the week's weather into the curve. Off for a trail card, where a curve that changes
   * shape with the forecast confuses — and where the saved upstream call is the difference
   * between a list page costing one request and twenty. */
  includeWeather: z.boolean().default(true),
});
export type BusynessRequest = z.infer<typeof busynessRequestSchema>;

export function levelFromScore(score: number): BusynessLevel {
  if (score >= 75) return 'packed';
  if (score >= 50) return 'busy';
  if (score >= 25) return 'moderate';
  return 'quiet';
}

/** Confidence as a function of how many real observations back the curve. Deliberately
 * conservative — claiming "high" from a handful of hikes is the dishonesty this type prevents. */
export function confidenceFromObservations(count: number): BusynessConfidence {
  if (count >= 200) return 'high';
  if (count >= 50) return 'medium';
  if (count >= 10) return 'low';
  return 'modeled';
}

/** The four levels in words, so both clients caption a cell identically. */
export const BUSYNESS_LEVEL_LABEL: Readonly<Record<BusynessLevel, string>> = {
  quiet: 'Quiet',
  moderate: 'Moderate',
  busy: 'Busy',
  packed: 'Packed',
};
