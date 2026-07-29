import { z } from 'zod';
import { lngLatSchema } from './types';

/**
 * Lifeline — telling somebody where you went and when to worry.
 *
 * The premise is older than the product: you leave word at the pub, and if you are not back
 * by dark somebody comes looking. Everything here is that note, kept current by a phone.
 *
 * **The token is the credential, and that settles most of the design.** Whoever holds the
 * link sees a hiker's position, so the link is 32 characters of cryptographic randomness
 * rather than a row id, the follow page is `noindex`, and — the part products usually get
 * wrong — **position stops being served the moment the session is over.** Somebody who was
 * given the link so they could stop worrying on a Tuesday does not thereby acquire a
 * standing feed of where that person hikes. A completed Lifeline says *when* they got back
 * and nothing about where they are now.
 *
 * **Overdue is computed, not delivered.** The follow page derives lateness from
 * `expectedReturnAt` on every read, so it is right even if no sweep has run, no job queue is
 * draining, and nothing has been sent anywhere. The server-side sweep exists to persist the
 * status and to trigger an outward notification where one is possible; it is not what makes
 * the feature work. That ordering matters for something people might rely on in the dark.
 *
 * **We ask for a name, not an email address.** There is no mail transport in this product
 * yet, and collecting a contact's email while being unable to send to it would be a promise
 * we cannot keep — the hiker would believe somebody gets told. Instead the hiker sends the
 * link themselves, which is what nearly everybody does anyway. `contactEmail` and
 * `contactPhone` exist on the row for the day a transport lands and are deliberately left
 * unwritten until then.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export const LIFELINE_STATUSES = ['active', 'completed', 'overdue', 'cancelled'] as const;
export type LifelineStatus = (typeof LIFELINE_STATUSES)[number];

/**
 * What the follower is told, in the hiker's own terms.
 *
 * `overdue` avoids the word "missing". A hiker is late far more often than they are in
 * trouble — the descent took longer, the pub was open — and a page that shouts the worst
 * reading of a twenty-minute overrun teaches its reader to ignore it, which is precisely
 * the failure mode that gets somebody hurt.
 */
export const LIFELINE_STATUS_LABELS: Record<LifelineStatus, string> = {
  active: 'Out hiking',
  completed: 'Back safely',
  overdue: 'Overdue',
  cancelled: 'Called off',
};

export const LIFELINE_MESSAGE_MAX = 500;
export const LIFELINE_CONTACT_NAME_MAX = 80;

/**
 * How long a Lifeline may run.
 *
 * The floor stops a mis-typed return time from marking somebody overdue before they have
 * left the car park. The ceiling is a privacy limit rather than a technical one: a
 * three-day window is a long time to be broadcasting a position, and a multi-day trip is
 * better served by a fresh Lifeline each morning — which also means each day's contact is
 * told something, instead of one link going quiet for seventy hours.
 */
export const MIN_LIFELINE_MINUTES = 15;
export const MAX_LIFELINE_MINUTES = 72 * 60;

/**
 * Suggested return windows, in minutes.
 *
 * Offered as buttons because typing a datetime on a phone in a car park is the step where
 * people give up. The set is short on purpose and skewed to half-days, which is the length
 * of most hikes that anybody tells anybody about.
 */
export const LIFELINE_PRESET_MINUTES = [120, 240, 360, 480, 720] as const;

/**
 * After this long without a ping the follow page stops presenting the position as current.
 *
 * Twenty minutes rather than five: a phone in a pocket in a valley loses signal constantly
 * and comes back, and a page that cries "no signal" every few minutes is a page that gets
 * closed. Longer than the recorder's flush interval by a wide margin, so an ordinary upload
 * hiccup never trips it.
 */
export const LIFELINE_STALE_PING_S = 20 * 60;

/**
 * How often the hiker's device says where it is.
 *
 * Three minutes, which is a sixth of the staleness threshold above — so a fix has to fail
 * five times running before the follow page stops calling the position current. That ratio
 * is the point: a single dropped ping in a valley must never turn into a page telling
 * somebody's partner that contact has been lost.
 *
 * Deliberately slower than the recorder's own upload cadence. A ping is one row update
 * carrying four numbers, but it wakes the radio, and the radio is what empties a battery on
 * a long day out — which is the one failure mode that makes every other part of this feature
 * stop working at once.
 */
export const LIFELINE_PING_INTERVAL_S = 180;

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

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

/**
 * What the link shows.
 *
 * Deliberately narrower than the hiker's view. No account id, no activity id, no route
 * history — a follower gets a name, a plan, a clock, and one dot. `at` is null whenever the
 * session is not live, which is what enforces the rule at the top of this file: the shape
 * itself cannot carry a position for a hike that is over.
 */
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

// ---------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------

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

/**
 * "1 h 20 m late", "3 days out" — a duration written the way somebody says it aloud.
 *
 * Coarse on purpose. A follower reading "overdue by 1 h 20 m" is deciding whether to make a
 * phone call; the seconds are noise, and a figure that ticks every second turns a status
 * into a stopwatch pointed at somebody they are worried about.
 */
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
