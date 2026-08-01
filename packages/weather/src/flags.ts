/**
 * Turning a forecast into advice: the small set of conditions that would change whether, or how,
 * someone sets off. Each flag names the place it applies to.
 *
 * Three rules govern everything here:
 * 1. A flag has to be actionable. "Partly cloudy" is not one; freezing level below the summit is.
 * 2. `warning` is reserved for conditions that hurt people. Spending it on a 40% chance of
 *    drizzle teaches readers to ignore the row.
 * 3. A missing value is not a safe value — every threshold test is written so `null` fails it.
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
 * How far past sunset counts as finishing in the dark. Not zero: civil twilight gives roughly
 * half an hour of usable light, so a finish four minutes after sunset is noise.
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
 * Every flag the forecast supports, most severe first, so the UI can render the list as-is.
 * Within a severity, order follows the trail.
 */
export function deriveFlags(input: FlagInput): WeatherFlag[] {
  const { samples, unitSystem } = input;
  if (samples.length === 0) return [];

  const flags: WeatherFlag[] = [];
  const highest = highestSampleIndex(samples);

  // Freezing level is checked at the high point only; lower down it is irrelevant or implied.
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
 * Index of the largest or smallest value of one field, skipping nulls. Returns null when every
 * sample is null, so a forecast with no UV data does not report a UV index of zero.
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
