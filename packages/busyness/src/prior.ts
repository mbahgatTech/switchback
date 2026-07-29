/**
 * The prior: what a week on this trail probably looks like before anyone has recorded one.
 *
 * Every trail starts here, and most trails stay here — a new corpus has no recorded
 * activities at all, so the model has to say something defensible from OSM tags and a
 * latitude alone. What it says is a demand surface over (day of week, hour), built from
 * four factors that each answer a different question:
 *
 * | factor          | question                                          |
 * |-----------------|---------------------------------------------------|
 * | `dayAmplitude`  | how much busier is Saturday than Tuesday?          |
 * | `hourShape`     | when in the day do people set off?                 |
 * | `daylightGate`  | is it light enough to be out there?                |
 * | `saturation`    | does the car park fill up and cap the peak?        |
 *
 * **What deliberately is *not* a factor: anything that only scales the whole surface.**
 * The published score is normalised against the trail's own weekly peak, so a uniform
 * multiplier — season, popularity, absolute visitor count — divides straight back out and
 * changes nothing. This is the trap in a busy-times model: it is easy to write a hundred
 * lines of seasonal amplitude that provably cannot affect the output. Season enters through
 * daylight, which changes the *shape*. Popularity enters through weekday/weekend contrast,
 * which changes the *shape*. Parking capacity enters through saturation, which changes the
 * *shape*. How crowded the trail gets in absolute terms is a separate question with a
 * separate answer — `crowding` below, published as `peakLevel` rather than folded into the
 * curve where it would silently vanish.
 */

import { daylightWindow, type DaylightWindow } from './daylight';

export const HOURS_PER_DAY = 24;
export const DAYS_PER_WEEK = 7;

/**
 * Relative pull of each day before popularity is applied. 0 = Sunday, matching `Date#getDay`.
 *
 * Saturday leads, Sunday is close behind, Friday is lifted by afternoons off, and the
 * midweek trough sags towards Wednesday. These are the shape of every trailhead counter
 * study anyone publishes, and they are the part of this file most worth replacing with our
 * own aggregates once there are enough of them.
 */
export const DAY_BASE: readonly number[] = [0.95, 0.4, 0.38, 0.38, 0.42, 0.58, 1.0];

export interface HourBump {
  /** Position within the daylight window, 0 = sunrise, 1 = sunset. */
  at: number;
  /** Width as a fraction of the daylight window. */
  width: number;
  weight: number;
}

/**
 * Weekend: two departures. The early one is the hike you planned; the later one is the
 * hike you decided on after breakfast, and it is nearly as large.
 */
export const WEEKEND_BUMPS: readonly HourBump[] = [
  { at: 0.3, width: 0.13, weight: 1.0 },
  { at: 0.56, width: 0.17, weight: 0.86 },
];

/**
 * Weekday: one broad afternoon peak, because most people are at work until it, plus a small
 * dawn shoulder for the regulars who go before it.
 */
export const WEEKDAY_BUMPS: readonly HourBump[] = [
  { at: 0.14, width: 0.09, weight: 0.34 },
  { at: 0.63, width: 0.21, weight: 1.0 },
];

/** Baseline traffic through the daylight hours, so the curve never reads as empty at noon. */
export const DAYLIGHT_FLOOR = 0.06;

/** Night is quiet, not empty. People do hike in the dark, and a hard zero would say they cannot. */
export const NIGHT_FLOOR = 0.015;

/** Hours either side of sunrise/sunset over which the gate opens and closes. */
export const TWILIGHT_H = 1.2;

export interface TrailSignals {
  /** Completions + recorded activities + reviews. Zero for a freshly ingested trail. */
  popularity?: number | null;
  reviewCount?: number | null;
  /** Seeded from Wikimedia Commons and Mapillary, so it is non-zero long before our users are. */
  photoCount?: number | null;
  /** Trailhead spaces from a nearby `amenity=parking`. Tagged on very few trails. */
  parkingCapacity?: number | null;
}

/**
 * Evidence that people go here, on a scale where 0 means we have none.
 *
 * `photoCount` earns its weight: it is seeded from Wikimedia Commons and Mapillary during
 * ingest, so on a cold corpus it is the *only* signal that separates a honeypot from a
 * forestry track — forty photographs of a hill is forty people who thought it worth
 * photographing. `parkingCapacity` is demand evidence in the same way: nobody surfaces two
 * hundred spaces for a path nobody hikes. It is tagged on barely one trail in eighty, and
 * contributes nothing when absent rather than dragging the estimate to zero.
 */
export function demandEvidence(signals: TrailSignals): number {
  const popularity = Math.max(0, signals.popularity ?? 0);
  const reviews = Math.max(0, signals.reviewCount ?? 0);
  const photos = Math.max(0, signals.photoCount ?? 0);
  const parking = Math.max(0, signals.parkingCapacity ?? 0);
  return popularity + 2 * photos + reviews + parking / 3;
}

/** Evidence at which a trail is treated as being as busy as trails get. */
export const CROWDING_REFERENCE = 400;

/**
 * 0–1: how crowded this trail gets at its weekly peak.
 *
 * Logarithmic because the difference between 0 and 20 pieces of evidence means far more
 * than the difference between 200 and 220 — visitor numbers across a corpus are roughly
 * log-normal, and a linear scale would put every trail in the bottom percent of the range
 * and call them all quiet.
 */
export function crowdingFrom(signals: TrailSignals): number {
  const evidence = demandEvidence(signals);
  if (evidence <= 0) return 0;
  return clamp01(Math.log1p(evidence) / Math.log1p(CROWDING_REFERENCE));
}

/**
 * Weekday-versus-weekend contrast, as an exponent on `DAY_BASE`.
 *
 * A trail nobody has heard of is a weekend trail almost exclusively; a famous one is busy
 * every day of the week. Since `DAY_BASE` is below 1 on weekdays and exactly 1 on Saturday,
 * raising it to a power greater than 1 deepens the midweek trough and leaves the peak alone
 * — one parameter, monotone, and it cannot accidentally reorder the days.
 */
export function contrastExponent(crowding: number): number {
  return 1.75 - 0.95 * clamp01(crowding);
}

export interface PriorInput {
  latDeg: number;
  lngDeg?: number;
  utcOffsetS?: number;
  /** 1–366. Sets the daylight window the whole week is anchored to. */
  dayOfYear: number;
  signals?: TrailSignals;
}

export interface PriorSurface {
  /** `[dayOfWeek][hour]`, unnormalised. */
  demand: number[][];
  daylight: DaylightWindow;
  crowding: number;
}

/**
 * The whole week, before observations and before weather.
 *
 * One daylight window for all seven days: a week moves sunset by about ten minutes, which
 * is invisible at hourly resolution and would otherwise make Monday and Sunday of the same
 * week disagree about when it gets dark.
 */
export function priorSurface(input: PriorInput): PriorSurface {
  const signals = input.signals ?? {};
  const crowding = crowdingFrom(signals);
  const exponent = contrastExponent(crowding);

  const daylightOptions: { lngDeg?: number; utcOffsetS?: number } = {};
  if (input.lngDeg !== undefined) daylightOptions.lngDeg = input.lngDeg;
  if (input.utcOffsetS !== undefined) daylightOptions.utcOffsetS = input.utcOffsetS;
  const daylight = daylightWindow(input.latDeg, input.dayOfYear, daylightOptions);

  const demand: number[][] = [];
  for (let day = 0; day < DAYS_PER_WEEK; day++) {
    const isWeekend = day === 0 || day === 6;
    const amplitude = Math.pow(DAY_BASE[day] ?? 0.5, exponent);
    const bumps = isWeekend ? WEEKEND_BUMPS : WEEKDAY_BUMPS;

    const hours: number[] = [];
    for (let hour = 0; hour < HOURS_PER_DAY; hour++) {
      // Mid-hour, because the bar covers the whole hour and its centre is what it means.
      const clock = hour + 0.5;
      const gate = daylightGate(clock, daylight);
      const shape = hourShape(clock, daylight, bumps) + DAYLIGHT_FLOOR;
      hours.push(amplitude * (NIGHT_FLOOR + gate * shape));
    }
    demand.push(hours);
  }

  return {
    demand: saturate(demand, signals.parkingCapacity ?? null, crowding),
    daylight,
    crowding,
  };
}

/**
 * Sum of Gaussian bumps positioned by fraction of daylight, not by clock hour.
 *
 * This is what makes the curve seasonal for free: in June the two weekend peaks sit six
 * hours apart, in December they compress into a four-hour window around noon, and neither
 * case needed a rule of its own.
 */
export function hourShape(
  clockHour: number,
  daylight: DaylightWindow,
  bumps: readonly HourBump[],
): number {
  // Polar night has no window to place anything in. A flat curve is the honest answer:
  // whoever is out there in the dark is not following a daily rhythm we can model.
  if (daylight.daylightHours <= 0) return 0;

  const fraction = (clockHour - daylight.sunriseHour) / daylight.daylightHours;
  let total = 0;
  for (const bump of bumps) {
    const z = (fraction - bump.at) / bump.width;
    total += bump.weight * Math.exp(-0.5 * z * z);
  }
  return total;
}

/**
 * 0–1, ramping across twilight rather than switching at sunrise.
 *
 * A step would put a cliff between two adjacent bars of the chart at an hour when the real
 * change is gradual, and would make the 06:00 bar in midsummer swing wildly between days
 * that differ by four minutes of sunrise.
 */
export function daylightGate(clockHour: number, daylight: DaylightWindow): number {
  if (daylight.polarDay) return 1;
  if (daylight.polarNight) return 0;
  const rising = logistic((clockHour - daylight.sunriseHour) / TWILIGHT_H);
  const falling = logistic((daylight.sunsetHour - clockHour) / TWILIGHT_H);
  return rising * clamp01(falling);
}

/**
 * Peak visitors per hour implied by the crowding score, for the saturation model.
 *
 * A stated assumption rather than a measurement, and the one number here that would most
 * benefit from being replaced by our own counts. It exists only to give the car park
 * something to be full *of*: saturation needs demand and capacity in the same units.
 */
export function peakArrivalsPerHour(crowding: number): number {
  return 4 + 260 * clamp01(crowding) ** 2;
}

/**
 * A car park that fills flattens the peak it cannot serve.
 *
 * Once every space is taken, arrivals are limited by departures, so the curve stops rising
 * and spreads sideways — the well-known "get there before nine or don't bother" trailhead.
 * `capacity · (1 − e^(−demand/capacity))` is the smooth form of that: linear while there is
 * room, asymptotic to the capacity once there is not, with no discontinuity in between.
 *
 * With no `capacity` tag — which is all but a handful of trails — this returns the surface
 * untouched. That is the whole of its graceful degradation: a missing tag removes an effect
 * rather than introducing a wrong one.
 */
export function saturate(
  demand: readonly (readonly number[])[],
  capacity: number | null,
  crowding: number,
): number[][] {
  const copy = demand.map((day) => [...day]);
  if (capacity === null || !Number.isFinite(capacity) || capacity <= 0) return copy;

  const peak = maxOf(copy);
  if (peak <= 0) return copy;

  const arrivalsPerUnit = peakArrivalsPerHour(crowding) / peak;
  return copy.map((day) =>
    day.map((value) => {
      const arrivals = value * arrivalsPerUnit;
      return capacity * (1 - Math.exp(-arrivals / capacity));
    }),
  );
}

export function maxOf(surface: readonly (readonly number[])[]): number {
  let peak = 0;
  for (const day of surface) {
    for (const value of day) {
      if (value > peak) peak = value;
    }
  }
  return peak;
}

function logistic(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
