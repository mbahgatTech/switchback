/**
 * @switchback/weather — along-trail, time-shifted forecasts.
 *
 * `alongRouteForecast` is the whole surface most callers need. Everything else is exported
 * because the thresholds and the sampling rules are decisions people will want to read and
 * test against rather than discover from behaviour.
 */

export * from './air-quality';
export * from './along-route';
export * from './cache';
export * from './flags';
export * from './open-meteo';
export * from './sample';
export * from './time';
