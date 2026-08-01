import { z } from 'zod';
import { lngLatSchema } from './types';

/**
 * Lifeline — telling somebody where you went and when to worry.
 *
 * The token is the credential: 32 characters of randomness, the follow page is `noindex`, and
 * **position stops being served the moment the session is over** — `lifelineFollowSchema`
 * enforces that structurally. Overdue is computed on every read, not delivered, so the follow
 * page is right even if no sweep has run. `contactEmail`/`contactPhone` exist on the row but are
 * deliberately unwritten: there is no mail transport, and collecting an address we cannot send
 * to would promise the hiker that somebody gets told.
 */

export const LIFELINE_STATUSES = ['active', 'completed', 'overdue', 'cancelled'] as const;
export type LifelineStatus = (typeof LIFELINE_STATUSES)[number];

/** What the follower is told. `overdue` avoids "missing": a page that shouts the worst reading
 * of a twenty-minute overrun teaches its reader to ignore it. */
export const LIFELINE_STATUS_LABELS: Record<LifelineStatus, string> = {
  active: 'Out hiking',
  completed: 'Back safely',
  overdue: 'Overdue',
  cancelled: 'Called off',
};

export const LIFELINE_MESSAGE_MAX = 500;
export const LIFELINE_CONTACT_NAME_MAX = 80;

/** How long a Lifeline may run. The floor stops a mis-typed return time marking somebody overdue
 * in the car park; the ceiling is a privacy limit on how long a position is broadcast. */
export const MIN_LIFELINE_MINUTES = 15;
export const MAX_LIFELINE_MINUTES = 72 * 60;

/** Suggested return windows, in minutes. Short and skewed to half-days, which most hikes are. */
export const LIFELINE_PRESET_MINUTES = [120, 240, 360, 480, 720] as const;

/** After this long without a ping the follow page stops calling the position current. Twenty
 * minutes, not five: a phone in a valley loses signal constantly and comes back. */
export const LIFELINE_STALE_PING_S = 20 * 60;

/**
 * How often the device reports. A sixth of `LIFELINE_STALE_PING_S`, so five fixes must fail in a
 * row before the page stops calling the position current — keep that ratio. Deliberately slower
 * than the recorder's upload cadence: a ping wakes the radio, and a flat battery stops
 * every other part of this feature at once.
 */
export const LIFELINE_PING_INTERVAL_S = 180;

export const lifelineCreateSchema = z.object({
  /** The recording this rides on, when there is one. A Lifeline can run without it. */
  activityId: z.string().min(1).max(64).nullish(),
  trailId: z.string().min(1).max(64).nullish(),
  /** Whoever is being asked to notice. Free text — "Mum", "Dave", "the shop". */
  contactName: z.string().trim().min(1).max(LIFELINE_CONTACT_NAME_MAX).nullish(),
  /** Where you are going and anything the searcher would want. Shown on the follow page. */
  message: z.string().trim().max(LIFELINE_MESSAGE_MAX).nullish(),
  /** Minutes from now. A duration rather than a timestamp: no clocks, no time zones. */
  minutes: z.number().int().min(MIN_LIFELINE_MINUTES).max(MAX_LIFELINE_MINUTES),
});
export type LifelineCreate = z.infer<typeof lifelineCreateSchema>;

export const lifelinePingSchema = z.object({
  id: z.string().min(1).max(64),
  lng: z.number().min(-180).max(180),
  lat: z.number().min(-90).max(90),
  eleM: z.number().min(-500).max(9_500).nullish(),
  /** Whole percent. A follower's first question about a silent phone is whether it died. */
  batteryPct: z.number().int().min(0).max(100).nullish(),
});
export type LifelinePing = z.infer<typeof lifelinePingSchema>;

/** Pushing the return time back from the hill, which is the whole point of having a phone. */
export const lifelineExtendSchema = z.object({
  id: z.string().min(1).max(64),
  minutes: z.number().int().min(MIN_LIFELINE_MINUTES).max(MAX_LIFELINE_MINUTES),
});

const lifelineTrailSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  regionName: z.string().nullable(),
});

/** The hiker's own view, which is the only one that carries the token. */
export const lifelineSessionSchema = z.object({
  id: z.string(),
  token: z.string(),
  status: z.enum(LIFELINE_STATUSES),
  contactName: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.date(),
  expectedReturnAt: z.date(),
  endedAt: z.date().nullable(),
  lastPingAt: z.date().nullable(),
  activityId: z.string().nullable(),
  trail: lifelineTrailSchema.nullable(),
});
export type LifelineSession = z.infer<typeof lifelineSessionSchema>;

/** What the link shows — narrower than the hiker's view. `at` is null whenever the session is
 * not live, which makes the header's rule structural rather than a check a caller could forget. */
export const lifelineFollowSchema = z.object({
  status: z.enum(LIFELINE_STATUSES),
  hikerName: z.string(),
  contactName: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.date(),
  expectedReturnAt: z.date(),
  endedAt: z.date().nullable(),
  trail: lifelineTrailSchema.nullable(),
  /** Last known position — live sessions only. */
  at: lngLatSchema.nullable(),
  eleM: z.number().nullable(),
  lastPingAt: z.date().nullable(),
  batteryPct: z.number().int().nullable(),
  /** Seconds past the expected return, or 0. Computed on read so it is never stale. */
  overdueByS: z.number().int().nonnegative(),
  /** True when the last position is old enough that presenting it as current would mislead. */
  stale: z.boolean(),
});
export type LifelineFollow = z.infer<typeof lifelineFollowSchema>;

/** Seconds past the expected return, floored at zero. */
export function overdueByS(expectedReturnAt: Date, now: Date = new Date()): number {
  return Math.max(0, Math.floor((now.getTime() - expectedReturnAt.getTime()) / 1000));
}

/** Whether a session is still serving a position. Kept here so both ends agree on it. */
export function isLive(status: LifelineStatus): boolean {
  return status === 'active' || status === 'overdue';
}

/** Whether the last ping is old enough to stop calling the position current. */
export function isStalePing(lastPingAt: Date | null, now: Date = new Date()): boolean {
  if (!lastPingAt) return true;
  return now.getTime() - lastPingAt.getTime() > LIFELINE_STALE_PING_S * 1000;
}

/** "1 h 20 m late", "3 days out". Coarse on purpose: a figure that ticks every second turns a
 * status into a stopwatch. */
export function formatSpan(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return 'less than a minute';
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  const spareHours = hours % 24;
  return spareHours === 0
    ? `${days} ${days === 1 ? 'day' : 'days'}`
    : `${days} ${days === 1 ? 'day' : 'days'} ${spareHours} h`;
}
