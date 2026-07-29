import { describe, expect, it } from 'vitest';
import { dayOfYear, daylightWindow, solarDeclinationDeg } from '../src/daylight';

const BEN_NEVIS = { lat: 56.7969, lng: -5.0036 };
const MIDSUMMER = 172; // 21 June
const MIDWINTER = 355; // 21 December
const EQUINOX = 81; // 22 March

describe('solarDeclinationDeg', () => {
  it('crosses zero at the equinoxes and peaks at the solstices', () => {
    expect(solarDeclinationDeg(EQUINOX)).toBeCloseTo(0, 6);
    expect(solarDeclinationDeg(MIDSUMMER)).toBeCloseTo(23.44, 1);
    expect(solarDeclinationDeg(MIDWINTER)).toBeCloseTo(-23.44, 1);
  });
});

describe('daylightWindow', () => {
  it('gives the equator twelve hours all year', () => {
    for (const day of [1, 90, 172, 266, 355]) {
      expect(daylightWindow(0, day).daylightHours).toBeCloseTo(12, 1);
    }
  });

  it('swings from six to eighteen hours in the Scottish Highlands', () => {
    const summer = daylightWindow(BEN_NEVIS.lat, MIDSUMMER, {
      lngDeg: BEN_NEVIS.lng,
      utcOffsetS: 3600,
    });
    const winter = daylightWindow(BEN_NEVIS.lat, MIDWINTER, {
      lngDeg: BEN_NEVIS.lng,
      utcOffsetS: 0,
    });

    // Geometric sunrise, so a few minutes short of the almanac's refracted figures — the
    // header says so. What matters is the season, and the season is eleven hours of it.
    expect(summer.daylightHours).toBeCloseTo(17.6, 0);
    expect(winter.daylightHours).toBeCloseTo(6.4, 0);
    expect(summer.daylightHours - winter.daylightHours).toBeGreaterThan(10);
  });

  it('puts sunrise and sunset either side of solar noon', () => {
    const window = daylightWindow(BEN_NEVIS.lat, MIDSUMMER, {
      lngDeg: BEN_NEVIS.lng,
      utcOffsetS: 3600,
    });
    expect(window.sunriseHour).toBeLessThan(window.solarNoonHour);
    expect(window.sunsetHour).toBeGreaterThan(window.solarNoonHour);
    expect(window.sunsetHour - window.sunriseHour).toBeCloseTo(window.daylightHours, 6);
    expect(window.polarDay).toBe(false);
    expect(window.polarNight).toBe(false);
  });

  it('shifts solar noon for longitude within a timezone', () => {
    // Both on UTC+1, 15° apart: an hour of real solar time between them, which is exactly
    // why western Spain eats so late.
    const east = daylightWindow(45, EQUINOX, { lngDeg: 15, utcOffsetS: 3600 });
    const west = daylightWindow(45, EQUINOX, { lngDeg: 0, utcOffsetS: 3600 });
    expect(east.solarNoonHour).toBeCloseTo(12, 6);
    expect(west.solarNoonHour).toBeCloseTo(13, 6);
  });

  it('guesses the timezone from longitude when it is not told', () => {
    const guessed = daylightWindow(45, EQUINOX, { lngDeg: 15 });
    expect(guessed.solarNoonHour).toBeCloseTo(12, 6);
  });

  it('handles polar day and polar night instead of returning NaN', () => {
    // Longyearbyen. `acos` of a value outside [-1, 1] is NaN, and a NaN sunrise would
    // propagate silently through every hour of the curve.
    const summer = daylightWindow(78.2, MIDSUMMER, { lngDeg: 15.6, utcOffsetS: 3600 });
    expect(summer.polarDay).toBe(true);
    expect(summer.daylightHours).toBe(24);
    expect(Number.isNaN(summer.sunriseHour)).toBe(false);

    const winter = daylightWindow(78.2, MIDWINTER, { lngDeg: 15.6, utcOffsetS: 3600 });
    expect(winter.polarNight).toBe(true);
    expect(winter.daylightHours).toBe(0);
    expect(winter.sunriseHour).toBe(winter.sunsetHour);
  });

  it('mirrors the hemispheres', () => {
    const north = daylightWindow(45, MIDSUMMER);
    const south = daylightWindow(-45, MIDSUMMER);
    expect(north.daylightHours + south.daylightHours).toBeCloseTo(24, 1);
  });
});

describe('dayOfYear', () => {
  it('counts from one, in UTC', () => {
    expect(dayOfYear(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(1);
    expect(dayOfYear(Date.UTC(2026, 0, 1, 23, 59, 59))).toBe(1);
    expect(dayOfYear(Date.UTC(2026, 11, 31))).toBe(365);
    expect(dayOfYear(Date.UTC(2024, 11, 31))).toBe(366);
    expect(dayOfYear(Date.UTC(2026, 5, 21))).toBe(172);
  });
});
