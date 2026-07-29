/**
 * Time helpers for a product where every displayed hour belongs to the trail, not to the
 * person reading the page.
 *
 * Someone in London planning a hike in the Cairngorms wants "summit at 11:20" to mean 11:20
 * *there*. Someone doing the same from New York wants the identical string. So the whole
 * feature is computed in epoch seconds — no ambiguity, no arithmetic on wall-clock strings —
 * and rendered once at the edge with the trail's own UTC offset, which Open-Meteo returns
 * alongside the forecast.
 *
 * Nothing here touches the host machine's timezone. `Date` is used only as an epoch→field
 * decoder via its `getUTC*` accessors, so the same input produces the same string on a
 * laptop in Cardiff, a Vercel function in Dublin, and a CI runner set to UTC.
 */

export const HOUR_S = 3600;
export const DAY_S = 86_400;

function pad(n: number, width = 2): string {
  return String(Math.abs(Math.trunc(n))).padStart(width, '0');
}

/**
 * An instant as ISO 8601 in the trail's local time, offset included.
 *
 * The offset is not decoration: `2026-07-27T11:20:00+01:00` survives a round trip through
 * any client, whereas `2026-07-27T11:20:00` is a different moment depending on who parses
 * it. `WeatherSample.arrivalAt` is consumed by two clients and a chart axis, so it carries
 * the offset.
 */
export function isoWithOffset(epochS: number, utcOffsetS: number): string {
  const local = new Date((epochS + utcOffsetS) * 1000);
  const sign = utcOffsetS < 0 ? '-' : '+';
  const hours = Math.floor(Math.abs(utcOffsetS) / HOUR_S);
  const minutes = Math.floor((Math.abs(utcOffsetS) % HOUR_S) / 60);
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `${sign}${pad(hours)}:${pad(minutes)}`
  );
}

/** Epoch seconds from an ISO 8601 string. Returns null rather than NaN on nonsense. */
export function epochSecondsFrom(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * A sensible default start when the caller did not name one: the next 07:00 local to the
 * trail that has not already passed.
 *
 * Defaulting to *now* would be worse than useless — nobody standing at their desk on
 * Tuesday afternoon is asking what the summit is doing this instant. They are asking about
 * a hike they have not started, and a dawn start is the assumption that makes the rest of
 * the forecast worth reading.
 */
export function defaultStartEpochS(nowS: number, utcOffsetS: number, startHourLocal = 7): number {
  const localNow = nowS + utcOffsetS;
  const localMidnight = Math.floor(localNow / DAY_S) * DAY_S;
  const todayStart = localMidnight + startHourLocal * HOUR_S;
  const localStart = todayStart > localNow ? todayStart : todayStart + DAY_S;
  return localStart - utcOffsetS;
}

/**
 * Index of the hourly slot covering `epochS` — the last entry at or before it.
 *
 * Nearest-hour rather than interpolated between hours, deliberately. The upstream model
 * resolves to the hour; smoothing between two of its values would invent a precision the
 * forecast does not have, and a summit temperature is exactly the number a user should not
 * be given false confidence in.
 *
 * Returns null when the instant falls outside the returned window, which is the honest
 * answer for a start date beyond the forecast horizon.
 */
export function hourIndexFor(timesS: readonly number[], epochS: number): number | null {
  if (timesS.length === 0) return null;
  const first = timesS[0]!;
  const last = timesS[timesS.length - 1]!;
  if (epochS < first || epochS >= last + HOUR_S) return null;

  let lo = 0;
  let hi = timesS.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (timesS[mid]! <= epochS) lo = mid;
    else hi = mid;
  }
  return timesS[hi]! <= epochS ? hi : lo;
}

/** Index of the daily entry whose local day contains `epochS`. */
export function dayIndexFor(daysS: readonly number[], epochS: number): number | null {
  for (let i = 0; i < daysS.length; i++) {
    const start = daysS[i]!;
    if (epochS >= start && epochS < start + DAY_S) return i;
  }
  return null;
}
