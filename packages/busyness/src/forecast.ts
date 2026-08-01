/**
 * Assembling the published forecast: prior → observations → weather → 0–100 → advice.
 *
 * `score` is normalised against *this trail's* weekly peak, so 100 means "as busy as this path
 * gets" — every trail's busiest hour is `packed`, moorland included. The absolute question gets
 * its own answer in `peakLevel`, rather than rescaling and breaking the chart.
 */

import {
  DAY_NAMES,
  confidenceFromObservations,
  levelFromScore,
  type BusynessDay,
  type BusynessForecast,
  type BusynessHour,
  type BusynessLevel,
} from '@switchback/core';
import { dayOfYear, type DaylightWindow } from './daylight';
import { blendObservations, type ObservationBucket } from './observe';
import {
  CROWDING_REFERENCE,
  DAYS_PER_WEEK,
  HOURS_PER_DAY,
  daylightGate,
  maxOf,
  priorSurface,
  type TrailSignals,
} from './prior';
import { weatherFactorsByDay, type DayWeather } from './weather';

export const MODEL_PROVIDER = 'switchback-model-v1';

export interface BusynessInput {
  trailId: string;
  /** IANA zone, for display. The maths uses `utcOffsetS`. */
  timezone?: string;
  latDeg: number;
  lngDeg?: number;
  utcOffsetS?: number;
  /** Epoch ms. Fixes the season and stamps `computedAt`. */
  nowMs: number;
  signals?: TrailSignals;
  buckets?: readonly ObservationBucket[];
  /** The trail's own Tobler estimate, in seconds. Lets the recommendation refuse a start that cannot finish before dark. */
  estimatedTimeS?: number | null;
  /** Per day-of-week weather, 0 = Sunday. Omit for an unadjusted curve. */
  weather?: ReadonlyMap<number, DayWeather> | null;
  provider?: string;
}

/** `peakLevel` is our addition to the core contract; see the file header for why. */
export type BusynessResult = BusynessForecast;

/**
 * How much a bad forecast is allowed to cost a candidate hour, in score points — the reason the
 * search is a cost function rather than an argmin. Rain *lowers* the busyness score, so "the
 * quietest feasible hour" would recommend the wettest day of the week, every time.
 */
export const WEATHER_PENALTY = 55;

export function busynessForecast(input: BusynessInput): BusynessResult {
  const priorOptions: Parameters<typeof priorSurface>[0] = {
    latDeg: input.latDeg,
    dayOfYear: dayOfYear(input.nowMs),
  };
  if (input.lngDeg !== undefined) priorOptions.lngDeg = input.lngDeg;
  if (input.utcOffsetS !== undefined) priorOptions.utcOffsetS = input.utcOffsetS;
  if (input.signals) priorOptions.signals = input.signals;

  const { demand, daylight, crowding } = priorSurface(priorOptions);
  const { surface, observationCount } = blendObservations(demand, input.buckets ?? []);

  const weatherAdjusted = Boolean(input.weather && input.weather.size > 0);
  const factors = weatherFactorsByDay(input.weather);
  const adjusted = surface.map((day, index) => day.map((value) => value * (factors[index] ?? 1)));

  const week = normalise(adjusted, daylight);

  return {
    trailId: input.trailId,
    timezone: input.timezone ?? 'UTC',
    week,
    confidence: confidenceFromObservations(observationCount),
    observationCount,
    provider: input.provider ?? MODEL_PROVIDER,
    recommendation: recommend(
      week,
      daylight,
      factors,
      input.estimatedTimeS ?? null,
      weatherAdjusted,
    ),
    weatherAdjusted,
    peakLevel: peakLevelFrom(crowding, observationCount),
    computedAt: new Date(input.nowMs).toISOString(),
  };
}

/** Scale the week so its busiest hour is 100, and label every hour off that. */
export function normalise(
  surface: readonly (readonly number[])[],
  daylight: DaylightWindow,
): BusynessDay[] {
  const peak = maxOf(surface);
  const week: BusynessDay[] = [];

  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    const row = surface[day] ?? [];
    const hours: BusynessHour[] = [];
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      const score = peak > 0 ? clamp(round1((100 * (row[hour] ?? 0)) / peak), 0, 100) : 0;
      hours.push({ hour, score, level: levelFromScore(score) });
    }
    week.push({
      dayOfWeek: day,
      hours,
      peakHour: argmax(hours.map((h) => h.score)),
      quietestHour: quietestDaylightHour(hours, daylight),
    });
  }

  return week;
}

/**
 * The quietest hour anyone would actually consider. The literal daily minimum is 03:00 on every
 * trail on earth, so the search is restricted to lit hours, falling back to the whole day only
 * in a polar winter.
 */
export function quietestDaylightHour(
  hours: readonly BusynessHour[],
  daylight: DaylightWindow,
): number {
  const scores = hours.map((h) => h.score);
  const lit = hours.filter((h) => daylightGate(h.hour + 0.5, daylight) > 0.5);
  if (lit.length === 0) return argmin(scores);

  let best = lit[0]!;
  for (const hour of lit) {
    if (hour.score < best.score) best = hour;
  }
  return best.hour;
}

/**
 * The one line the summary shows: go then. Two constraints and one cost — light enough to start,
 * enough daylight left to finish, and quiet without being quiet *because* the weather is bad.
 */
export function recommend(
  week: readonly BusynessDay[],
  daylight: DaylightWindow,
  weatherFactors: readonly number[],
  estimatedTimeS: number | null,
  weatherAdjusted: boolean,
): BusynessForecast['recommendation'] {
  if (daylight.polarNight) return null;

  const durationH = estimatedTimeS && estimatedTimeS > 0 ? estimatedTimeS / 3600 : 0;
  const strict = candidates(week, daylight, durationH, true);
  // A short winter day may not fit a long hike at any start time; the fallback drops the
  // finish-before-dark rule, and `reasonFor` says so.
  const relaxed = strict.length > 0 ? strict : candidates(week, daylight, durationH, false);
  if (relaxed.length === 0) return null;

  let best = relaxed[0]!;
  let bestCost = Infinity;
  for (const candidate of relaxed) {
    const factor = weatherFactors[candidate.dayOfWeek] ?? 1;
    const cost = candidate.score + WEATHER_PENALTY * (1 - factor);
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
  }

  const finishesBeforeDark = strict.length > 0;
  return {
    dayOfWeek: best.dayOfWeek,
    hour: best.hour,
    level: levelFromScore(best.score),
    reason: reasonFor(best, week, weatherFactors, weatherAdjusted, finishesBeforeDark, durationH),
  };
}

interface Candidate {
  dayOfWeek: number;
  hour: number;
  score: number;
}

function candidates(
  week: readonly BusynessDay[],
  daylight: DaylightWindow,
  durationH: number,
  requireFinish: boolean,
): Candidate[] {
  const found: Candidate[] = [];
  for (const day of week) {
    for (const hour of day.hours) {
      // Mid-hour: the bar means the hour it covers, so judge it from its centre.
      const start = hour.hour + 0.5;
      if (!daylight.polarDay) {
        if (start < daylight.sunriseHour) continue;
        if (requireFinish && start + durationH > daylight.sunsetHour) continue;
        if (!requireFinish && start > daylight.sunsetHour) continue;
      }
      found.push({ dayOfWeek: day.dayOfWeek, hour: hour.hour, score: hour.score });
    }
  }
  return found;
}

/**
 * Why this slot, in the interface's voice. The clauses are comparative because the score is:
 * "quieter than the Saturday peak" is a claim this model supports, "only twelve people" is not.
 */
export function reasonFor(
  best: Candidate,
  week: readonly BusynessDay[],
  weatherFactors: readonly number[],
  weatherAdjusted: boolean,
  finishesBeforeDark: boolean,
  durationH: number,
): string {
  const clauses: string[] = [];

  const busiest = busiestSlot(week);
  if (busiest && busiest.score > 0) {
    const ratio = best.score / busiest.score;
    const busiestDay = DAY_NAMES[busiest.dayOfWeek] ?? 'the busiest day';
    if (ratio <= 0.35) clauses.push(`a fraction of the ${busiestDay} crowd`);
    else if (ratio <= 0.7) clauses.push(`noticeably quieter than ${busiestDay}`);
    else clauses.push('about as quiet as this trail gets');
  }

  if (weatherAdjusted) {
    const factor = weatherFactors[best.dayOfWeek] ?? 1;
    const bestFactor = Math.max(...weatherFactors);
    if (factor >= bestFactor - 0.02 && factor >= 1)
      clauses.push('and the best weather of the week');
    else if (factor >= 1) clauses.push('and fair weather');
  }

  if (!finishesBeforeDark && durationH > 0) {
    clauses.push('though the light will go before you finish at this time of year');
  }

  if (clauses.length === 0) return 'The quietest daylight start we can estimate.';
  return `${capitalise(clauses[0]!)}${clauses.length > 1 ? `, ${clauses.slice(1).join(', ')}` : ''}.`;
}

function busiestSlot(week: readonly BusynessDay[]): Candidate | null {
  let best: Candidate | null = null;
  for (const day of week) {
    for (const hour of day.hours) {
      if (!best || hour.score > best.score) {
        best = { dayOfWeek: day.dayOfWeek, hour: hour.hour, score: hour.score };
      }
    }
  }
  return best;
}

/**
 * Absolute crowding at the peak, on the same four-step scale. `null` rather than `quiet` when
 * there is nothing to go on — a trail we know nothing about is not one we know to be empty.
 *
 * The gamma is load-bearing: `crowding` is logarithmic, which is right for the contrast exponent
 * but far too generous read as a percentage, so squaring it back out spreads the corpus across
 * all four steps instead of piling it into the top two.
 */
export const PEAK_LEVEL_GAMMA = 1.8;

export function peakLevelFrom(crowding: number, observationCount: number): BusynessLevel | null {
  if (crowding <= 0 && observationCount <= 0) return null;
  // Recorded starts are direct crowding evidence, so they take the same log scale the prior uses.
  const observed =
    observationCount > 0 ? Math.log1p(observationCount) / Math.log1p(CROWDING_REFERENCE) : 0;
  const combined = Math.min(1, Math.max(crowding, observed));
  return levelFromScore(100 * combined ** PEAK_LEVEL_GAMMA);
}

function argmax(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? 0) > (values[best] ?? 0)) best = i;
  }
  return best;
}

function argmin(values: readonly number[]): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if ((values[i] ?? 0) < (values[best] ?? 0)) best = i;
  }
  return best;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
