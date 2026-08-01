/**
 * Wall-clock arithmetic on ISO strings that already carry their own offset.
 *
 * Every instant shown is local to the *trail*, not the device, and the API answers that way
 * (`2026-07-27T07:00:00+02:00`), so the client builds other start times by string surgery — swap
 * the date, swap the hour, keep the offset — and needs no timezone database: `Intl.DateTimeFormat`
 * with `timeZone` is not reliably available on Hermes.
 *
 * Known limit: a start built days ahead carries today's offset, so twice a year the far end of a
 * week lands an hour out. Shipping a zone database to fix that is not the trade.
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

/** `27 Jul 2026`. Carries the year, which `formatDayLabel` leaves off: the planning rails only
 * offer the next six days, but a review's hiked-on date can be three winters old. */
export function formatDateLabel(date: string): string {
  const month = MONTH_NAMES_SHORT[Number(date.slice(5, 7)) - 1] ?? '';
  return `${Number(date.slice(8, 10))} ${month} ${date.slice(0, 4)}`;
}

/** `07:00`, from an hour. */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`;
}

/** Today's date where the reader is standing. Not `toISOString().slice(0, 10)`, which at 21:00
 * in Seattle is already tomorrow and gets a hike logged then rejected as being in the future. */
export function todayLocal(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** The next date on or after `from` falling on `dayOfWeek` — what turns a busyness recommendation
 * about a weekday into a date the forecast can be asked about. Today counts. */
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

/** Today's date *at the trail*, from a UTC instant and the trail's offset. The device's own date
 * is wrong for every reader not standing on it, which is all of them while planning. */
export function localDateAt(utcIso: string, offset: string): string | null {
  const minutes = offsetMinutes(offset);
  const instant = new Date(utcIso).getTime();
  if (minutes === null || Number.isNaN(instant)) return null;
  return new Date(instant + minutes * 60_000).toISOString().slice(0, 10);
}
