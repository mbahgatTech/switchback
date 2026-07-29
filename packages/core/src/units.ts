/**
 * Unit handling. Everything is stored and computed in SI (metres, seconds, °C) and
 * converted only at the render boundary — a rule worth keeping strictly, because
 * mixed-unit arithmetic in a hiking app produces errors that put people on a
 * mountain with the wrong expectations.
 */

export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

/**
 * Exact conversion factors, exported because a second copy is a second chance to be wrong.
 *
 * `@switchback/geo` needs these to pick an axis step in feet or miles and convert it back to
 * the metres it plots in. It could hardcode 1609.344 — and then this file and that one would
 * be two places that have to agree forever about a number nobody re-checks.
 */
export const METRES_PER_MILE = 1609.344;
export const METRES_PER_FOOT = 0.3048;

const M_PER_MI = METRES_PER_MILE;
const M_PER_FT = METRES_PER_FOOT;

export function metresToMiles(m: number): number {
  return m / M_PER_MI;
}
export function metresToFeet(m: number): number {
  return m / M_PER_FT;
}
export function milesToMetres(mi: number): number {
  return mi * M_PER_MI;
}
export function feetToMetres(ft: number): number {
  return ft * M_PER_FT;
}
export function celsiusToFahrenheit(c: number): number {
  return c * 1.8 + 32;
}

/**
 * The unit a distance or a height is *in*, with no number attached.
 *
 * A chart axis says its unit once, in the margin, and then prints bare numbers under every
 * tick — repeating "km" forty times is how you turn an axis into a list. Everything else in
 * this file answers "what is this quantity", so it returns the number and the unit together;
 * these two answer "what are these numbers", which an axis asks separately.
 */
export const DISTANCE_UNIT: Record<UnitSystem, string> = { metric: 'km', imperial: 'mi' };
export const ELEVATION_UNIT: Record<UnitSystem, string> = { metric: 'm', imperial: 'ft' };

/**
 * A distance for an axis tick: bare, one decimal, in the reader's unit.
 *
 * One decimal rather than the precision the step would allow, so the axis and the stat block
 * agree. {@link formatDistance} rounds a 0.652 mi trail to `0.7 mi`; an axis that printed its
 * own end as `0.65` would be the same page giving two answers, and the reader has no way to
 * know which one is the trail. The step ladder in `@switchback/geo` is chosen so that every
 * tick below the end is exactly representable here — that is what keeps the row round.
 */
export function axisDistance(metres: number, system: UnitSystem): string {
  if (!Number.isFinite(metres)) return '—';
  return (system === 'imperial' ? metresToMiles(metres) : metres / 1000).toFixed(1);
}

/**
 * A height for an axis tick: bare, whole units, grouped.
 *
 * Grouped because the imperial ladder reaches five figures — `10000` on a gridline is a
 * number the eye has to count digits to read, and `10,000` is not. Fixed to `en-GB` rather
 * than the machine locale so the two clients and the printed sheet agree on the separator;
 * a section rendered on a phone set to German is still the same drawing.
 */
export function axisElevation(metres: number, system: UnitSystem): string {
  if (!Number.isFinite(metres)) return '—';
  const value = system === 'imperial' ? metresToFeet(metres) : metres;
  return Math.round(value).toLocaleString('en-GB');
}

/**
 * Trail length, in the unit system the reader chose.
 *
 * One decimal all the way to three figures, then none. The decimal is dropped late rather
 * than early because a hike's own section axis runs to its true end — `13.9` — and a stat
 * block that rounds the same quantity to `14 km` two hundred pixels above it is the page
 * contradicting itself. Past a hundred units nobody is counting the last four hundred
 * metres of a thousand-kilometre route, and the decimal becomes noise.
 */
export function formatDistance(metres: number, system: UnitSystem): string {
  if (!Number.isFinite(metres)) return '—';
  if (system === 'imperial') {
    const mi = metresToMiles(metres);
    return mi < 0.1
      ? `${Math.round(metresToFeet(metres))} ft`
      : `${round(mi, mi < 100 ? 1 : 0)} mi`;
  }
  const km = metres / 1000;
  return km < 1 ? `${Math.round(metres)} m` : `${round(km, km < 100 ? 1 : 0)} km`;
}

/** Elevation gain/loss or altitude. Always whole units — decimals imply false precision. */
export function formatElevation(metres: number, system: UnitSystem): string {
  if (!Number.isFinite(metres)) return '—';
  return system === 'imperial'
    ? `${Math.round(metresToFeet(metres)).toLocaleString()} ft`
    : `${Math.round(metres).toLocaleString()} m`;
}

export function formatTemperature(celsius: number, system: UnitSystem): string {
  if (!Number.isFinite(celsius)) return '—';
  return system === 'imperial'
    ? `${Math.round(celsiusToFahrenheit(celsius))}°F`
    : `${Math.round(celsius)}°C`;
}

/** Wind and gusts. km/h reads better than m/s for a general audience. */
export function formatSpeed(kmh: number, system: UnitSystem): string {
  if (!Number.isFinite(kmh)) return '—';
  return system === 'imperial' ? `${Math.round(kmh / 1.609344)} mph` : `${Math.round(kmh)} km/h`;
}

/** Durations read as "3h 40m" / "45m" — never "3.67 hours". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.round(seconds / 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * A lifetime on foot, rather than one trail's estimate.
 *
 * Past a couple of days the minutes are noise: "720h 6m" offers six minutes of precision on
 * a figure assembled from modelled hiking speeds over hundreds of hikes. Below that
 * threshold the minutes are most of the number, so they stay.
 *
 * Separate from {@link formatDuration} rather than folded into it, because a trail's own
 * estimate is never long enough to trip the threshold and would only lose precision it has
 * every right to — a 50-hour thru-hike leg reading "50h" is fine, a 3h 40m hike reading "4h"
 * is not.
 */
export function formatTimeOnFoot(seconds: number): string {
  return formatDuration(seconds >= 48 * 3600 ? Math.round(seconds / 3600) * 3600 : seconds);
}

/**
 * A running clock: `1:12:04`, or `12:04` under the hour.
 *
 * Distinct from {@link formatDuration} because the two answer different questions. "3h 40m"
 * is how long a hike *takes* — a rounded estimate, read once, before setting off. This is the
 * elapsed time on a recording that is still happening, and it has to tick: a clock that reads
 * "45m" for sixty seconds at a time looks stopped, which on the one screen where the reader
 * is checking that something is still running is the worst thing it could look like.
 *
 * The hours field is dropped rather than shown as `0:12:04`, and the minutes are padded only
 * once there are hours to pad them against — so the number grows leftward as the hike does,
 * and never jitters in width within a single unit.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Pace, in minutes and seconds per kilometre or mile.
 *
 * Hikers and runners read pace; only cyclists read speed. The two are reciprocals, so this
 * could be derived at every call site — and would be, differently, at each one. Note the
 * argument is *seconds per unit* rather than metres per second: `Split.paceSPerUnit` is
 * already in those terms, and converting on the way in would mean converting back out.
 *
 * A pace slower than about a minute and a half per metre is not a pace, it is a stop, so the
 * upper bound reads as a dash rather than as `240:00`.
 */
export function formatPace(secondsPerUnit: number, system: UnitSystem): string {
  const suffix = system === 'imperial' ? '/mi' : '/km';
  if (!Number.isFinite(secondsPerUnit) || secondsPerUnit <= 0 || secondsPerUnit > 3 * 3600) {
    return `— ${suffix}`;
  }
  const total = Math.round(secondsPerUnit);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')} ${suffix}`;
}

/** Metres per second as pace, in the reader's units. Null in, dash out. */
export function paceFromSpeed(mps: number | null | undefined, system: UnitSystem): string {
  if (mps == null || !Number.isFinite(mps) || mps <= 0) {
    return `— ${system === 'imperial' ? '/mi' : '/km'}`;
  }
  const unitM = system === 'imperial' ? M_PER_MI : 1_000;
  return formatPace(unitM / mps, system);
}

function round(n: number, dp: number): string {
  return n.toFixed(dp);
}
