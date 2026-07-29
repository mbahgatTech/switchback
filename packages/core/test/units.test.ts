import { describe, expect, it } from 'vitest';
import {
  celsiusToFahrenheit,
  formatDistance,
  formatDuration,
  formatElevation,
  formatSpeed,
  formatTemperature,
  metresToFeet,
  metresToMiles,
} from '@switchback/core';

describe('conversions', () => {
  it('uses the exact international definitions', () => {
    expect(metresToMiles(1609.344)).toBe(1);
    expect(metresToFeet(0.3048)).toBe(1);
    expect(celsiusToFahrenheit(0)).toBe(32);
    expect(celsiusToFahrenheit(100)).toBe(212);
    expect(celsiusToFahrenheit(-40)).toBe(-40);
  });
});

describe('formatDistance', () => {
  it('drops to metres below a kilometre', () => {
    expect(formatDistance(850, 'metric')).toBe('850 m');
  });

  it('keeps one decimal to three figures and drops it beyond', () => {
    expect(formatDistance(8420, 'metric')).toBe('8.4 km');
    expect(formatDistance(8470, 'metric')).toBe('8.5 km');
    // The case that made the rule: a hike whose section axis ends at 13.9 must not be
    // labelled 14 km in the stat block directly above it.
    expect(formatDistance(13_883, 'metric')).toBe('13.9 km');
    expect(formatDistance(23_400, 'metric')).toBe('23.4 km');
    // The Pacific Crest Trail. Four decimetres of a 4,270 km route is not information.
    expect(formatDistance(4_270_400, 'metric')).toBe('4270 km');
  });

  it('drops to feet below a tenth of a mile', () => {
    expect(formatDistance(100, 'imperial')).toBe('328 ft');
  });

  it('shows miles with one decimal to three figures', () => {
    expect(formatDistance(1609.344 * 5.25, 'imperial')).toBe('5.3 mi');
    expect(formatDistance(1609.344 * 62.35, 'imperial')).toBe('62.4 mi');
    expect(formatDistance(1609.344 * 2653.4, 'imperial')).toBe('2653 mi');
  });

  it('renders non-finite input as an em dash rather than NaN', () => {
    expect(formatDistance(Number.NaN, 'metric')).toBe('—');
  });
});

describe('formatElevation', () => {
  it('never implies sub-metre precision', () => {
    expect(formatElevation(1234.7, 'metric')).toBe('1,235 m');
    expect(formatElevation(1000, 'imperial')).toBe('3,281 ft');
  });
});

describe('formatTemperature and formatSpeed', () => {
  it('rounds to whole units', () => {
    expect(formatTemperature(-1.4, 'metric')).toBe('-1°C');
    expect(formatTemperature(0, 'imperial')).toBe('32°F');
    expect(formatSpeed(61.2, 'metric')).toBe('61 km/h');
    expect(formatSpeed(80.4672, 'imperial')).toBe('50 mph');
  });
});

describe('formatDuration', () => {
  it('reads as hours and minutes, never decimal hours', () => {
    expect(formatDuration(13_200)).toBe('3h 40m');
    expect(formatDuration(2700)).toBe('45m');
    expect(formatDuration(7200)).toBe('2h');
    expect(formatDuration(0)).toBe('0m');
  });

  it('rejects nonsense rather than rendering it', () => {
    expect(formatDuration(-5)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
  });
});
