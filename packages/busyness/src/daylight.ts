/**
 * When it is light, which is when people hike. The curve is anchored to sunrise and sunset
 * rather than to fixed clock hours, so it moves with the season on its own.
 *
 * Standard low-precision solar position: declination from day of year, then the sunrise hour
 * angle. Two deliberate omissions, neither visible at hourly resolution — no equation of time
 * (±16 min across the year), and no refraction or solar-disc correction, so sunrise here is
 * geometric and runs a few minutes later than an almanac's.
 */

const DEG = Math.PI / 180;

/** Earth's axial tilt. The amplitude of the whole seasonal swing. */
export const OBLIQUITY_DEG = 23.44;

export interface DaylightWindow {
  /** Local clock hour of sunrise, fractional. */
  sunriseHour: number;
  sunsetHour: number;
  /** Hours between them. `0` for polar night, `24` for polar day. */
  daylightHours: number;
  /** Local clock hour the sun is highest. Midpoint of the window. */
  solarNoonHour: number;
  polarNight: boolean;
  polarDay: boolean;
}

/**
 * Solar declination for a day of the year, in degrees; positive in the northern summer. The
 * phase is written against day 81 because that is the March equinox, where declination crosses
 * zero heading north.
 */
export function solarDeclinationDeg(dayOfYear: number): number {
  return OBLIQUITY_DEG * Math.sin(((2 * Math.PI) / 365.24) * (dayOfYear - 81));
}

export interface DaylightOptions {
  /** Longitude in degrees, for the offset between clock noon and solar noon. */
  lngDeg?: number;
  /**
   * The trail's UTC offset in seconds, including DST. Supply it when known: a timezone is a
   * political fact, and guessing from longitude puts Vigo an hour out and most of China three.
   */
  utcOffsetS?: number;
}

/**
 * Sunrise, sunset and solar noon in local clock hours. With no `utcOffsetS` the timezone is
 * guessed from longitude — never worse than an hour or so, which an hour-wide bar absorbs.
 */
export function daylightWindow(
  latDeg: number,
  dayOfYear: number,
  options: DaylightOptions = {},
): DaylightWindow {
  const lngDeg = options.lngDeg ?? 0;
  const offsetH = (options.utcOffsetS ?? Math.round(lngDeg / 15) * 3600) / 3600;

  // Clock time runs ahead of solar time by how far east of its meridian the trail sits.
  const solarNoonHour = clamp(12 - lngDeg / 15 + offsetH, 0, 24);

  const declination = solarDeclinationDeg(dayOfYear);
  const cosH = -Math.tan(latDeg * DEG) * Math.tan(declination * DEG);

  // Inside the polar circles the sun never crosses the horizon and `acos` would return NaN.
  if (cosH <= -1) {
    return {
      sunriseHour: 0,
      sunsetHour: 24,
      daylightHours: 24,
      solarNoonHour,
      polarNight: false,
      polarDay: true,
    };
  }
  if (cosH >= 1) {
    return {
      sunriseHour: solarNoonHour,
      sunsetHour: solarNoonHour,
      daylightHours: 0,
      solarNoonHour,
      polarNight: true,
      polarDay: false,
    };
  }

  const halfDayH = Math.acos(cosH) / DEG / 15;
  return {
    sunriseHour: solarNoonHour - halfDayH,
    sunsetHour: solarNoonHour + halfDayH,
    daylightHours: 2 * halfDayH,
    solarNoonHour,
    polarNight: false,
    polarDay: false,
  };
}

/** 1–366, in UTC. The season is a whole-day quantity; the hour it is read at cannot matter. */
export function dayOfYear(epochMs: number): number {
  const date = new Date(epochMs);
  const startOfYear = Date.UTC(date.getUTCFullYear(), 0, 1);
  return (
    Math.floor(
      (Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - startOfYear) /
        86_400_000,
    ) + 1
  );
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}
