import { z } from 'zod';

/**
 * Along-trail weather — the feature this product is built around.
 *
 * AllTrails forecasts one point: the trailhead. That is the least useful place on the
 * trail to know about, because it is the warmest, the most sheltered, and the one you
 * can see out the car window. What matters is what the ridge is doing at the hour you
 * will be standing on it. So we sample the line, elevation-correct each sample, and
 * shift each sample's forecast to that point's predicted arrival time.
 */

export const WEATHER_SEVERITIES = ['info', 'caution', 'warning'] as const;
export type WeatherSeverity = (typeof WEATHER_SEVERITIES)[number];

export const WEATHER_FLAG_KINDS = [
  /** Freezing level sits below the trail's high point — expect ice or snow up there. */
  'freezing_level_below_summit',
  /** Gusts strong enough to affect balance on exposed ground. */
  'high_wind',
  'severe_wind',
  /** Precipitation starts while you are predicted to be out. */
  'precipitation_en_route',
  'thunderstorm_risk',
  /** Predicted finish is after sunset. */
  'finish_after_dark',
  'extreme_uv',
  'extreme_heat',
  'extreme_cold',
  'poor_air_quality',
] as const;
export type WeatherFlagKind = (typeof WEATHER_FLAG_KINDS)[number];

export const weatherFlagSchema = z.object({
  kind: z.enum(WEATHER_FLAG_KINDS),
  severity: z.enum(WEATHER_SEVERITIES),
  /** Human-readable, already unit-formatted by the server for the user's system. */
  message: z.string(),
  /** Index into `samples` where the condition applies, when point-specific. */
  sampleIndex: z.number().int().nonnegative().nullable(),
});
export type WeatherFlag = z.infer<typeof weatherFlagSchema>;

export const weatherSampleSchema = z.object({
  /** Position along the trail. */
  distM: z.number().nonnegative(),
  lng: z.number(),
  lat: z.number(),
  eleM: z.number(),
  /** Short label: "Trailhead", "Summit", "4.2 km". */
  label: z.string(),
  /** Predicted arrival, ISO 8601 with offset. This is what the forecast is read at. */
  arrivalAt: z.string(),
  /** Cumulative moving time from the start, in seconds. */
  elapsedS: z.number().nonnegative(),

  temperatureC: z.number().nullable(),
  apparentTemperatureC: z.number().nullable(),
  precipitationProbability: z.number().min(0).max(100).nullable(),
  precipitationMm: z.number().nonnegative().nullable(),
  windSpeedKmh: z.number().nonnegative().nullable(),
  windGustsKmh: z.number().nonnegative().nullable(),
  windDirectionDeg: z.number().min(0).max(360).nullable(),
  cloudCoverPct: z.number().min(0).max(100).nullable(),
  uvIndex: z.number().nonnegative().nullable(),
  /** Altitude of the 0 °C isotherm in metres — compared against this sample's eleM. */
  freezingLevelM: z.number().nullable(),
  /** WMO weather interpretation code. */
  weatherCode: z.number().int().nullable(),
  isDaylight: z.boolean().nullable(),
});
export type WeatherSample = z.infer<typeof weatherSampleSchema>;

export const alongRouteForecastSchema = z.object({
  trailId: z.string(),
  /** The start time the ETAs were computed from, ISO 8601 with offset. */
  startAt: z.string(),
  /** IANA zone the trail sits in; all displayed times are local to the trail. */
  timezone: z.string(),
  /** Pace multiplier applied to Tobler; 1.0 = average fitness. */
  paceFactor: z.number().positive(),
  samples: z.array(weatherSampleSchema),
  flags: z.array(weatherFlagSchema),
  sunriseAt: z.string().nullable(),
  sunsetAt: z.string().nullable(),
  /** When this forecast was fetched upstream — forecasts go stale within the hour. */
  fetchedAt: z.string(),
  /** Upstream model run, surfaced so users can judge freshness. */
  model: z.string().nullable(),
});
export type AlongRouteForecast = z.infer<typeof alongRouteForecastSchema>;

export const alongRouteRequestSchema = z.object({
  trailId: z.string(),
  /** Defaults to the next sensible start (tomorrow morning) when omitted. */
  startAt: z.string().datetime({ offset: true }).optional(),
  /**
   * Pace multiplier on Tobler's baseline. <1 is faster than average, >1 slower.
   * Surfaced in the UI as Fast / Average / Relaxed rather than as a number.
   */
  paceFactor: z.number().min(0.5).max(2.5).default(1),
  /** Include the return leg for out-and-back routes. */
  includeReturn: z.boolean().default(true),
});
export type AlongRouteRequest = z.infer<typeof alongRouteRequestSchema>;

/**
 * Air quality — the European AQI, and only the European AQI.
 *
 * There are two scales on offer upstream and picking both would be the worst outcome: the
 * US AQI runs 0–500 on different breakpoints, so the same air is 65 on one scale and 91 on
 * the other, and a map that paints one while the safety flags below it quote the other is a
 * product arguing with itself. The flags were written against the European bands first
 * (`AQI_CAUTION = 60`, `AQI_WARNING = 80` are the "poor" and "very poor" boundaries), so
 * that is the scale everything speaks.
 *
 * The bands are the EEA's own, unaltered. Six of them, and the last is open-ended because
 * the index is: above 100 there is no ceiling, only worse.
 */
export const AIR_QUALITY_BANDS = [
  { from: 0, to: 20, label: 'Good' },
  { from: 20, to: 40, label: 'Fair' },
  { from: 40, to: 60, label: 'Moderate' },
  { from: 60, to: 80, label: 'Poor' },
  { from: 80, to: 100, label: 'Very poor' },
  { from: 100, to: null, label: 'Extremely poor' },
] as const;

export type AirQualityBand = (typeof AIR_QUALITY_BANDS)[number];

/** Which band a reading falls in, or `null` when there is no reading. */
export function europeanAqiBand(aqi: number | null | undefined): AirQualityBand | null {
  if (aqi === null || aqi === undefined || !Number.isFinite(aqi)) return null;
  // Hiked from the top so the open-ended band catches anything above 100 without a
  // special case, and so a value sitting exactly on a boundary reads as the band it opens.
  for (let i = AIR_QUALITY_BANDS.length - 1; i >= 0; i--) {
    const band = AIR_QUALITY_BANDS[i]!;
    if (aqi >= band.from) return band;
  }
  return AIR_QUALITY_BANDS[0];
}

/**
 * The five pollutants the European AQI is built from, with the sub-index each contributes.
 *
 * The overall index is the **worst** of the five, not a blend — which is what makes naming
 * the dominant one worth doing. "AQI 65" is a number; "65, driven by ozone" tells a hiker
 * that it will be worse on an exposed ridge in the afternoon sun than in the trees, and
 * that is a decision they can act on.
 */
export const AIR_QUALITY_POLLUTANTS = ['pm2_5', 'pm10', 'no2', 'o3', 'so2'] as const;
export type AirQualityPollutant = (typeof AIR_QUALITY_POLLUTANTS)[number];

export const AIR_QUALITY_POLLUTANT_LABELS: Readonly<Record<AirQualityPollutant, string>> = {
  pm2_5: 'fine particulates',
  pm10: 'coarse particulates',
  no2: 'nitrogen dioxide',
  o3: 'ozone',
  so2: 'sulphur dioxide',
};

export const airQualityCellSchema = z.object({
  /** Model cell centre as the upstream model resolved it, not the point we asked about. */
  lng: z.number(),
  lat: z.number(),
  /** The cell's own footprint, `[w, s, e, n]`. One model cell, drawn at its true size. */
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  europeanAqi: z.number().nullable(),
});
export type AirQualityCell = z.infer<typeof airQualityCellSchema>;

export const airQualityGridSchema = z.object({
  cells: z.array(airQualityCellSchema),
  /** Upstream model behind these numbers, named so the key can say whose answer this is. */
  model: z.string(),
  /** The model's own grid spacing in degrees. The cells are never drawn finer than this. */
  stepDeg: z.number().positive(),
  /** The hour these readings are for, ISO 8601 UTC. */
  observedAt: z.string(),
  /** True when the viewport was wider than the cell cap and the grid was coarsened. */
  coarsened: z.boolean(),
});
export type AirQualityGrid = z.infer<typeof airQualityGridSchema>;

export const airQualityGridRequestSchema = z.object({
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});
export type AirQualityGridRequest = z.infer<typeof airQualityGridRequestSchema>;

export const airQualityReadingSchema = z.object({
  lng: z.number(),
  lat: z.number(),
  europeanAqi: z.number().nullable(),
  /** Fine particulates in µg/m³ — the one raw concentration worth printing. */
  pm25: z.number().nullable(),
  /** Whichever pollutant the index is currently worst on, or `null` when nothing is. */
  dominant: z.enum(AIR_QUALITY_POLLUTANTS).nullable(),
  model: z.string(),
  /**
   * The model's grid spacing in degrees, carried so a reader can be told how much ground
   * this one number is claiming. A 0.4° cell is most of a county, and a page that prints
   * "47" over a valley without saying so has overstated its own precision by two orders.
   */
  stepDeg: z.number().positive(),
  observedAt: z.string(),
});
export type AirQualityReading = z.infer<typeof airQualityReadingSchema>;

export const airQualityAtRequestSchema = z.object({
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
});
export type AirQualityAtRequest = z.infer<typeof airQualityAtRequestSchema>;

/**
 * WMO 4677 present-weather codes, as Open-Meteo emits them, in words.
 *
 * Kept here rather than in either client because the two of them must agree: a website
 * that says "Heavy rain" where the phone says "Rain, heavy" is two products. The wording
 * is deliberately short — these land in a table column beside a temperature and a wind
 * speed, and a phrase that wraps costs a row its scannability.
 *
 * Codes Open-Meteo never emits are absent rather than filled in with guesses; an unknown
 * code reads as an em dash, which is honest, instead of a wrong sky.
 */
export const WEATHER_CODE_LABELS: Readonly<Record<number, string>> = {
  0: 'Clear',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Freezing fog',
  51: 'Light drizzle',
  53: 'Drizzle',
  55: 'Heavy drizzle',
  56: 'Freezing drizzle',
  57: 'Freezing drizzle',
  61: 'Light rain',
  63: 'Rain',
  65: 'Heavy rain',
  66: 'Freezing rain',
  67: 'Freezing rain',
  71: 'Light snow',
  73: 'Snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Rain showers',
  81: 'Rain showers',
  82: 'Violent showers',
  85: 'Snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm, hail',
  99: 'Thunderstorm, hail',
};

/** The sky in two or three words, or `null` when upstream did not say. */
export function weatherCodeLabel(code: number | null | undefined): string | null {
  if (code === null || code === undefined) return null;
  return WEATHER_CODE_LABELS[code] ?? null;
}

const COMPASS_POINTS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
] as const;

/**
 * Wind direction as a compass point — the direction the wind blows *from*, which is the
 * meteorological convention Open-Meteo follows and the one a hiker facing into it means.
 *
 * Sixteen points rather than eight: on a ridge the difference between a westerly and a
 * north-westerly is the difference between shelter and none.
 */
export function compassPoint(degrees: number | null | undefined): string | null {
  if (degrees === null || degrees === undefined || !Number.isFinite(degrees)) return null;
  const index = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_POINTS[index] ?? null;
}
