/** Unit handling. Everything is stored and computed in SI (metres, seconds, °C) and converted
 * only at the render boundary. */

export const UNIT_SYSTEMS = ['metric', 'imperial'] as const;
export type UnitSystem = (typeof UNIT_SYSTEMS)[number];

/** Exact conversion factors. Exported so `@switchback/geo` shares them rather than hardcoding. */
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

/** The unit alone, for a chart axis that names it once in the margin. */
export const DISTANCE_UNIT: Record<UnitSystem, string> = { metric: 'km', imperial: 'mi' };
export const ELEVATION_UNIT: Record<UnitSystem, string> = { metric: 'm', imperial: 'ft' };

/** A distance for an axis tick: bare, one decimal, in the reader's unit. One decimal rather than
 * the step's own precision, so the axis and the stat block cannot print two answers for the same
 * quantity; `@switchback/geo`'s step ladder is chosen to stay exactly representable here. */
export function axisDistance(metres: number, system: UnitSystem): string {
  if (!Number.isFinite(metres)) return '—';
  return (system === 'imperial' ? metresToMiles(metres) : metres / 1000).toFixed(1);
}

/** A height for an axis tick: bare, whole units, grouped. Pinned to `en-GB` rather than the
 * machine locale so both clients and the printed sheet agree on the separator. */
export function axisElevation(metres: number, system: UnitSystem): string {
  if (!Number.isFinite(metres)) return '—';
  const value = system === 'imperial' ? metresToFeet(metres) : metres;
  return Math.round(value).toLocaleString('en-GB');
}

/** Trail length, in the reader's units. One decimal to three figures, then none — the decimal is
 * dropped late so a stat block cannot round a quantity its own section axis prints in full. */
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

/** A lifetime on foot. Past two days the minutes are noise on a figure assembled from modelled
 * speeds. Separate from {@link formatDuration}, whose inputs never reach that threshold. */
export function formatTimeOnFoot(seconds: number): string {
  return formatDuration(seconds >= 48 * 3600 ? Math.round(seconds / 3600) * 3600 : seconds);
}

/** A running clock: `1:12:04`, or `12:04` under the hour. Distinct from {@link formatDuration},
 * which rounds: this ticks, on the one screen where a stopped-looking clock would be worst.
 * Minutes are padded only once there are hours to pad them against. */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** Pace, in minutes and seconds per kilometre or mile. The argument is *seconds per unit*, not
 * metres per second, because `Split.paceSPerUnit` is already in those terms. Anything slower
 * than three hours per unit is a stop, not a pace, and reads as a dash. */
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
