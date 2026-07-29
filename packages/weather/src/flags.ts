/**
 * Turning a forecast into advice.
 *
 * A row of numbers is not a decision. The flags below are the small set of conditions that
 * would actually change whether, or how, someone sets off — and each one names the place it
 * applies to, because "windy" is useless and "gusts to 72 km/h at the high point" is not.
 *
 * Three rules govern everything here:
 *
 * 1. **A flag has to be actionable.** "Partly cloudy" is not a flag. Freezing level below
 *    the summit is, because it changes what is on your feet.
 * 2. **Severity is honest.** `warning` is reserved for conditions that hurt people:
 *    thunderstorms on exposed ground, gusts that knock you over, finishing after dark.
 *    Spending it on a 40% chance of drizzle is how users learn to ignore the row.
 * 3. **A missing value is not a safe value.** Every threshold test is written so that
 *    `null` fails it. A forecast that does not know the freezing level must not read as a
 *    forecast that says the freezing level is fine.
 */

import type { UnitSystem, WeatherFlag, WeatherSample } from '@switchback/core';
import { formatDuration, formatElevation, formatSpeed, formatTemperature } from '@switchback/core';

/** Gusts that make exposed ground unpleasant, then genuinely hazardous. */
export const WIND_CAUTION_KMH = 40;
export const WIND_WARNING_KMH = 65;

/** Rain worth packing for, rather than every trace of moisture in the model. */
export const PRECIP_PROBABILITY_PCT = 50;
export const PRECIP_AMOUNT_MM = 0.5;

/** WMO codes for thunderstorm, with and without hail. */
export const THUNDERSTORM_CODES = new Set([95, 96, 99]);

export const UV_CAUTION = 8;
export const UV_WARNING = 11;

/** Apparent temperature — wind chill and humidity already folded in by the model. */
export const HEAT_CAUTION_C = 30;
export const HEAT_WARNING_C = 36;
export const COLD_CAUTION_C = -8;
export const COLD_WARNING_C = -18;

/** European AQI band boundaries: 60 begins "poor", 80 begins "very poor". */
export const AQI_CAUTION = 60;
export const AQI_WARNING = 80;

/**
 * How far past sunset counts as finishing in the dark.
 *
 * Not zero. Civil twilight gives roughly half an hour of usable light after the sun goes
 * down, and flagging a finish four minutes after sunset would be technically true and
 * practically noise.
 */
export const AFTER_DARK_GRACE_S = 30 * 60;

export interface FlagInput {
  samples: readonly WeatherSample[];
  /** Arrival instants, index-aligned with `samples`. */
  arrivalS: readonly number[];
  sunsetS: number | null;
  /** European AQI at each sample's arrival hour, when air quality was fetched. */
  aqi?: readonly (number | null)[];
  unitSystem: UnitSystem;
}

/**
 * Every flag the forecast supports, most severe first.
 *
 * Sorted rather than emitted in detection order so the UI can render the list as-is and the
 * first row is always the one that matters most. Within a severity, order follows the trail,
 * so a reader scanning down is also hiking forwards.
 */
export function deriveFlags(input: FlagInput): WeatherFlag[] {
  const { samples, unitSystem } = input;
  if (samples.length === 0) return [];

  const flags: WeatherFlag[] = [];
  const highest = highestSampleIndex(samples);

  // --- Freezing level ------------------------------------------------------------------
  // Checked at the high point only. Lower down it is either irrelevant or implied.
  const high = samples[highest];
  if (high && high.freezingLevelM !== null && high.freezingLevelM <= high.eleM) {
    flags.push({
      kind: 'freezing_level_below_summit',
      severity: 'warning',
      message:
        `Freezing level is around ${formatElevation(high.freezingLevelM, unitSystem)}, below the ` +
        `${formatElevation(high.eleM, unitSystem)} high point. Expect ice or old snow up there.`,
      sampleIndex: highest,
    });
  }

  // --- Wind ----------------------------------------------------------------------------
  const gustiest = extremeIndex(samples, (s) => s.windGustsKmh, 'max');
  const gusts = gustiest === null ? null : samples[gustiest]!.windGustsKmh;
  if (gustiest !== null && gusts !== null && gusts >= WIND_WARNING_KMH) {
    flags.push({
      kind: 'severe_wind',
      severity: 'warning',
      message:
        `Gusts to ${formatSpeed(gusts, unitSystem)} at ${samples[gustiest]!.label}. ` +
        `Strong enough to knock you off balance on exposed ground.`,
      sampleIndex: gustiest,
    });
  } else if (gustiest !== null && gusts !== null && gusts >= WIND_CAUTION_KMH) {
    flags.push({
      kind: 'high_wind',
      severity: 'caution',
      message: `Gusts to ${formatSpeed(gusts, unitSystem)} at ${samples[gustiest]!.label}.`,
      sampleIndex: gustiest,
    });
  }

  // --- Thunderstorms -------------------------------------------------------------------
  const storm = samples.findIndex(
    (s) => s.weatherCode !== null && THUNDERSTORM_CODES.has(s.weatherCode),
  );
  if (storm >= 0) {
    flags.push({
      kind: 'thunderstorm_risk',
      severity: 'warning',
      message:
        `Thunderstorms forecast around ${samples[storm]!.label}. ` +
        `Plan to be off ridges and summits before they arrive.`,
      sampleIndex: storm,
    });
  }

  // --- Rain ----------------------------------------------------------------------------
  const wettest = samples.findIndex(
    (s) =>
      (s.precipitationProbability !== null &&
        s.precipitationProbability >= PRECIP_PROBABILITY_PCT) ||
      (s.precipitationMm !== null && s.precipitationMm >= PRECIP_AMOUNT_MM),
  );
  if (wettest >= 0) {
    const probability = samples[wettest]!.precipitationProbability;
    flags.push({
      kind: 'precipitation_en_route',
      severity: 'caution',
      message:
        probability === null
          ? `Rain forecast around ${samples[wettest]!.label}, while you are out.`
          : `${Math.round(probability)}% chance of rain around ${samples[wettest]!.label}, ` +
            `while you are out.`,
      sampleIndex: wettest,
    });
  }

  // --- Darkness ------------------------------------------------------------------------
  const finishS = input.arrivalS[input.arrivalS.length - 1];
  if (input.sunsetS !== null && finishS !== undefined && finishS > input.sunsetS) {
    const overrunS = finishS - input.sunsetS;
    if (overrunS >= AFTER_DARK_GRACE_S) {
      flags.push({
        kind: 'finish_after_dark',
        severity: 'warning',
        message: `At this pace you finish about ${formatDuration(overrunS)} after sunset. Take a head torch.`,
        sampleIndex: samples.length - 1,
      });
    }
  }

  // --- UV ------------------------------------------------------------------------------
  const sunniest = extremeIndex(samples, (s) => s.uvIndex, 'max');
  const uv = sunniest === null ? null : samples[sunniest]!.uvIndex;
  if (sunniest !== null && uv !== null && uv >= UV_CAUTION) {
    flags.push({
      kind: 'extreme_uv',
      severity: uv >= UV_WARNING ? 'warning' : 'caution',
      message: `UV index reaches ${Math.round(uv)} around ${samples[sunniest]!.label}. Cover up.`,
      sampleIndex: sunniest,
    });
  }

  // --- Heat and cold -------------------------------------------------------------------
  const hottest = extremeIndex(samples, (s) => s.apparentTemperatureC, 'max');
  const heat = hottest === null ? null : samples[hottest]!.apparentTemperatureC;
  if (hottest !== null && heat !== null && heat >= HEAT_CAUTION_C) {
    flags.push({
      kind: 'extreme_heat',
      severity: heat >= HEAT_WARNING_C ? 'warning' : 'caution',
      message: `Feels like ${formatTemperature(heat, unitSystem)} around ${samples[hottest]!.label}. Carry more water than usual.`,
      sampleIndex: hottest,
    });
  }

  const coldest = extremeIndex(samples, (s) => s.apparentTemperatureC, 'min');
  const cold = coldest === null ? null : samples[coldest]!.apparentTemperatureC;
  if (coldest !== null && cold !== null && cold <= COLD_CAUTION_C) {
    flags.push({
      kind: 'extreme_cold',
      severity: cold <= COLD_WARNING_C ? 'warning' : 'caution',
      message: `Feels like ${formatTemperature(cold, unitSystem)} around ${samples[coldest]!.label} with the wind. Cover exposed skin.`,
      sampleIndex: coldest,
    });
  }

  // --- Air quality ---------------------------------------------------------------------
  if (input.aqi && input.aqi.length > 0) {
    let worst = -1;
    for (let i = 0; i < input.aqi.length; i++) {
      const value = input.aqi[i];
      if (value === null || value === undefined) continue;
      if (worst < 0 || value > (input.aqi[worst] ?? -Infinity)) worst = i;
    }
    const value = worst >= 0 ? input.aqi[worst] : null;
    if (worst >= 0 && value !== null && value !== undefined && value >= AQI_CAUTION) {
      flags.push({
        kind: 'poor_air_quality',
        severity: value >= AQI_WARNING ? 'warning' : 'caution',
        message:
          `Air quality index reaches ${Math.round(value)} — ` +
          `${value >= AQI_WARNING ? 'very poor' : 'poor'}. Worth knowing if you are sensitive to it.`,
        sampleIndex: samples[worst] ? worst : null,
      });
    }
  }

  return sortBySeverity(flags);
}

const SEVERITY_ORDER = { warning: 0, caution: 1, info: 2 } as const;

function sortBySeverity(flags: readonly WeatherFlag[]): WeatherFlag[] {
  return [...flags].sort((a, b) => {
    const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (a.sampleIndex ?? Infinity) - (b.sampleIndex ?? Infinity);
  });
}

function highestSampleIndex(samples: readonly WeatherSample[]): number {
  let best = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.eleM > samples[best]!.eleM) best = i;
  }
  return best;
}

/**
 * Index of the largest or smallest value of one field, skipping nulls.
 *
 * Returns null when every sample is null for that field, which is what keeps a forecast
 * with no UV data from reporting a UV index of zero — a number that would read as measured.
 */
function extremeIndex(
  samples: readonly WeatherSample[],
  pick: (s: WeatherSample) => number | null,
  mode: 'max' | 'min',
): number | null {
  let best: number | null = null;
  let bestValue = mode === 'max' ? -Infinity : Infinity;
  for (let i = 0; i < samples.length; i++) {
    const value = pick(samples[i]!);
    if (value === null) continue;
    if (mode === 'max' ? value > bestValue : value < bestValue) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}
