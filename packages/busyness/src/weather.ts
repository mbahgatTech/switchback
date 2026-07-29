/**
 * Weather moves people between days, so it belongs on the day, not the hour.
 *
 * A wet Saturday sends its crowd to Sunday; it does not rearrange who sets off at nine
 * versus who sets off at two. Modelling it as a per-day multiplier says exactly that, and
 * it is also the only place a multiplier still means something — normalisation divides out
 * anything applied uniformly across the whole week, so a per-hour weather factor would
 * mostly cancel while a per-day one changes which day wins.
 *
 * Three effects, each with a shape rather than a threshold, because a cliff at 50 %
 * precipitation probability would make a forecast revision of one percentage point swing
 * the recommendation from Saturday to Sunday:
 *
 * - **Rain** suppresses, and the probability matters more than the amount. People decide
 *   from the forecast, not from the millimetres that eventually fall.
 * - **Temperature** has an optimum. Both ends of the scale keep people at home, and the
 *   cold end is gentler because hikers dress for it.
 * - **Wind** suppresses above roughly 40 km/h, where a ridge stops being pleasant.
 *
 * The scale is deliberately narrow. Weather reshuffles a week; it does not empty one.
 */

export interface DayWeather {
  /** 0–100. The headline number people actually plan from. */
  precipitationProbability?: number | null;
  precipitationMm?: number | null;
  /** Daytime maximum, °C. */
  temperatureMaxC?: number | null;
  windGustsMaxKmh?: number | null;
}

/** Comfortable hiking weather, in °C. */
export const COMFORT_LOW_C = 14;
export const COMFORT_HIGH_C = 23;

/** How far the multiplier can fall on the worst day. */
export const MIN_WEATHER_FACTOR = 0.35;

/**
 * 0.35–1.15: how much this day's weather encourages or discourages a hike.
 *
 * Above 1 for a clear, mild day — good weather genuinely pulls people out, and a model
 * capped at 1 could only ever punish.
 */
export function weatherFactor(weather: DayWeather | null | undefined): number {
  if (!weather) return 1;

  let factor = 1;

  const probability = finite(weather.precipitationProbability);
  if (probability !== null) {
    // 0 % → 1.06, 50 % → 0.79, 100 % → 0.52. Smooth all the way down.
    factor *= 1.06 - 0.54 * clamp01(probability / 100);
  }

  const mm = finite(weather.precipitationMm);
  if (mm !== null && mm > 0) {
    // Heavy rain on top of a high probability compounds — a forecast 90 % chance of 20 mm
    // is a different day from a 90 % chance of drizzle.
    factor *= 1 - 0.25 * clamp01(mm / 12);
  }

  const tempC = finite(weather.temperatureMaxC);
  if (tempC !== null) {
    factor *= comfortFactor(tempC);
  }

  const gusts = finite(weather.windGustsMaxKmh);
  if (gusts !== null && gusts > 40) {
    factor *= 1 - 0.4 * clamp01((gusts - 40) / 50);
  }

  return clamp(factor, MIN_WEATHER_FACTOR, 1.15);
}

/**
 * 0.55–1.05 by temperature: flat through the comfortable band, falling away outside it.
 *
 * The cold side falls over 20 °C and the hot side over 14, because people layer up for a
 * cold hill far more readily than they set out into 35 °C.
 */
export function comfortFactor(tempC: number): number {
  if (tempC >= COMFORT_LOW_C && tempC <= COMFORT_HIGH_C) return 1.05;
  const distance =
    tempC < COMFORT_LOW_C ? (COMFORT_LOW_C - tempC) / 20 : (tempC - COMFORT_HIGH_C) / 14;
  return 1.05 - 0.5 * clamp01(distance);
}

/**
 * Weather factors indexed by day of week, from a forecast keyed by date.
 *
 * The map is by `dayOfWeek` rather than by date because the published week is a
 * seven-day-of-week cycle, not seven dated days. A forecast that only reaches Thursday
 * leaves Friday and Saturday at 1 — no weather is not bad weather.
 */
export function weatherFactorsByDay(
  forecast: ReadonlyMap<number, DayWeather> | null | undefined,
): number[] {
  const factors = new Array<number>(7).fill(1);
  if (!forecast) return factors;
  for (const [dayOfWeek, weather] of forecast) {
    if (Number.isInteger(dayOfWeek) && dayOfWeek >= 0 && dayOfWeek < 7) {
      factors[dayOfWeek] = weatherFactor(weather);
    }
  }
  return factors;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
