/**
 * Weather moves people between days, so it applies per day, not per hour: a wet Saturday sends
 * its crowd to Sunday, it does not rearrange who sets off at nine. Per-day is also the only
 * place a multiplier still means something — normalisation divides out anything uniform.
 *
 * Three effects, each a shape rather than a threshold, so a one-point forecast revision cannot
 * swing the recommendation: rain suppresses (probability matters more than amount, because
 * people decide from the forecast); temperature has an optimum, gentler on the cold side since
 * hikers dress for it; wind suppresses above ~40 km/h. The scale is deliberately narrow.
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
 * 0.35–1.15: how much this day's weather encourages or discourages a hike. Ceilings above 1
 * because good weather genuinely pulls people out; a model capped at 1 could only punish.
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
    // Compounds with probability: a 90% chance of 20 mm is a different day from 90% of drizzle.
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
 * 0.55–1.05 by temperature: flat through the comfortable band, falling away outside it. The cold
 * side falls over 20 °C and the hot side over 14 — people layer up more readily than they set
 * out into 35 °C.
 */
export function comfortFactor(tempC: number): number {
  if (tempC >= COMFORT_LOW_C && tempC <= COMFORT_HIGH_C) return 1.05;
  const distance =
    tempC < COMFORT_LOW_C ? (COMFORT_LOW_C - tempC) / 20 : (tempC - COMFORT_HIGH_C) / 14;
  return 1.05 - 0.5 * clamp01(distance);
}

/**
 * Weather factors indexed by day of week. Keyed by `dayOfWeek`, not date, because the published
 * week is a seven-day cycle. Days the forecast does not reach stay at 1 — no weather is not bad
 * weather.
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
