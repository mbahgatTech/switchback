/**
 * When it is light, which is when people hike.
 *
 * Busy times are usually drawn as fixed clock hours — a morning peak at 10:00, an afternoon
 * one at 14:00 — and that is wrong twice over. In Fort William in December the sun rises at
 * 08:50 and sets at 15:35; a "10:00 morning peak" is barely an hour after first light, and
 * an "afternoon peak" would sit in the dark. Anchoring the curve to sunrise and sunset
 * instead makes the model move with the season on its own, and it is what lets the
 * recommendation refuse to suggest a start that cannot finish before dark.
 *
 * The astronomy is the standard low-precision solar position: declination from the day of
 * the year, then the sunrise hour angle. Accurate to a few minutes, against a curve whose
 * resolution is one hour. Two deliberate omissions, both stated rather than hidden:
 *
 * - **No equation of time.** It shifts solar noon by at most ±16 minutes across the year.
 * - **No refraction or solar-disc correction.** Sunrise here is geometric — the centre of
 *   the sun crossing the horizon — which runs a few minutes later than the almanac's.
 *
 * Neither is visible at hourly resolution, and carrying them would imply a precision this
 * model does not have anywhere else.
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
 * Solar declination for a day of the year, in degrees.
 *
 * Positive in the northern summer. Day 81 is the March equinox, where the sine is zero and
 * declination crosses through zero on its way north — which is why the phase is written
 * against 81 rather than against January.
 */
export function solarDeclinationDeg(dayOfYear: number): number {
  return OBLIQUITY_DEG * Math.sin(((2 * Math.PI) / 365.24) * (dayOfYear - 81));
}

export interface DaylightOptions {
  /** Longitude in degrees, for the offset between clock noon and solar noon. */
  lngDeg?: number;
  /**
   * The trail's UTC offset in seconds, including DST. Supply it when known — the timezone
   * a trail sits in is a political fact, not a geometric one, and guessing from longitude
   * alone puts Vigo an hour out and most of China three.
   */
  utcOffsetS?: number;
}

/**
 * Sunrise, sunset and solar noon in local clock hours.
 *
 * With no `utcOffsetS` the timezone is guessed from longitude, which is right for most of
 * the world and never worse than an hour or so — enough for a curve read in hour-wide bars,
 * and the caller can do better whenever it has been told the real offset.
 */
export function daylightWindow(
  latDeg: number,
  dayOfYear: number,
  options: DaylightOptions = {},
): DaylightWindow {
  const lngDeg = options.lngDeg ?? 0;
  const offsetH = (options.utcOffsetS ?? Math.round(lngDeg / 15) * 3600) / 3600;

  // Clock time runs ahead of local solar time by however far the trail sits east of its
  // timezone's meridian.
  const solarNoonHour = clamp(12 - lngDeg / 15 + offsetH, 0, 24);

  const declination = solarDeclinationDeg(dayOfYear);
  const cosH = -Math.tan(latDeg * DEG) * Math.tan(declination * DEG);

  // Inside the polar circles the sun does not cross the horizon at all, and `acos` would
  // return NaN rather than saying so. Both cases are real places with real trails.
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
