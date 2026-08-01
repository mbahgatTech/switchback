import { z } from 'zod';

/** Along-trail weather: the line is sampled, each sample elevation-corrected, and each sample's
 * forecast read at that point's predicted arrival hour rather than at the trailhead. */

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
  /** Pace multiplier on Tobler's baseline. <1 is faster than average, >1 slower. */
  paceFactor: z.number().min(0.5).max(2.5).default(1),
  /** Include the return leg for out-and-back routes. */
  includeReturn: z.boolean().default(true),
});
export type AlongRouteRequest = z.infer<typeof alongRouteRequestSchema>;

/**
 * Air quality — the European AQI, and only the European AQI. The US AQI runs 0–500 on different
 * breakpoints, so the same air reads 65 on one scale and 91 on the other; the safety flags
 * (`AQI_CAUTION = 60`, `AQI_WARNING = 80`) are the EEA's "poor" and "very poor" boundaries, so
 * everything must speak that scale. Bands unaltered; the last is open-ended as the index is.
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
  // From the top, so the open-ended band needs no special case and a value on a boundary
  // reads as the band it opens.
  for (let i = AIR_QUALITY_BANDS.length - 1; i >= 0; i--) {
    const band = AIR_QUALITY_BANDS[i]!;
    if (aqi >= band.from) return band;
  }
  return AIR_QUALITY_BANDS[0];
}

/** The five pollutants the European AQI is built from. The index is the **worst** of the five,
 * not a blend, which is what makes naming the dominant one useful. */
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
  /** The model's grid spacing in degrees, so a reader can be told how much ground one number is
   * claiming — a 0.4° cell is most of a county. */
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
 * WMO 4677 present-weather codes as Open-Meteo emits them, in words. Here rather than in either
 * client so the two cannot word the same sky differently. Codes Open-Meteo never emits are
 * absent rather than guessed — an unknown code reads as an em dash.
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
 * Wind direction as a compass point — the direction the wind blows *from*, the meteorological
 * convention Open-Meteo follows. Sixteen points: on a ridge a westerly and a north-westerly are
 * the difference between shelter and none.
 */
export function compassPoint(degrees: number | null | undefined): string | null {
  if (degrees === null || degrees === undefined || !Number.isFinite(degrees)) return null;
  const index = Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16;
  return COMPASS_POINTS[index] ?? null;
}
