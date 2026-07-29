/**
 * Wall-clock arithmetic on ISO strings that already carry their own offset.
 *
 * Every instant this product shows a user is local to the *trail*, not to the device
 * holding the screen — a hiker in London planning Mont Blanc wants 07:00 at the hut, not
 * 06:00 because their phone is on GMT. The API already answers that way: `startAt` comes
 * back as `2026-07-27T07:00:00+02:00`, which is the local wall time with the trail's real
 * offset appended, resolved server-side from a proper timezone database.
 *
 * So the client never needs a timezone database of its own. Given one such string it can
 * build any other start time by string surgery — swap the date, swap the hour, keep the
 * offset — and the server resolves the resulting instant correctly. That matters more than
 * it sounds: `Intl.DateTimeFormat` with a `timeZone` option is the obvious alternative and
 * it is not reliably available on Hermes, so the iOS app would need a polyfill measured in
 * hundreds of kilobytes to do what these forty lines do exactly.
 *
 * The one thing this cannot do is cross a DST boundary: a start seven days out is built
 * with today's offset, so twice a year the far end of the week lands an hour off the hour
 * the user picked. The alternative is shipping a zone database to fix a one-hour error on
 * two days a year, and that is not a trade worth making.
 */

const ISO_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const DAY_MS = 86_400_000;

export interface LocalStamp {
  /** `YYYY-MM-DD`, local to the trail. */
  date: string;
  /** `HH:MM`, local to the trail. */
  time: string;
  /** Local hour, 0–23. */
  hour: number;
  /** The offset exactly as written: `Z` or `+02:00`. */
  offset: string;
}

/** Sunday first, matching `busynessDaySchema.dayOfWeek` and `Date#getUTCDay`. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export const DAY_NAMES_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MONTH_NAMES_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** The parts of a local ISO instant, or `null` if it is not one. */
export function splitLocalIso(iso: string): LocalStamp | null {
  const match = ISO_LOCAL.exec(iso);
  if (!match) return null;
  const [, date, hh, mm, offset] = match as unknown as [string, string, string, string, string];
  return { date, time: `${hh}:${mm}`, hour: Number(hh), offset };
}

/** `07:00` — the clock face, for a time cell. `null` when the string is unreadable. */
export function clockOf(iso: string | null): string | null {
  return iso === null ? null : (splitLocalIso(iso)?.time ?? null);
}

/** Rebuild a local instant at a different date and hour, keeping the trail's offset. */
export function localIso(date: string, hour: number, offset: string): string {
  return `${date}T${String(hour).padStart(2, '0')}:00:00${offset}`;
}

/** Calendar arithmetic on the date part alone; DST cannot reach it. */
export function addDays(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS;
  return new Date(shifted).toISOString().slice(0, 10);
}

/** 0 = Sunday, matching the busyness week. */
export function dayOfWeekOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** `Sat 27 Jul`. Weekday first because that is how hikes get planned. */
export function formatDayLabel(date: string): string {
  const day = DAY_NAMES_SHORT[dayOfWeekOf(date)] ?? '';
  const month = MONTH_NAMES_SHORT[Number(date.slice(5, 7)) - 1] ?? '';
  return `${day} ${Number(date.slice(8, 10))} ${month}`;
}

/**
 * `27 Jul 2026`. Carries the year, which `formatDayLabel` deliberately leaves off.
 *
 * The planning rails only ever offer the next six days, so a year there would be noise. A
 * review's hiked-on date is the opposite case: it can be any date in the past, and "27 Jul"
 * on a report that turns out to be three winters old is worse than no date at all.
 */
export function formatDateLabel(date: string): string {
  const month = MONTH_NAMES_SHORT[Number(date.slice(5, 7)) - 1] ?? '';
  return `${Number(date.slice(8, 10))} ${month} ${date.slice(0, 4)}`;
}

/** `07:00`, from an hour. */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/**
 * Today's date where the reader is standing, as `YYYY-MM-DD`.
 *
 * Deliberately not `new Date().toISOString().slice(0, 10)`, which is today in UTC. At 21:00
 * in Seattle that string is already tomorrow, and a hike logged then would be rejected as
 * being in the future by a validator that is right to reject the future.
 */
export function todayLocal(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The next date on or after `from` that falls on `dayOfWeek`.
 *
 * This is what turns "quietest on Tuesday around 06:00" — a recommendation about a
 * weekday, because busyness is a weekly shape — into a date the forecast can be asked
 * about. Today counts: a Tuesday recommendation read on a Tuesday morning is about today.
 */
export function nextDateOn(from: string, dayOfWeek: number): string {
  const ahead = (dayOfWeek - dayOfWeekOf(from) + 7) % 7;
  return addDays(from, ahead);
}

/** `+02:00` → 120, `-08:00` → -480, `Z` → 0. `null` if it is not an offset. */
export function offsetMinutes(offset: string): number | null {
  if (offset === 'Z') return 0;
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(offset);
  if (!match) return null;
  const [, sign, hh, mm] = match as unknown as [string, string, string, string];
  const total = Number(hh) * 60 + Number(mm);
  return sign === '-' ? -total : total;
}

/**
 * What today's date is *at the trail*, from a UTC instant and the trail's offset.
 *
 * Needed for exactly one thing on each client — knowing which row of the busy-times grid
 * to mark as today — and worth doing properly, because the naive answer (the device's own
 * date) is wrong for every reader who is not standing on the trail, which is all of them
 * at the moment they are planning.
 */
export function localDateAt(utcIso: string, offset: string): string | null {
  const minutes = offsetMinutes(offset);
  const instant = new Date(utcIso).getTime();
  if (minutes === null || Number.isNaN(instant)) return null;
  return new Date(instant + minutes * 60_000).toISOString().slice(0, 10);
}
